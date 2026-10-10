/* paperbox 控制台 · 元数据导入报告的纯逻辑（无 DOM，node --test 直接跑）。
 *
 * 三件事原先散在 app.js 里、没测试也说不清口径，现在集中在这里：
 *   1) 分页（一次导入可能 5933 条来源，全铺出来没法看）；
 *   2) 排序优先级：**未匹配 / 歧义优先** —— 需要人动手的排前面；
 *   3) 行的**单元格规格**。这一条是被真机事故逼出来的：表格曾经出现"表头 4 列、内容 5 列、
 *      中间多一个 —"，因为单元格是在渲染里逐个 append 的，多一个少一个没人管。现在行内容由
 *      纯函数给出数组，长度可断言。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ML = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*: 默认每页条数：来源明细 5 条、字段冲突 3 条（界面可改）。 */
  var SOURCES_PAGE_SIZE = 5;
  var CONFLICTS_PAGE_SIZE = 3;

  /*: 匹配状态的展示标签；未知状态原样显示，不吞掉 paperbox 新加的值。 */
  var MATCH_LABELS = {
    matched: "已匹配",
    ambiguous: "歧义",
    unmatched: "未匹配",
    pending: "待处理",
    attached: "已挂靠"
  };

  /*: 需要人工处理的排前面，数字越小越靠前。 */
  var PRIORITY = { unmatched: 0, ambiguous: 1 };

  function matchLabel(status) {
    if (!status) return "—";
    var key = String(status).toLowerCase();
    return MATCH_LABELS[key] || String(status);
  }

  function priorityOf(status) {
    var key = String(status || "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(PRIORITY, key) ? PRIORITY[key] : 2;
  }

  /*: 未匹配/歧义优先 + 同组内保持原顺序（稳定排序，翻页时行不会乱跳）。 */
  function sortForReview(items) {
    var list = Array.isArray(items) ? items : [];
    return list
      .map(function (item, index) {
        return { item: item, index: index };
      })
      .sort(function (left, right) {
        var delta =
          priorityOf(left.item && left.item.match_status) -
          priorityOf(right.item && right.item.match_status);
        return delta !== 0 ? delta : left.index - right.index;
      })
      .map(function (entry) {
        return entry.item;
      });
  }

  function positiveInt(value, fallback) {
    var number = Number(value);
    if (!isFinite(number) || number < 1) return fallback;
    return Math.floor(number);
  }

  function pageCount(total, pageSize) {
    var size = positiveInt(pageSize, SOURCES_PAGE_SIZE);
    var count = Number(total) || 0;
    return Math.max(1, Math.ceil(count / size));
  }

  function clampPage(page, total, pageSize) {
    var last = pageCount(total, pageSize);
    var wanted = Math.floor(Number(page) || 1);
    if (wanted < 1) return 1;
    return Math.min(wanted, last);
  }

  /*: 分页结果带上界面要用的全部数：rows / page / pageCount / total / 区间（1 基，便于显示）。 */
  function paginate(items, page, pageSize) {
    var all = Array.isArray(items) ? items : [];
    var size = positiveInt(pageSize, SOURCES_PAGE_SIZE);
    var current = clampPage(page, all.length, size);
    var start = (current - 1) * size;
    return {
      rows: all.slice(start, start + size),
      page: current,
      pageCount: pageCount(all.length, size),
      pageSize: size,
      total: all.length,
      first: all.length ? start + 1 : 0,
      last: Math.min(start + size, all.length)
    };
  }

  /*: 「第 3–7 条 / 共 5933 条 · 第 2/1187 页」。 */
  function pageSummary(result) {
    if (!result || !result.total) return "共 0 条";
    return (
      "第 " +
      result.first +
      "–" +
      result.last +
      " 条 / 共 " +
      result.total +
      " 条 · 第 " +
      result.page +
      "/" +
      result.pageCount +
      " 页"
    );
  }

  /*: 摘要行：来源类型 · 记录格式 · 结论。「试运行/已写入」不在这里 ——
   * 那是摘要行左边那个 chip 的职责，重复一遍真机上就出现了"试运行 · 试运行 · …"。
   *
   *: 计数的口径按 paperbox 的字段来：``matched`` 是**命中已有论文**的条数，
   * 造壳（``created_shell``）不算命中 —— 曾经只显示"匹配 0 条"，看起来像 12 条全失败了。 */
  function reportSummary(report, sourceType) {
    var data = report || {};
    var parts = [];
    if (sourceType) parts.push("来源 " + sourceType);
    if (data.format) parts.push("格式 " + data.format);
    if (typeof data.detected === "number") parts.push("检测到 " + data.detected + " 条");
    var matched = Number(data.matched) || 0;
    var shell = Number(data.created_shell) || 0;
    var failed = Number(data.failed) || 0;
    if (matched) parts.push("命中已有论文 " + matched + " 条");
    if (shell) parts.push("待补文件的新壳 " + shell + " 条");
    if (failed) parts.push("失败 " + failed + " 条");
    if (!parts.length) return "已收到报告";
    return parts.join(" · ");
  }

  /*: 来源明细一行 = 固定 4 格。source_type 不在这里：paperbox 的导入响应没有这个字段，
   * 它只出现在摘要行（否则那一列永远是 —，正是老问题的来源）。 */
  function sourcesRow(item) {
    var data = item || {};
    return [
      { kind: "ref", text: data.source_ref || "—" },
      { kind: "text", text: matchLabel(data.match_status) },
      { kind: "text", text: data.match_method || "—" },
      data.paper_id
        ? { kind: "paper", text: data.paper_id }
        : { kind: "note", text: data.note || "—" }
    ];
  }

  /*: 字段冲突一行 = 固定 4 格。 */
  function conflictRow(item) {
    var data = item || {};
    return [
      { kind: "paper", text: data.paper_id || "" },
      { kind: "text", text: data.field || "—" },
      { kind: "kept", text: valueText(data.kept) },
      { kind: "rejected", text: valueText(data.rejected) }
    ];
  }

  function valueText(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  return {
    SOURCES_PAGE_SIZE: SOURCES_PAGE_SIZE,
    CONFLICTS_PAGE_SIZE: CONFLICTS_PAGE_SIZE,
    MATCH_LABELS: MATCH_LABELS,
    PRIORITY: PRIORITY,
    matchLabel: matchLabel,
    priorityOf: priorityOf,
    sortForReview: sortForReview,
    paginate: paginate,
    pageCount: pageCount,
    clampPage: clampPage,
    pageSummary: pageSummary,
    reportSummary: reportSummary,
    sourcesRow: sourcesRow,
    conflictRow: conflictRow,
    valueText: valueText
  };
});
