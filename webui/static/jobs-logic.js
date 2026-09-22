/* paperbox 控制台：任务列表的纯逻辑（无 DOM、无网络、无依赖）。
 *
 * 同一份文件两个入口：浏览器里挂成 window.PaperboxJobs，node 里走 module.exports
 * （见 tests/js/jobs_logic.test.mjs）。
 *
 * 这里放的是"会算错"的两条规则：
 *   - 服务端分页的页数 / 当前页 / 上一页下一页可用性（offset 是行偏移，不是页码）；
 *   - 耗时（有 finished_at 才算得出来，否则作业还在跑）。
 *
 * 不引入任何构建工具（SPEC §4）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PaperboxJobs = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RUNNING = "进行中";

  function seconds(value) {
    var ms = new Date(value).getTime();
    return isNaN(ms) ? null : ms;
  }

  /* 耗时文案：没有 created_at → "—"；还没完成 → "进行中"。 */
  function durationText(job) {
    if (!job || !job.created_at) return "—";
    var start = seconds(job.created_at);
    if (start === null) return "—";
    if (!job.finished_at) return RUNNING;
    var end = seconds(job.finished_at);
    if (end === null) return "—";
    var total = Math.max(0, (end - start) / 1000);
    if (total < 60) return total.toFixed(1) + " s";
    if (total < 3600) return (total / 60).toFixed(1) + " min";
    return (total / 3600).toFixed(1) + " h";
  }

  /* 服务端分页状态。
   *
   * `offset` 是**行偏移**（后端契约），页数 = ceil(total / limit)，至少 1 页；
   * 越界的 offset 会被夹到最后一页（后端会返回空页，但翻页按钮不该把人带进空页）。 */
  function pagerState(input) {
    var source = input || {};
    var limit = Number(source.limit) > 0 ? Number(source.limit) : 20;
    var total = Number(source.total) > 0 ? Number(source.total) : 0;
    var offset = Number(source.offset) > 0 ? Number(source.offset) : 0;
    var pages = Math.max(1, Math.ceil(total / limit));
    var page = Math.min(pages, Math.floor(offset / limit) + 1);
    return {
      total: total,
      limit: limit,
      offset: offset,
      pages: pages,
      page: page,
      canPrev: offset > 0,
      canNext: offset + limit < total,
      label: "第 " + page + " / " + pages + " 页",
      totalLabel: "共 " + total + " 条"
    };
  }

  /* 翻页用的下一个 offset（上一页在 0 处夹住）。 */
  function nextOffset(offset, limit, direction) {
    var step = Number(limit) > 0 ? Number(limit) : 20;
    var current = Number(offset) > 0 ? Number(offset) : 0;
    var moved = direction === "prev" ? current - step : current + step;
    return Math.max(0, moved);
  }

  return {
    RUNNING: RUNNING,
    durationText: durationText,
    pagerState: pagerState,
    nextOffset: nextOffset
  };
});
