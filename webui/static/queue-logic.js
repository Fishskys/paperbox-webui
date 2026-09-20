/* paperbox 控制台：上传队列的纯逻辑（无 DOM、无网络、无依赖）。
 *
 * 同一份文件两个入口：浏览器里挂成 window.PaperboxQueue，node 里走 module.exports
 * （见 tests/js/queue_logic.test.mjs）。并发数、429 退避、两阶段进度的规则因此能被
 * node:test 真测，而不是靠对 app.js 做字符串断言。
 *
 * 不引入任何构建工具（SPEC §4）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PaperboxQueue = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_BASE_MS = 2000;
  var DEFAULT_CAP_MS = 60000;
  var DEFAULT_JITTER = 0.25;

  function isNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  /* paperbox 的 429 只发秒（`Retry-After: 2`）。HTTP-date 形式一律当"解析不了"，
   * 调用方自然退回指数退避——为了一个用不到的形式引日期库不值得。 */
  function parseRetryAfter(value) {
    if (isNumber(value)) return value >= 0 ? value : null;
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    var seconds = Number(trimmed);
    return isNumber(seconds) && seconds >= 0 ? seconds : null;
  }

  /* 退避毫秒数：优先服务端给的 Retry-After，否则 base × 2^(attempt-1) + 抖动，
   * 两者都以 capMs 封顶（默认 60s）。attempt 从 1 开始。 */
  function retryDelayMs(attempt, retryAfterSeconds, opts) {
    var options = opts || {};
    var capMs = isNumber(options.capMs) ? options.capMs : DEFAULT_CAP_MS;

    var fromHeader = parseRetryAfter(retryAfterSeconds);
    if (fromHeader !== null) return Math.min(Math.round(fromHeader * 1000), capMs);

    var baseMs = isNumber(options.baseMs) ? options.baseMs : DEFAULT_BASE_MS;
    var jitter = isNumber(options.jitter) ? options.jitter : DEFAULT_JITTER;
    var random = typeof options.random === "function" ? options.random : Math.random;
    var step = Math.max(1, Math.floor(isNumber(attempt) ? attempt : 1));

    var delay = baseMs * Math.pow(2, step - 1);
    delay = delay * (1 + random() * jitter);
    return Math.min(Math.round(delay), capMs);
  }

  /* 两阶段进度的两个计数（决策 #5）：
   *   toUpload / uploaded —— 需上传的文件数 / 已拿到 job_id 的文件数（"上传 x/y"）
   *   submitted / terminal —— 已提交作业数 / 已到终态（COMPLETED|FAILED）作业数（"处理 a/b"）
   * URL 项不是上传，只进作业计数；被取消的文件不再算"需上传"。
   * 作业是否到终态由轮询方打标（item.jobDone），不靠 status 猜——上传失败和作业失败
   * 都是 status="failed"，含义不同。 */
  function summarizeProgress(items) {
    var list = Array.isArray(items) ? items : [];
    var summary = {
      total: list.length,
      toUpload: 0,
      uploaded: 0,
      submitted: 0,
      terminal: 0,
      failed: 0
    };
    list.forEach(function (item) {
      if (!item) return;
      if (item.status === "failed") summary.failed += 1;
      if (item.jobId) summary.submitted += 1;
      if (item.jobDone === true) summary.terminal += 1;
      if (item.kind === "file") {
        // 已提交后被取消的文件仍然算"需上传"（它确实上传过），否则会出现 上传 7/4 这种倒挂
        if (item.status !== "canceled" || item.jobId) summary.toUpload += 1;
        if (item.jobId) summary.uploaded += 1;
      }
    });
    return summary;
  }

  /* 本次可以进池的 pending 项：最多 slots 个，跳过还在退避（retryAt 未到）的。
   * 调用方传"池里还空几个位"，函数只挑不排队。 */
  function uploadSlots(items, slots, now) {
    var list = Array.isArray(items) ? items : [];
    var room = isNumber(slots) ? Math.floor(slots) : 0;
    if (room <= 0) return [];
    var at = isNumber(now) ? now : Date.now();
    var picked = [];
    for (var i = 0; i < list.length && picked.length < room; i++) {
      var item = list[i];
      if (!item || item.status !== "pending") continue;
      if (isNumber(item.retryAt) && item.retryAt > at) continue;
      picked.push(item);
    }
    return picked;
  }

  /* 队列很长时提示改用服务端目录导入（决策 #6：不做自动切批优先级）。 */
  function shouldSuggestServerSide(total, threshold) {
    if (!isNumber(total) || !isNumber(threshold) || threshold <= 0) return false;
    return total >= threshold;
  }

  return {
    parseRetryAfter: parseRetryAfter,
    retryDelayMs: retryDelayMs,
    summarizeProgress: summarizeProgress,
    uploadSlots: uploadSlots,
    shouldSuggestServerSide: shouldSuggestServerSide
  };
});
