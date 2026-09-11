/* paperbox 控制台前端逻辑：无依赖、无构建，全部走同源的 /api/ui/* 。 */
(function () {
  "use strict";

  var HEALTH_INTERVAL_MS = 15000;
  var JOB_POLL_MS = 2000;
  var JOBS_AUTO_MS = 5000;
  var LIBRARY_PAGE_SIZE = 20;

  var STAGES = [
    "RECEIVED",
    "DOWNLOADING",
    "STORED",
    "PARSING",
    "CHUNKING",
    "EMBEDDING",
    "INDEXING",
    "COMPLETED"
  ];
  var STAGE_LABELS = {
    RECEIVED: "已接收",
    DOWNLOADING: "下载中",
    STORED: "已存储",
    PARSING: "解析中",
    CHUNKING: "切块中",
    EMBEDDING: "向量化中",
    INDEXING: "建立索引中",
    COMPLETED: "已完成",
    FAILED: "失败"
  };

  var state = {
    library: { offset: 0, total: 0, loading: false },
    jobsAutoTimer: null,
    jobPollTimer: null,
    currentJobId: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function text(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback || "—";
    return String(value);
  }

  function fmtScore(value) {
    if (typeof value !== "number") return "—";
    return value.toFixed(3);
  }

  function fmtProgress(value) {
    if (typeof value !== "number") return "—";
    return value.toFixed(1) + "%";
  }

  function fmtTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function fmtSize(bytes) {
    if (typeof bytes !== "number") return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function stageLabel(stage) {
    if (!stage) return "—";
    return STAGE_LABELS[stage] || stage;
  }

  function stageIndex(stage) {
    var index = STAGES.indexOf(stage);
    return index < 0 ? 0 : index;
  }

  function toast(message, kind) {
    var stack = $("toast-stack");
    var node = el("div", "toast toast-" + (kind || "info"), message);
    stack.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 5000);
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, opts).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (payload) {
          if (!response.ok) {
            var detail = payload && payload.detail ? JSON.stringify(payload.detail) : "";
            var error = new Error(
              "HTTP " + response.status + (detail ? "：" + detail : "")
            );
            error.status = response.status;
            error.payload = payload;
            throw error;
          }
          return payload;
        });
    });
  }

  /* ---------------- 顶部状态条 ---------------- */

  function applyServiceChip(chip, value) {
    var ok = value === "ok";
    chip.className = "chip " + (ok ? "chip-ok" : "chip-error");
    chip.textContent = chip.getAttribute("data-service") + " · " + (ok ? "ok" : text(value, "error"));
  }

  function loadHealth() {
    return api("/api/ui/health")
      .then(function (data) {
        var services = data.paperbox || {};
        var chips = document.querySelectorAll("#health-chips .chip[data-service]");
        for (var i = 0; i < chips.length; i++) {
          var chip = chips[i];
          var key = chip.getAttribute("data-service");
          if (key === "error") {
            chip.className = "chip chip-error";
            chip.textContent = "paperbox · " + text(services.error, "error");
            continue;
          }
          applyServiceChip(chip, key in services ? services[key] : undefined);
        }
        var papers = $("chip-papers");
        var jobs = $("chip-jobs");
        papers.textContent = "论文 · " + text(data.papers, "—");
        jobs.textContent = "任务 · " + text(data.jobs, "—");
        papers.className = "chip chip-info";
        jobs.className = "chip chip-info";
        $("health-version").textContent = "版本 " + text(data.version, "unknown");
        $("health-time").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      })
      .catch(function (error) {
        var chips = document.querySelectorAll("#health-chips .chip[data-service]");
        for (var i = 0; i < chips.length; i++) {
          chips[i].className = "chip chip-error";
          chips[i].textContent = chips[i].getAttribute("data-service") + " · ?";
        }
        $("health-version").textContent = "健康检查失败：" + error.message;
      });
  }

  /* ---------------- Tab 切换 ---------------- */

  function activateTab(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var current = tabs[i].getAttribute("data-tab") === name;
      tabs[i].classList.toggle("is-active", current);
      tabs[i].setAttribute("aria-selected", current ? "true" : "false");
    }
    var panels = document.querySelectorAll(".panel");
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle("is-active", panels[j].id === "panel-" + name);
    }
    if (name === "library") loadLibrary();
    if (name === "jobs") loadJobs();
  }

  /* ---------------- Tab 1：检索 ---------------- */

  function splitList(value) {
    if (!value) return [];
    return value
      .split(/[,，]/)
      .map(function (item) {
        return item.trim();
      })
      .filter(function (item) {
        return item.length > 0;
      });
  }

  function buildSearchBody() {
    var filters = {
      year_from: $("filter-year-from").value ? Number($("filter-year-from").value) : null,
      year_to: $("filter-year-to").value ? Number($("filter-year-to").value) : null,
      authors: splitList($("filter-authors").value),
      venue: $("filter-venue").value.trim() || null,
      doi: $("filter-doi").value.trim() || null,
      arxiv_id: $("filter-arxiv").value.trim() || null,
      tag: $("filter-tag").value.trim() || null
    };
    return {
      query: $("search-query").value.trim(),
      mode: $("search-mode").value,
      top_k: Number($("search-topk").value) || 10,
      filters: filters
    };
  }

  function relevanceBadge(relevance) {
    var value = (relevance || "").toLowerCase();
    var known = value === "high" || value === "medium" || value === "low";
    var badge = el("span", "badge badge-" + (known ? value : "unknown"), value || "unknown");
    badge.title = "相关度";
    return badge;
  }

  function renderEvidence(evidence) {
    var details = el("details", "evidence");
    details.appendChild(el("summary", null, "证据（" + evidence.length + "）"));
    var list = el("ul", "evidence-list");
    evidence.forEach(function (item) {
      var li = el("li", "evidence-item");
      var meta = el("div", "evidence-meta");
      meta.appendChild(el("span", "tag", "第 " + text(item.page, "?") + " 页"));
      meta.appendChild(el("span", "tag", text(item.section, "未知章节")));
      li.appendChild(meta);
      li.appendChild(el("p", "evidence-text", text(item.text, "")));
      list.appendChild(li);
    });
    details.appendChild(list);
    return details;
  }

  function renderSearchCard(result) {
    var card = el("article", "card result-card");

    var head = el("div", "result-head-line");
    var title = el("button", "link-title", text(result.title, "（无标题）"));
    title.type = "button";
    title.addEventListener("click", function () {
      openDetail(result.paper_id);
    });
    head.appendChild(title);
    card.appendChild(head);

    var meta = el("div", "result-meta");
    var authors = Array.isArray(result.authors) ? result.authors : [];
    meta.appendChild(el("span", null, authors.length ? authors.join("，") : "作者未知"));
    meta.appendChild(el("span", null, "年份 " + text(result.year, "未知")));
    card.appendChild(meta);

    var badges = el("div", "badges");
    badges.appendChild(el("span", "badge badge-score", "score " + fmtScore(result.score)));
    badges.appendChild(relevanceBadge(result.relevance));
    card.appendChild(badges);

    var evidence = Array.isArray(result.evidence) ? result.evidence : [];
    if (evidence.length) card.appendChild(renderEvidence(evidence));

    return card;
  }

  function runSearch(event) {
    if (event) event.preventDefault();
    var body = buildSearchBody();
    var results = $("search-results");
    var empty = $("search-empty");
    var summary = $("search-summary");

    if (!body.query) {
      toast("请输入查询内容", "warn");
      return;
    }

    clear(results);
    empty.hidden = false;
    empty.textContent = "检索中…";
    summary.hidden = true;

    api("/api/ui/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (data) {
        var items = Array.isArray(data.results) ? data.results : [];
        clear(results);
        empty.hidden = items.length > 0;
        empty.textContent = "没有命中结果。";
        summary.hidden = false;
        clear(summary);
        summary.appendChild(
          el(
            "span",
            null,
            "模式 " +
              text(data.mode, body.mode) +
              " · 命中 " +
              text(data.total, items.length) +
              " 篇 · 耗时 " +
              (typeof data.took_ms === "number" ? data.took_ms.toFixed(1) : "—") +
              " ms"
          )
        );
        items.forEach(function (item) {
          results.appendChild(renderSearchCard(item));
        });
      })
      .catch(function (error) {
        clear(results);
        empty.hidden = false;
        empty.textContent = "检索失败：" + error.message;
      });
  }

  /* ---------------- Tab 2：论文库 ---------------- */

  function statusChip(status) {
    var value = (status || "").toUpperCase();
    var cls = "chip chip-info";
    if (value === "INDEXED" || value === "COMPLETED") cls = "chip chip-ok";
    else if (value === "FAILED") cls = "chip chip-error";
    else if (value) cls = "chip chip-pending";
    return el("span", cls.replace("chip ", ""), text(status, "未知"));
  }

  function libraryActions(paper) {
    var wrap = el("div", "row-actions");
    var id = paper.paper_id;

    var detail = el("button", "btn btn-ghost btn-sm", "详情");
    detail.type = "button";
    detail.addEventListener("click", function () {
      openDetail(id);
    });
    wrap.appendChild(detail);

    var download = el("a", "btn btn-ghost btn-sm", "下载原文");
    download.href = "/api/ui/papers/" + encodeURIComponent(id) + "/file";
    download.setAttribute("download", "");
    wrap.appendChild(download);

    var reindex = el("button", "btn btn-ghost btn-sm", "重建索引");
    reindex.type = "button";
    reindex.addEventListener("click", function () {
      reindexPaper(id, reindex);
    });
    wrap.appendChild(reindex);

    var remove = el("button", "btn btn-danger btn-sm", "删除");
    remove.type = "button";
    remove.addEventListener("click", function () {
      removePaper(id, text(paper.title, "该论文"), function () {
        loadLibrary();
      });
    });
    wrap.appendChild(remove);

    return wrap;
  }

  function renderLibraryRow(paper) {
    var tr = el("tr");
    var titleCell = el("td", "cell-title");
    var link = el("button", "link-title", text(paper.title, "（无标题）"));
    link.type = "button";
    link.addEventListener("click", function () {
      openDetail(paper.paper_id);
    });
    titleCell.appendChild(link);
    tr.appendChild(titleCell);

    tr.appendChild(el("td", null, text(paper.year, "—")));
    var statusCell = el("td");
    statusCell.appendChild(statusChip(paper.status));
    tr.appendChild(statusCell);
    tr.appendChild(
      el("td", null, Array.isArray(paper.authors) ? String(paper.authors.length) : "0")
    );
    tr.appendChild(el("td", null, fmtTime(paper.created_at)));
    var actionCell = el("td");
    actionCell.appendChild(libraryActions(paper));
    tr.appendChild(actionCell);
    return tr;
  }

  function loadLibrary() {
    if (state.library.loading) return Promise.resolve();
    state.library.loading = true;
    var body = $("library-body");
    var empty = $("library-empty");

    var params = new URLSearchParams();
    params.set("limit", String(LIBRARY_PAGE_SIZE));
    params.set("offset", String(state.library.offset));
    var status = $("library-status").value;
    var query = $("library-q").value.trim();
    if (status) params.set("status", status);
    if (query) params.set("q", query);

    return api("/api/ui/papers?" + params.toString())
      .then(function (data) {
        var papers = Array.isArray(data.papers) ? data.papers : [];
        state.library.total = typeof data.total === "number" ? data.total : papers.length;
        clear(body);
        papers.forEach(function (paper) {
          body.appendChild(renderLibraryRow(paper));
        });
        empty.hidden = papers.length > 0;
        var page = Math.floor(state.library.offset / LIBRARY_PAGE_SIZE) + 1;
        var pages = Math.max(1, Math.ceil(state.library.total / LIBRARY_PAGE_SIZE));
        $("library-page-info").textContent =
          "第 " + page + " / " + pages + " 页 · 共 " + state.library.total + " 篇";
        $("library-prev").disabled = state.library.offset <= 0;
        $("library-next").disabled = state.library.offset + LIBRARY_PAGE_SIZE >= state.library.total;
      })
      .catch(function (error) {
        clear(body);
        empty.hidden = false;
        empty.textContent = "加载失败：" + error.message;
      })
      .then(function () {
        state.library.loading = false;
      });
  }

  /* ---------------- 论文详情面板 ---------------- */

  var detailState = { paperId: null, offset: 0, total: 0, limit: 20 };

  function openDetail(paperId) {
    if (!paperId) return;
    state.currentPaperId = paperId;
    detailState.paperId = paperId;
    detailState.offset = 0;
    $("detail-mask").hidden = false;
    $("detail-drawer").hidden = false;
    $("detail-title").textContent = "论文详情";
    var bodyNode = $("detail-body");
    clear(bodyNode);
    bodyNode.appendChild(el("p", "empty", "加载中…"));
    loadDetail();
  }

  function closeDetail() {
    $("detail-mask").hidden = true;
    $("detail-drawer").hidden = true;
    detailState.paperId = null;
  }

  function definitionRow(label, value) {
    var dt = el("dt", null, label);
    var dd = el("dd", null, value);
    return [dt, dd];
  }

  function loadDetail() {
    var paperId = detailState.paperId;
    if (!paperId) return;
    var bodyNode = $("detail-body");

    Promise.all([
      api("/api/ui/papers/" + encodeURIComponent(paperId)),
      api(
        "/api/ui/papers/" +
          encodeURIComponent(paperId) +
          "/chunks?limit=" +
          detailState.limit +
          "&offset=" +
          detailState.offset
      )
    ])
      .then(function (results) {
        renderDetail(results[0], results[1]);
      })
      .catch(function (error) {
        clear(bodyNode);
        bodyNode.appendChild(el("p", "empty", "加载详情失败：" + error.message));
      });
  }

  function renderDetail(paper, chunkPayload) {
    var bodyNode = $("detail-body");
    clear(bodyNode);
    $("detail-title").textContent = text(paper.title, "论文详情");

    var facts = el("dl", "facts");
    var authors = Array.isArray(paper.authors) ? paper.authors : [];
    [
      definitionRow("年份", text(paper.year, "—")),
      definitionRow("作者", authors.length ? authors.join("，") : "—"),
      definitionRow("DOI", text(paper.doi, "—")),
      definitionRow("arXiv", text(paper.arxiv_id, "—")),
      definitionRow("状态", text(paper.status, "—")),
      definitionRow("指纹", text(paper.fingerprint, "—")),
      definitionRow("创建时间", fmtTime(paper.created_at)),
      definitionRow("更新时间", fmtTime(paper.updated_at))
    ].forEach(function (pair) {
      facts.appendChild(pair[0]);
      facts.appendChild(pair[1]);
    });
    bodyNode.appendChild(facts);

    var files = Array.isArray(paper.files) ? paper.files : [];
    var fileSection = el("section", "detail-section");
    fileSection.appendChild(el("h3", null, "文件（" + files.length + "）"));
    if (files.length) {
      var fileList = el("ul", "file-list");
      files.forEach(function (file) {
        var li = el(
          "li",
          null,
          text(file.storage_key, "文件") +
            " · " +
            fmtSize(file.size_bytes) +
            " · " +
            text(file.mime_type, "—")
        );
        fileList.appendChild(li);
      });
      fileSection.appendChild(fileList);
    } else {
      fileSection.appendChild(el("p", "muted", "没有文件记录。"));
    }
    bodyNode.appendChild(fileSection);

    var actions = el("div", "row-actions detail-actions");
    var download = el("a", "btn btn-ghost btn-sm", "下载原文");
    download.href = "/api/ui/papers/" + encodeURIComponent(paper.paper_id) + "/file";
    download.setAttribute("download", "");
    actions.appendChild(download);

    var reindex = el("button", "btn btn-ghost btn-sm", "重建索引");
    reindex.type = "button";
    reindex.addEventListener("click", function () {
      reindexPaper(paper.paper_id, reindex);
    });
    actions.appendChild(reindex);

    var remove = el("button", "btn btn-danger btn-sm", "删除");
    remove.type = "button";
    remove.addEventListener("click", function () {
      removePaper(paper.paper_id, text(paper.title, "该论文"), function () {
        closeDetail();
        loadLibrary();
      });
    });
    actions.appendChild(remove);
    bodyNode.appendChild(actions);

    renderChunks(chunkPayload);
  }

  function renderChunks(payload) {
    var bodyNode = $("detail-body");
    var section = el("section", "detail-section");
    var chunks = payload && Array.isArray(payload.chunks) ? payload.chunks : [];
    var total = payload && typeof payload.total === "number" ? payload.total : chunks.length;
    section.appendChild(el("h3", null, "文本块（共 " + total + "）"));

    if (!chunks.length) {
      section.appendChild(el("p", "muted", "没有文本块。"));
      bodyNode.appendChild(section);
      return;
    }

    chunks.forEach(function (chunk) {
      var item = el("article", "chunk");
      var head = el("div", "chunk-head");
      head.appendChild(el("span", "tag", "#" + text(chunk.chunk_index, "?")));
      head.appendChild(
        el(
          "span",
          "tag",
          "第 " + text(chunk.page_start, "?") + "-" + text(chunk.page_end, "?") + " 页"
        )
      );
      head.appendChild(el("span", "tag", text(chunk.section, "未知章节")));
      head.appendChild(el("span", "muted", text(chunk.token_count, "?") + " tokens"));
      item.appendChild(head);

      var preview = el("p", "chunk-text is-clamped", text(chunk.text, ""));
      item.appendChild(preview);

      var toggle = el("button", "btn btn-ghost btn-sm", "展开全文");
      toggle.type = "button";
      toggle.addEventListener("click", function () {
        var clamped = preview.classList.toggle("is-clamped");
        toggle.textContent = clamped ? "展开全文" : "收起全文";
      });
      item.appendChild(toggle);
      section.appendChild(item);
    });

    var pager = el("div", "pager");
    var prev = el("button", "btn btn-ghost btn-sm", "上一页");
    prev.type = "button";
    prev.disabled = detailState.offset <= 0;
    prev.addEventListener("click", function () {
      detailState.offset = Math.max(0, detailState.offset - detailState.limit);
      loadDetail();
    });
    var next = el("button", "btn btn-ghost btn-sm", "下一页");
    next.type = "button";
    next.disabled = detailState.offset + detailState.limit >= total;
    next.addEventListener("click", function () {
      detailState.offset += detailState.limit;
      loadDetail();
    });
    var page = Math.floor(detailState.offset / detailState.limit) + 1;
    var pages = Math.max(1, Math.ceil(total / detailState.limit));
    pager.appendChild(prev);
    pager.appendChild(el("span", null, "第 " + page + " / " + pages + " 页"));
    pager.appendChild(next);
    section.appendChild(pager);

    bodyNode.appendChild(section);
  }

  /* ---------------- 变更操作：重建索引 / 删除 ---------------- */

  function reindexPaper(paperId, button) {
    if (button) button.disabled = true;
    api("/api/ui/papers/" + encodeURIComponent(paperId) + "/reindex", { method: "POST" })
      .then(function (data) {
        var jobId = data && data.job_id ? data.job_id : null;
        toast("已提交重建索引任务" + (jobId ? "：" + jobId : ""), "ok");
        if (jobId) {
          activateTab("jobs");
          loadJobs();
        }
      })
      .catch(function (error) {
        toast("重建索引失败：" + error.message, "error");
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  function removePaper(paperId, label, onDone) {
    if (!window.confirm("确定删除《" + label + "》？该操作不可撤销。")) return;
    api("/api/ui/papers/" + encodeURIComponent(paperId), { method: "DELETE" })
      .then(function () {
        toast("已删除：" + label, "ok");
        if (typeof onDone === "function") onDone();
      })
      .catch(function (error) {
        toast("删除失败：" + error.message, "error");
      });
  }

  /* ---------------- Tab 3：导入 ---------------- */

  function showProgress(jobId) {
    state.currentJobId = jobId;
    $("ingest-progress-card").hidden = false;
    $("ingest-job-id").textContent = jobId || "-";
    $("ingest-error").hidden = true;
    $("ingest-paper-link").hidden = true;
    $("ingest-duplicate").hidden = true;
    setProgress(0, "等待中…");
  }

  function setProgress(percent, label) {
    var value = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
    $("ingest-progress-fill").style.width = value + "%";
    $("ingest-progress-pct").textContent = value.toFixed(0) + "%";
    if (label) $("ingest-stage-label").textContent = label;
  }

  function pollJob(jobId) {
    if (state.jobPollTimer) window.clearTimeout(state.jobPollTimer);
    api("/api/ui/jobs/" + encodeURIComponent(jobId))
      .then(function (job) {
        var progress = typeof job.progress === "number" ? job.progress : 0;
        var label = stageLabel(job.stage);
        if (job.stage && job.stage !== "FAILED" && job.stage !== "COMPLETED") {
          label = label + "（" + (stageIndex(job.stage) + 1) + "/" + STAGES.length + "）";
        }
        setProgress(progress, label);

        if (job.duplicate) $("ingest-duplicate").hidden = false;

        if (job.stage === "FAILED") {
          var errorNode = $("ingest-error");
          errorNode.hidden = false;
          errorNode.textContent = "失败原因：" + text(job.error_message, "未知错误");
          linkPaper(job.paper_id, job);
          return;
        }
        if (job.stage === "COMPLETED") {
          linkPaper(job.paper_id, job);
          toast("导入完成：" + text(job.paper_id, jobId), "ok");
          return;
        }
        state.jobPollTimer = window.setTimeout(function () {
          pollJob(jobId);
        }, JOB_POLL_MS);
      })
      .catch(function (error) {
        var errorNode = $("ingest-error");
        errorNode.hidden = false;
        errorNode.textContent = "查询任务失败：" + error.message;
        state.jobPollTimer = window.setTimeout(function () {
          pollJob(jobId);
        }, JOB_POLL_MS);
      });
  }

  function linkPaper(paperId, job) {
    if (!paperId) return;
    var node = $("ingest-paper-link");
    node.hidden = false;
    clear(node);
    node.appendChild(document.createTextNode("论文："));
    var link = el("button", "link-title", (job && job.duplicate ? "（重复论文）" : "") + paperId);
    link.type = "button";
    link.addEventListener("click", function () {
      openDetail(paperId);
    });
    node.appendChild(link);
  }

  function submitIngestUrl(event) {
    event.preventDefault();
    var url = $("ingest-url").value.trim();
    if (!url) {
      toast("请输入 PDF 链接", "warn");
      return;
    }
    api("/api/ui/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "url", source: url })
    })
      .then(function (data) {
        var jobId = data && data.job_id ? data.job_id : null;
        if (!jobId) {
          toast("后端未返回 job_id", "warn");
          return;
        }
        showProgress(jobId);
        pollJob(jobId);
      })
      .catch(function (error) {
        toast("提交失败：" + error.message, "error");
      });
  }

  function submitIngestFile(event) {
    event.preventDefault();
    var input = $("ingest-file");
    if (!input.files || !input.files.length) {
      toast("请选择 PDF 文件", "warn");
      return;
    }
    var form = new FormData();
    form.append("file", input.files[0]);
    api("/api/ui/ingest/file", { method: "POST", body: form })
      .then(function (data) {
        var jobId = data && data.job_id ? data.job_id : null;
        if (!jobId) {
          toast("后端未返回 job_id", "warn");
          return;
        }
        showProgress(jobId);
        pollJob(jobId);
      })
      .catch(function (error) {
        toast("上传失败：" + error.message, "error");
      });
  }

  /* ---------------- Tab 4：任务 ---------------- */

  function renderJobRow(job) {
    var tr = el("tr");
    var idCell = el("td", "cell-id");
    idCell.appendChild(el("code", null, text(job.job_id, "—")));
    tr.appendChild(idCell);

    var stageCell = el("td");
    var label = stageLabel(job.stage);
    var cls = "chip chip-info";
    if (job.stage === "COMPLETED") cls = "chip chip-ok";
    else if (job.stage === "FAILED") cls = "chip chip-error";
    else if (job.stage) cls = "chip chip-pending";
    stageCell.appendChild(el("span", cls.replace("chip ", ""), label));
    tr.appendChild(stageCell);

    tr.appendChild(el("td", null, fmtProgress(job.progress)));
    tr.appendChild(el("td", null, job.duplicate ? "是" : "否"));
    tr.appendChild(el("td", "cell-error", text(job.error_message, "—")));
    tr.appendChild(el("td", null, fmtTime(job.created_at)));
    tr.appendChild(el("td", null, fmtTime(job.updated_at)));
    return tr;
  }

  function loadJobs() {
    var limit = Number($("jobs-limit").value) || 20;
    var body = $("jobs-body");
    var empty = $("jobs-empty");
    return api("/api/ui/jobs?limit=" + encodeURIComponent(limit))
      .then(function (data) {
        var jobs = Array.isArray(data.jobs) ? data.jobs : [];
        clear(body);
        jobs.forEach(function (job) {
          body.appendChild(renderJobRow(job));
        });
        empty.hidden = jobs.length > 0;
      })
      .catch(function (error) {
        clear(body);
        empty.hidden = false;
        empty.textContent = "加载任务失败：" + error.message;
      });
  }

  function toggleJobsAuto() {
    if (state.jobsAutoTimer) {
      window.clearInterval(state.jobsAutoTimer);
      state.jobsAutoTimer = null;
    }
    if ($("jobs-auto").checked) {
      state.jobsAutoTimer = window.setInterval(function () {
        loadJobs();
      }, JOBS_AUTO_MS);
    }
  }

  /* ---------------- 绑定 ---------------- */

  function bind() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (event) {
        activateTab(event.currentTarget.getAttribute("data-tab"));
      });
    }

    $("search-form").addEventListener("submit", runSearch);
    $("search-form").addEventListener("reset", function () {
      window.setTimeout(function () {
        clear($("search-results"));
        $("search-summary").hidden = true;
        $("search-empty").hidden = false;
        $("search-empty").textContent = "输入关键词后点击「检索」。";
      }, 0);
    });

    $("library-form").addEventListener("submit", function (event) {
      event.preventDefault();
      state.library.offset = 0;
      loadLibrary();
    });
    $("btn-library-refresh").addEventListener("click", function () {
      loadLibrary();
    });
    $("library-prev").addEventListener("click", function () {
      state.library.offset = Math.max(0, state.library.offset - LIBRARY_PAGE_SIZE);
      loadLibrary();
    });
    $("library-next").addEventListener("click", function () {
      state.library.offset += LIBRARY_PAGE_SIZE;
      loadLibrary();
    });

    $("ingest-url-form").addEventListener("submit", submitIngestUrl);
    $("ingest-file-form").addEventListener("submit", submitIngestFile);

    $("jobs-form").addEventListener("submit", function (event) {
      event.preventDefault();
      loadJobs();
    });
    $("jobs-auto").addEventListener("change", toggleJobsAuto);

    $("btn-refresh-health").addEventListener("click", function () {
      loadHealth();
    });

    $("detail-close").addEventListener("click", closeDetail);
    $("detail-mask").addEventListener("click", closeDetail);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !$("detail-drawer").hidden) closeDetail();
    });

    $("search-query").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(event);
      }
    });
  }

  function init() {
    bind();
    loadHealth();
    window.setInterval(loadHealth, HEALTH_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();