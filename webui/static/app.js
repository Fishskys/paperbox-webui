/* paperbox 控制台前端逻辑：无依赖、无构建，全部走同源的 /api/ui/* 。 */
(function () {
  "use strict";

  /* 队列的纯逻辑在 queue-logic.js（index.html 里先于本文件加载），
   * 并发 / 退避 / 两阶段计数的规则在那里，并被 node:test 真测。 */
  var QL = window.PaperboxQueue;

  var HEALTH_INTERVAL_MS = 15000;
  var JOB_POLL_MS = 2000;
  var JOBS_AUTO_MS = 5000;
  var LIBRARY_PAGE_SIZE = 20;

  var STAGES = [
    "RECEIVED",
    "QUEUED",
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
    QUEUED: "排队中",
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
    config: null,
    serverQueued: null,     // paperbox 侧的排队深度（/api/ui/jobs/queue 的 queued）
    queue: {
      items: [],
      seq: 0,
      running: false,
      halt: false,
      inflight: [],      // 在途上传请求（并发池），最多 queueConcurrency() 个
      wakeTimer: null,   // 退避到点后补位的定时器
      ticker: null,      // 退避倒计时的刷新定时器
      backlogTimer: null // 服务端排队深度的轮询定时器
    }
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

  /* ---------------- Tab 3：导入（上传队列） ---------------- */

  var QUEUE_POLL_MS = 2000;      // 队列内单个任务的轮询间隔
  var QUEUE_MAX_RETRY = 15;      // 轮询连续失败上限（后端重启/网络抖动时重试，超过判定失败）
  var QUEUE_TICK_MS = 500;       // 退避倒计时的刷新间隔

  /* 上传调参由后端下发（GET /api/ui/config）；拿不到就用这份内置默认——
   * 配置接口失败绝不能变成"不能上传"（决策 #2）。 */
  var DEFAULT_CONFIG = {
    upload_concurrency: 2,       // 与 paperbox 的 INGEST_UPLOAD_CONCURRENCY 对齐
    upload_max_attempts: 6,      // 429 重试上限
    retry_base_ms: 2000,
    retry_cap_ms: 60000,
    file_max_mb: 100,
    batch_hint_threshold: 20
  };

  function queueConfig() {
    var config = state.config || {};
    var merged = {};
    for (var key in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
        merged[key] = typeof config[key] === "number" ? config[key] : DEFAULT_CONFIG[key];
      }
    }
    return merged;
  }

  function queueConcurrency() {
    return Math.max(1, Math.floor(queueConfig().upload_concurrency));
  }

  function loadConfig() {
    return api("/api/ui/config")
      .then(function (data) {
        state.config = data && typeof data === "object" ? data : null;
      })
      .catch(function () {
        state.config = null;      // 静默退回内置默认
      });
  }

  var QUEUE_CHIP = {
    pending: ["chip-pending", "待上传"],
    uploading: ["chip-info", "上传中"],
    submitted: ["chip-info", "已提交"],
    processing: ["chip-pending", "解析中"],
    done: ["chip-ok", "已完成"],
    duplicate: ["chip-info", "重复论文"],
    failed: ["chip-error", "失败"],
    canceled: ["chip-info", "已取消"]
  };

  function queueIsActive(item) {
    return item.status === "uploading" || item.status === "submitted" || item.status === "processing";
  }

  function queueIsPending(item) {
    return item.status === "pending";
  }

  function queueIsFinished(item) {
    return item.status === "done" || item.status === "duplicate" ||
      item.status === "failed" || item.status === "canceled";
  }

  function newQueueItem(kind, name, size, extra) {
    var item = {
      id: "q" + (++state.queue.seq),
      kind: kind,                 // "file" | "url"
      name: name,
      size: typeof size === "number" ? size : null,
      status: "pending",          // pending | uploading | submitted | processing | done | duplicate | failed | canceled
      percent: 0,
      label: "待上传",
      jobId: null,
      paperId: null,
      error: null,
      file: null,
      url: null,
      xhr: null,
      timer: null,
      retries: 0,       // 轮询连续失败次数
      attempts: 0,      // 429 重试次数
      retryAt: null,    // 退避到点的时间戳（Date.now() 基准）
      jobDone: false,   // 作业是否已到终态（COMPLETED / FAILED）
      node: null
    };
    var extraKeys = extra || {};
    for (var key in extraKeys) {
      if (Object.prototype.hasOwnProperty.call(extraKeys, key)) item[key] = extraKeys[key];
    }
    return item;
  }

  function queueFind(id) {
    for (var i = 0; i < state.queue.items.length; i++) {
      if (state.queue.items[i].id === id) return state.queue.items[i];
    }
    return null;
  }

  /* 两阶段摘要（决策 #5）：`共 N 项 · 上传 x/y · 处理 a/b · 失败 f [· 服务端排队 q]`。
   * 计数规则在 queue-logic.js 的 summarizeProgress()，由 node:test 覆盖。 */
  function queueSummaryText() {
    var items = state.queue.items;
    if (!items.length) return "（空）";
    var summary = QL.summarizeProgress(items);
    var parts = ["共 " + summary.total + " 项"];
    if (summary.toUpload) parts.push("上传 " + summary.uploaded + "/" + summary.toUpload);
    if (summary.submitted) parts.push("处理 " + summary.terminal + "/" + summary.submitted);
    if (summary.failed) parts.push("失败 " + summary.failed);
    if (state.serverQueued) parts.push("服务端排队 " + state.serverQueued);
    return "（" + parts.join(" · ") + "）";
  }

  function queuePaintSummary() {
    var summaryNode = $("queue-summary");
    if (summaryNode) summaryNode.textContent = queueSummaryText();
  }

  /* 退避中的项要能看出"在等"：每 QUEUE_TICK_MS 重画一次倒计时，没人退避就停表。 */
  function queueEnsureTicker() {
    var waiting = state.queue.items.some(function (item) {
      return item.status === "pending" && item.retryAt;
    });
    if (waiting && !state.queue.ticker) {
      state.queue.ticker = window.setInterval(function () {
        state.queue.items.forEach(function (item) {
          if (item.status === "pending" && item.retryAt) paintQueueItem(item);
        });
        queueEnsureTicker();
      }, QUEUE_TICK_MS);
    } else if (!waiting && state.queue.ticker) {
      window.clearInterval(state.queue.ticker);
      state.queue.ticker = null;
    }
  }

  var QUEUE_BACKLOG_MS = 2000;   // 服务端排队深度：与作业轮询同频

  function queueHasLiveJobs() {
    return state.queue.items.some(function (item) {
      return item.jobId && !item.jobDone;
    });
  }

  /* 只在有在途作业时轮询 /api/ui/jobs/queue，用来解释"为什么我的作业还没开始"。 */
  function loadServerQueue() {
    if (!queueHasLiveJobs()) {
      if (state.serverQueued !== null) {
        state.serverQueued = null;
        queuePaintSummary();
      }
      return;
    }
    api("/api/ui/jobs/queue")
      .then(function (data) {
        state.serverQueued = data && typeof data.queued === "number" ? data.queued : null;
        queuePaintSummary();
      })
      .catch(function () {
        state.serverQueued = null;   // paperbox 不可达时静默忽略
      });
  }

  function queueSyncBacklog() {
    var live = queueHasLiveJobs();
    if (live && !state.queue.backlogTimer) {
      state.queue.backlogTimer = window.setInterval(loadServerQueue, QUEUE_BACKLOG_MS);
      loadServerQueue();
    } else if (!live && state.queue.backlogTimer) {
      window.clearInterval(state.queue.backlogTimer);
      state.queue.backlogTimer = null;
      state.serverQueued = null;
    }
  }

  /* 队列很长时提示走服务端目录导入（决策 #6：不自动改成多文件请求）。 */
  function queueSyncHint() {
    var hint = $("queue-hint");
    if (!hint) return;
    var suggest = QL.shouldSuggestServerSide(
      state.queue.items.length,
      queueConfig().batch_hint_threshold
    );
    hint.hidden = !suggest;
    if (suggest) {
      hint.textContent =
        "队列已有 " + state.queue.items.length + " 项：上千个文件建议改用 /ingest/dir" +
        "（同机零传输，不必经过浏览器逐文件上传）。";
    }
  }

  function queueSyncControls() {
    var items = state.queue.items;
    var hasPending = items.some(queueIsPending);
    var hasFinished = items.some(queueIsFinished);
    queuePaintSummary();
    $("queue-empty").hidden = items.length > 0;
    var startBtn = $("btn-queue-start");
    startBtn.disabled = state.queue.running || !hasPending;
    startBtn.textContent = state.queue.running ? "上传中…" : "开始上传";
    $("btn-queue-stop").hidden = !state.queue.running;
    $("btn-queue-clear").disabled = !hasFinished;
    queueEnsureTicker();
    queueSyncBacklog();
    queueSyncHint();
  }

  function queueItemLabel(item) {
    if (item.status === "uploading") return "上传中 " + Math.round(item.percent) + "%";
    if (item.status === "pending" && item.retryAt) {
      var left = Math.max(0, Math.ceil((item.retryAt - Date.now()) / 1000));
      return "排队退避 " + left + "s";
    }
    return item.label;
  }

  function queueChipFor(item) {
    if (item.status === "pending" && item.retryAt) return ["chip-pending", "排队退避"];
    return QUEUE_CHIP[item.status] || ["chip-info", item.status];
  }

  function paintQueueItem(item) {
    var refs = item.node;
    if (!refs) return;
    var chip = queueChipFor(item);
    refs.chip.className = "chip " + chip[0] + " queue-item-chip";
    refs.chip.textContent = chip[1];
    refs.root.className = "queue-item queue-" + item.status;
    refs.status.textContent = queueItemLabel(item);

    var percent = item.percent || 0;
    if (item.status === "done" || item.status === "duplicate") percent = 100;
    if (item.status === "failed") percent = item.percent || 0;
    refs.fill.style.width = Math.max(0, Math.min(100, percent)) + "%";

    refs.cancel.textContent = queueIsActive(item) ? "取消" : "移除";
    refs.cancel.disabled = !(queueIsPending(item) || queueIsActive(item));

    clear(refs.link);
    if (item.paperId && (item.status === "done" || item.status === "duplicate" || item.status === "processing")) {
      var link = el("button", "link-title", "查看论文 " + String(item.paperId).slice(0, 8));
      link.type = "button";
      link.addEventListener("click", function () {
        openDetail(item.paperId);
      });
      refs.link.appendChild(link);
    } else if (item.error) {
      refs.link.textContent = "原因：" + item.error;
      refs.link.className = "queue-item-link error-text";
    } else {
      refs.link.className = "queue-item-link muted";
    }
    // 进度事件很密，这里只刷新摘要文字，按钮状态交给 queueSyncControls()
    queuePaintSummary();
  }

  function renderQueueItem(item) {
    var root = el("li", "queue-item queue-" + item.status);

    var head = el("div", "queue-item-head");
    var name = el("span", "queue-item-name", item.name);
    name.title = item.name;
    head.appendChild(name);
    if (item.size !== null) head.appendChild(el("span", "muted queue-item-size", fmtSize(item.size)));
    var chip = el("span", "chip chip-info queue-item-chip", "");
    head.appendChild(chip);
    var actions = el("span", "queue-item-actions");
    var cancel = el("button", "btn btn-ghost btn-sm", "移除");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      queueRemove(item.id);
    });
    actions.appendChild(cancel);
    head.appendChild(actions);
    root.appendChild(head);

    var bar = el("div", "progress-bar queue-item-bar");
    var fill = el("span");
    bar.appendChild(fill);
    root.appendChild(bar);

    var foot = el("div", "queue-item-foot");
    var status = el("span", "muted");
    foot.appendChild(status);
    var link = el("span", "queue-item-link muted");
    foot.appendChild(link);
    root.appendChild(foot);

    item.node = { root: root, chip: chip, fill: fill, status: status, link: link, cancel: cancel };
    paintQueueItem(item);
    return root;
  }

  function renderQueue() {
    var list = $("queue-list");
    clear(list);
    state.queue.items.forEach(function (item) {
      list.appendChild(renderQueueItem(item));
    });
    queueSyncControls();
  }

  function queueAdd(items) {
    var existing = {};
    state.queue.items.forEach(function (item) {
      existing[item.kind + "|" + item.name + "|" + (item.size || 0)] = item;
    });
    var added = 0;
    var skipped = 0;
    items.forEach(function (item) {
      var key = item.kind + "|" + item.name + "|" + (item.size || 0);
      var live = existing[key];
      if (live && !queueIsFinished(live)) {   // 只有仍在队列里（未结束）的同名项才拦
        skipped += 1;
        return;
      }
      existing[key] = item;
      state.queue.items.push(item);
      added += 1;
    });
    if (added) renderQueue();
    else queueSyncControls();
    if (added && $("queue-autostart").checked && !state.queue.running) queueStart();
    return { added: added, skipped: skipped };
  }

  function queueAddFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var items = [];
    var rejected = [];
    files.forEach(function (file) {
      var isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (!isPdf) {
        rejected.push(file.name + "（非 PDF）");
        return;
      }
      if (file.size > queueConfig().file_max_mb * 1024 * 1024) {
        rejected.push(file.name + "（超过 " + queueConfig().file_max_mb + "MB）");
        return;
      }
      items.push(newQueueItem("file", file.name, file.size, { file: file }));
    });
    var result = queueAdd(items);
    if (rejected.length) {
      toast("已跳过 " + rejected.length + " 个文件：" + rejected.slice(0, 3).join("、") +
        (rejected.length > 3 ? " …" : ""), "warn");
    }
    if (result.added) toast("已加入队列 " + result.added + " 个文件", "ok");
    else if (!rejected.length && files.length) toast("这些文件已在队列里", "info");
    return result;
  }

  function queueAddUrl(url) {
    var result = queueAdd([newQueueItem("url", url, null, { url: url })]);
    if (!result.added) toast("该链接已在队列里", "info");
    return result.added > 0;
  }

  function queueRemove(id) {
    var item = queueFind(id);
    if (!item) return;
    if (queueIsActive(item)) {
      queueCancelItem(item);
      return;
    }
    state.queue.items = state.queue.items.filter(function (other) {
      return other.id !== id;
    });
    renderQueue();
  }

  function queueMarkCanceled(item) {
    if (item.timer) {
      window.clearTimeout(item.timer);
      item.timer = null;
    }
    item.status = "canceled";
    item.label = "已取消";
    item.error = null;
    paintQueueItem(item);
    queueSyncControls();
  }

  function queueCancelItem(item) {
    if (item.xhr) {
      item.xhr.abort();
      item.xhr = null;
    }
    queueMarkCanceled(item);
  }

  function queueClearFinished() {
    state.queue.items = state.queue.items.filter(function (item) {
      return !queueIsFinished(item);
    });
    renderQueue();
  }

  function queueFreeSlots() {
    return Math.max(0, queueConcurrency() - state.queue.inflight.length);
  }

  function queueNextWake() {
    var earliest = null;
    state.queue.items.forEach(function (item) {
      if (item.status === "pending" && item.retryAt &&
          (earliest === null || item.retryAt < earliest)) {
        earliest = item.retryAt;
      }
    });
    return earliest;
  }

  /* 退避到点再回来补位；没有退避中的项就不排定时器。 */
  function queueScheduleWake() {
    if (state.queue.wakeTimer) {
      window.clearTimeout(state.queue.wakeTimer);
      state.queue.wakeTimer = null;
    }
    var at = queueNextWake();
    if (at === null || !state.queue.running) return;
    state.queue.wakeTimer = window.setTimeout(function () {
      state.queue.wakeTimer = null;
      queuePump();
    }, Math.max(0, at - Date.now()) + 50);
  }

  /* 并发池：把空位一次填满（uploadSlots 只挑不排队的 pending），
   * 每个上传请求结束都会回调 queuePump 补位（决策 #1 / #2）。 */
  function queuePump() {
    if (state.queue.halt) {
      queueDrain();
      return;
    }
    var started = QL.uploadSlots(state.queue.items, queueFreeSlots(), Date.now());
    if (started.length) {
      started.forEach(function (item) {
        state.queue.inflight.push(item);
        processQueueItem(item).then(queuePump, queuePump);
      });
      queueSyncControls();
      return;
    }
    if (queueNextWake() !== null) {       // 都在退避：等最靠前的一个到点
      queueScheduleWake();
      queueSyncControls();
      return;
    }
    if (state.queue.inflight.length) {    // 池满：等上传结束的回调
      queueSyncControls();
      return;
    }
    queueDrain();
  }

  function queueStart() {
    if (state.queue.running) return;
    if (!state.queue.items.some(queueIsPending)) return;
    state.queue.halt = false;
    state.queue.running = true;
    state.queue.items.forEach(function (item) {   // 重新开始时退避计数归零
      if (queueIsPending(item)) {
        item.attempts = 0;
        item.retryAt = null;
      }
    });
    queueSyncControls();
    queuePump();
  }

  function queueStop() {
    state.queue.halt = true;
    state.queue.inflight.slice().forEach(function (item) {
      queueCancelItem(item);                      // 在途上传全部中止（不只一个）
    });
    state.queue.inflight = [];
    state.queue.items.forEach(function (item) {   // 轮询 timer 也全部清掉
      if (item.timer) {
        window.clearTimeout(item.timer);
        item.timer = null;
      }
    });
    queueDrain();
    toast("已停止：在途上传已中止；已提交的作业会在 paperbox 里继续跑完", "warn");
  }

  function queueDrain() {
    var wasRunning = state.queue.running;
    state.queue.running = false;
    state.queue.inflight = [];
    if (state.queue.wakeTimer) {
      window.clearTimeout(state.queue.wakeTimer);
      state.queue.wakeTimer = null;
    }
    state.queue.items.forEach(function (item) {
      if (queueIsPending(item)) {          // 退避标记不跨"这一轮"
        item.retryAt = null;
        item.label = "待上传";
      }
    });
    queueSyncControls();
    loadHealth();
    if (!wasRunning) return;

    var summary = QL.summarizeProgress(state.queue.items);
    var done = 0;
    var failed = 0;
    state.queue.items.forEach(function (item) {
      if (item.status === "done" || item.status === "duplicate") done += 1;
      else if (item.status === "failed") failed += 1;
    });
    if (summary.submitted > summary.terminal) {
      // 上传阶段收工，但作业还在 paperbox 里跑（轮询继续）
      toast("上传阶段结束：已提交 " + summary.submitted + " 个作业，处理中…", "ok");
    } else if (done || failed) {
      toast("队列结束：成功 " + done + " · 失败 " + failed, failed ? "warn" : "ok");
    }
  }

  function uploadFileWithProgress(item) {
    return new Promise(function (resolve, reject) {
      var form = new FormData();
      form.append("files", item.file, item.name);       // 一个请求一个文件（决策 #1）
      var xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open("POST", "/api/ui/ingest/files");
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        item.percent = (event.loaded / event.total) * 100;
        paintQueueItem(item);
      };
      xhr.onload = function () {
        item.xhr = null;
        var payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch (error) {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ payload: payload || {} });
          return;
        }
        if (xhr.status === 429) {
          // 服务端忙：不是失败，按 Retry-After 退避后重发（重建 XHR）
          resolve({ busy: true, retryAfter: xhr.getResponseHeader("Retry-After") });
          return;
        }
        var detail = payload && payload.detail ? JSON.stringify(payload.detail) : "";
        reject(new Error("HTTP " + xhr.status + (detail ? "：" + detail : "")));
      };
      xhr.onerror = function () {
        item.xhr = null;
        reject(new Error("网络错误（上传失败）"));
      };
      xhr.onabort = function () {
        var error = new Error("已取消");
        error.aborted = true;
        reject(error);
      };
      xhr.send(form);
    });
  }

  function queueRelease(item) {
    state.queue.inflight = state.queue.inflight.filter(function (other) {
      return other !== item;
    });
  }

  /* 429 之后把这项放回 pending 并标记 retryAt；到点由 queuePump 重新进池。
   * 超过重试上限才判失败（决策 #3）。 */
  function queueBackOff(item, retryAfterHeader) {
    var config = queueConfig();
    item.attempts += 1;
    if (item.attempts > config.upload_max_attempts) {
      item.status = "failed";
      item.percent = 0;
      item.retryAt = null;
      item.label = "失败";
      item.error = "服务端持续繁忙（429），已重试 " + config.upload_max_attempts + " 次";
      paintQueueItem(item);
      queueSyncControls();
      return;
    }
    var delay = QL.retryDelayMs(item.attempts, retryAfterHeader, {
      baseMs: config.retry_base_ms,
      capMs: config.retry_cap_ms
    });
    item.status = "pending";
    item.percent = 0;
    item.retryAt = Date.now() + delay;
    item.label = "排队退避";
    paintQueueItem(item);
    queueSyncControls();
  }

  /* 逐文件结果 → 作业信息。rejected 是 paperbox 的逐文件校验失败（不重试）。 */
  function uploadResult(payload) {
    var results = payload && Array.isArray(payload.results) ? payload.results : [];
    var first = results.length ? results[0] : null;
    if (!first) throw new Error("后端未返回逐文件结果");
    if (first.status === "rejected") {
      throw new Error(
        text(first.error_code, "REJECTED") + "：" + text(first.error_message, "被拒绝")
      );
    }
    if (!first.job_id) throw new Error("后端未返回 job_id");
    return first;
  }

  /* 提交后的作业轮询：不占用并发位（池只管上传请求），每 2s 一次直到终态。 */
  function pollQueueItem(item) {
    return new Promise(function (resolve) {
      function tick() {
        item.timer = null;
        if (state.queue.halt) {          // 停止后不再跟踪（作业在 paperbox 里继续跑）
          resolve(null);
          return;
        }
        api("/api/ui/jobs/" + encodeURIComponent(item.jobId))
          .then(function (job) {
            item.retries = 0;
            var progress = typeof job.progress === "number" ? job.progress : 0;
            if (job.paper_id) item.paperId = job.paper_id;

            if (job.stage === "FAILED") {
              item.jobDone = true;
              item.status = "failed";
              item.percent = progress;
              item.label = "失败";
              item.error = text(job.error_message, "未知错误");
              paintQueueItem(item);
              queueSyncControls();
              loadHealth();
              resolve(null);
              return;
            }
            if (job.stage === "COMPLETED") {
              item.jobDone = true;
              item.status = job.duplicate ? "duplicate" : "done";
              item.percent = 100;
              item.label = job.duplicate ? "重复论文（已存在）" : "已完成";
              paintQueueItem(item);
              queueSyncControls();
              loadHealth();
              resolve(null);
              return;
            }
            item.status = "processing";
            item.percent = progress;
            item.label = stageLabel(job.stage) + "（" + (stageIndex(job.stage) + 1) + "/" + STAGES.length + "）" +
              (job.duplicate ? " · 重复" : "");
            paintQueueItem(item);
            item.timer = window.setTimeout(tick, QUEUE_POLL_MS);
          })
          .catch(function (error) {
            item.retries += 1;
            if (item.retries > QUEUE_MAX_RETRY) {
              item.status = "failed";
              item.label = "失败";
              item.error = "查询任务失败：" + error.message;
              paintQueueItem(item);
              queueSyncControls();
              resolve(null);
              return;
            }
            item.timer = window.setTimeout(tick, QUEUE_POLL_MS);
          });
      }
      tick();
    });
  }

  function processQueueItem(item) {
    item.error = null;
    var submitted;

    if (item.kind === "file") {
      item.status = "uploading";
      item.percent = 0;
      item.label = "上传中…";
      paintQueueItem(item);
      submitted = uploadFileWithProgress(item);
    } else {
      item.status = "submitted";
      item.percent = 0;
      item.label = "提交链接中…";
      paintQueueItem(item);
      submitted = api("/api/ui/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_type: "url", source: item.url })
      });
    }

    return submitted
      .then(function (data) {
        queueRelease(item);              // 上传请求结束，立刻让位给下一个 pending
        if (data && data.busy) {         // 429：退避重试，不是失败
          queueBackOff(item, data.retryAfter);
          return null;
        }
        if (state.queue.halt) {
          queueMarkCanceled(item);
          return null;
        }
        var result = item.kind === "file"
          ? uploadResult(data && data.payload)
          : {
              status: "accepted",
              job_id: data && data.job_id,
              paper_id: data && data.paper_id
            };
        item.jobId = result.job_id;
        if (result.paper_id) item.paperId = result.paper_id;

        if (result.status === "duplicate") {
          // 库内已有相同内容：不产生新论文，作业已 COMPLETED，不用轮询
          item.jobDone = true;
          item.status = "duplicate";
          item.percent = 100;
          item.label = "重复论文（已存在）";
          paintQueueItem(item);
          queueSyncControls();
          loadHealth();
          return null;
        }

        item.status = "submitted";
        item.percent = 100;
        item.label = "已提交（job " + String(item.jobId).slice(0, 8) + "）";
        paintQueueItem(item);
        queueSyncControls();
        pollQueueItem(item);             // 后台轮询，不阻塞并发池
        return null;
      })
      .catch(function (error) {
        queueRelease(item);
        if (state.queue.halt || (error && error.aborted)) {
          queueMarkCanceled(item);
          return null;
        }
        item.status = "failed";
        item.label = "失败";
        item.error = error.message;
        paintQueueItem(item);
        queueSyncControls();
        return null;
      });
  }

  /* 拖拽：支持文件夹（webkitGetAsEntry），readEntries 必须读到空为止（每次最多返回 100 项） */

  function walkDropEntry(entry) {
    return new Promise(function (resolve) {
      if (!entry) {
        resolve([]);
        return;
      }
      if (entry.isFile) {
        entry.file(function (file) {
          resolve([file]);
        }, function () {
          resolve([]);
        });
        return;
      }
      var reader = entry.createReader();
      var acc = [];
      function readBatch() {
        reader.readEntries(function (batch) {
          if (!batch.length) {
            Promise.all(acc.map(walkDropEntry)).then(function (lists) {
              var flat = [];
              lists.forEach(function (list) {
                flat = flat.concat(list);
              });
              resolve(flat);
            });
            return;
          }
          acc = acc.concat(Array.prototype.slice.call(batch));
          readBatch();
        }, function () {
          resolve([]);
        });
      }
      readBatch();
    });
  }

  function collectDroppedFiles(dataTransfer) {
    var entries = [];
    var items = dataTransfer && dataTransfer.items;
    if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
      for (var i = 0; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length) {
        return Promise.all(entries.map(walkDropEntry)).then(function (lists) {
          var flat = [];
          lists.forEach(function (list) {
            flat = flat.concat(list);
          });
          return flat;
        });
      }
    }
    return Promise.resolve(Array.prototype.slice.call((dataTransfer && dataTransfer.files) || []));
  }

  function submitIngestUrl(event) {
    event.preventDefault();
    var url = $("ingest-url").value.trim();
    if (!url) {
      toast("请输入 PDF 链接", "warn");
      return;
    }
    if (queueAddUrl(url)) $("ingest-url").value = "";
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

    $("btn-queue-pick").addEventListener("click", function () {
      $("queue-file-input").click();
    });
    $("queue-file-input").addEventListener("change", function (event) {
      queueAddFiles(event.target.files);
      event.target.value = "";        // 清空，便于再次选中同一批文件
    });
    $("btn-queue-start").addEventListener("click", queueStart);
    $("btn-queue-stop").addEventListener("click", queueStop);
    $("btn-queue-clear").addEventListener("click", queueClearFinished);

    var dropzone = $("queue-dropzone");
    ["dragenter", "dragover"].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        dropzone.classList.add("is-drag");
      });
    });
    ["dragleave", "dragend", "drop"].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        dropzone.classList.remove("is-drag");
      });
    });
    dropzone.addEventListener("drop", function (event) {
      collectDroppedFiles(event.dataTransfer).then(queueAddFiles);
    });

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
    loadConfig();                 // 拿不到配置就用内置默认，不阻塞上传
    loadHealth();
    window.setInterval(loadHealth, HEALTH_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();