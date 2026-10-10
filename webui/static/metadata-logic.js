/* paperbox 控制台 · 元数据导入报告的纯逻辑（无 DOM，可被 node --test 直接测）。
 *
 * 这两件事原本散在 app.js 的渲染里，改起来没测试、也说不清口径：
 *   1) 报告可能很长（一次导入 5933 条记录），必须截断并**如实说明截了多少**；
 *   2) 摘要行要说清"这份报告是哪来的"——来源类型来自表单而不是响应，
 *      所以它必须在摘要里出现一次，而不是在每一行重复一列（那一列一直是空的，
 *      因为 paperbox 的 /api/metadata/import 响应里根本没有 source_type 字段）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ML = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*: 表格里最多铺多少行。超出的部分只报数——报告是给人看的，不是导出文件。 */
  var ROW_LIMIT = 50;

  function capRows(items, limit) {
    var all = Array.isArray(items) ? items : [];
    var max = typeof limit === "number" && limit > 0 ? limit : ROW_LIMIT;
    return {
      rows: all.slice(0, max),
      hidden: Math.max(0, all.length - max),
      total: all.length
    };
  }

  /*: 截断提示文案；没截断就返回空串（调用方据此隐藏那一行）。 */
  function hiddenNote(hidden, total, noun) {
    var n = Number(hidden) || 0;
    if (n <= 0) return "";
    return "另有 " + n + " 条" + (noun || "") + "未展开（共 " + (Number(total) || 0) + " 条）。";
  }

  /*: 摘要行：写入状态 · 来源类型 · 记录格式 · 结论。 */
  function reportSummary(report, sourceType) {
    var data = report || {};
    var parts = [data.dry_run ? "试运行（未写库）" : "已写入"];
    if (sourceType) parts.push("来源 " + sourceType);
    if (data.format) parts.push("格式 " + data.format);
    if (typeof data.detected === "number") {
      var matched = Number(data.matched) || 0;
      var failed = Number(data.failed) || 0;
      var line = "检测到 " + data.detected + " 条，匹配 " + matched + " 条";
      if (failed) line += "，失败 " + failed + " 条";
      parts.push(line);
    }
    return parts.join(" · ");
  }

  /*: 合并状态 → 中文标签，未知状态原样显示（不吞掉 paperbox 新加的状态）。 */
  var MATCH_LABELS = {
    matched: "已匹配",
    ambiguous: "歧义",
    unmatched: "未匹配",
    pending: "待处理",
    attached: "已挂靠"
  };

  function matchLabel(status) {
    if (!status) return "—";
    var key = String(status).toLowerCase();
    return MATCH_LABELS[key] || String(status);
  }

  return {
    ROW_LIMIT: ROW_LIMIT,
    capRows: capRows,
    hiddenNote: hiddenNote,
    reportSummary: reportSummary,
    matchLabel: matchLabel,
    MATCH_LABELS: MATCH_LABELS
  };
});
