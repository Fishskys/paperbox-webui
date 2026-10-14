/* paperbox 控制台：顶部状态条里依赖徽标的纯逻辑（无 DOM、无网络、无依赖）。
 *
 * 同一份文件两个入口：浏览器里挂成 window.PaperboxHealth，node 里走 module.exports
 * （见 tests/js/health_logic.test.mjs）。
 *
 * 与后端的对应关系（paperbox 的 `GET /health`，2026-10-14 起）：
 *   - `services.<name>` 只有四种取值（`app/services/health_service.py` 的 ProbeSpec 全文
 *     只产出这四个）：`ok` / `error` / `disabled` / `unknown`。必须分开画：
 *     `disabled` 是"没配"（灰，不是故障），`unknown` 是"答得上话但还不能干活"（黄，
 *     例如容器 /health 回 200 而模型还没加载完），只有 `error` 是明确失败（红）。
 *     认不出的值按 `unknown` 处理 —— 宁可黄，不要假绿。
 *   - `dependencies.<name>` 带 `reason` / `latency_ms` / `checked_at` / `cached`：
 *     悬停时**只显示失败原因**（`ok` / `disabled` 不给 tooltip）。
 *   - 结论时刻用 paperbox 的 `checked_at`，不是浏览器取回的时刻：探测只按需，paperbox
 *     侧结论还会按 TTL 复用，"查得新"不等于"结论新"，缓存命中必须写明。
 *   - 顶层 `degraded`（必需依赖是否就绪）单独说一句，而不是只在某几格里体现。
 *
 * 不引入任何构建工具（SPEC 第 4 节）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PaperboxHealth = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OK = "ok";
  var ERROR = "error";
  var DISABLED = "disabled";
  var UNKNOWN = "unknown";

  var STATES = [OK, ERROR, DISABLED, UNKNOWN];

  /* 四种状态 = 四种颜色：绿 / 红 / 灰 / 黄。灰色是 chip-disabled，黄色是 chip-unknown，
   * 初始占位（还没取回数据）用 chip-pending —— 这三者颜色相近但含义完全不同，
   * 所以不合并成一个类。 */
  var CLASS_BY_STATE = {};
  CLASS_BY_STATE[OK] = "chip chip-ok";
  CLASS_BY_STATE[ERROR] = "chip chip-error";
  CLASS_BY_STATE[DISABLED] = "chip chip-disabled";
  CLASS_BY_STATE[UNKNOWN] = "chip chip-unknown";

  /* 会显示失败原因的两种状态：error 是明确失败；unknown 是"还没法干活"，
   * 同样需要人去看（容器起来了但模型没加载完，等一会儿就好）。 */
  var FAILING = {};
  FAILING[ERROR] = true;
  FAILING[UNKNOWN] = true;

  var PENDING_CLASS = "chip chip-pending";
  var DEGRADED_TEXT = "依赖未就绪";
  var UNREACHABLE_TEXT = "不可用";
  var NO_REASON_TEXT = "paperbox 未给出原因";

  function stateOf(value) {
    for (var i = 0; i < STATES.length; i += 1) {
      if (value === STATES[i]) return value;
    }
    return UNKNOWN;
  }

  function chipClass(value) {
    return CLASS_BY_STATE[stateOf(value)];
  }

  function chipText(name, value) {
    return name + " · " + stateOf(value);
  }

  function isFailing(value) {
    return FAILING[stateOf(value)] === true;
  }

  function pad(number) {
    return (number < 10 ? "0" : "") + number;
  }

  /* ``checked_at`` 是 ISO 时间戳，显示成本地时间；解析不出来就不显示这一行。 */
  function localTime(iso) {
    if (!iso) return "";
    var parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return "";
    return (
      parsed.getFullYear() + "-" + pad(parsed.getMonth() + 1) + "-" + pad(parsed.getDate()) +
      " " + pad(parsed.getHours()) + ":" + pad(parsed.getMinutes()) + ":" + pad(parsed.getSeconds())
    );
  }

  /* 悬停文案：没有失败就是空字符串（"没有失败则不显示"）。 */
  function chipTitle(name, value, entry) {
    if (!isFailing(value)) return "";
    var detail = entry || {};
    var lines = [name + " · " + stateOf(value)];
    lines.push("原因：" + (detail.reason ? String(detail.reason) : NO_REASON_TEXT));
    if (typeof detail.latency_ms === "number") {
      lines.push("耗时：" + Math.round(detail.latency_ms) + " ms");
    }
    var when = localTime(detail.checked_at);
    if (when) lines.push("结论时刻：" + when + (detail.cached ? "（复用缓存结论）" : ""));
    else if (detail.cached) lines.push("结论来自缓存");
    return lines.join("\n");
  }

  /* 一格徽标的三个呈现字段：一次算完，app.js 只负责贴到 DOM 上。 */
  function chip(name, value, entry) {
    return {
      className: chipClass(value),
      text: chipText(name, value),
      title: chipTitle(name, value, entry)
    };
  }

  /* paperbox 不可达（BFF 连不上它）：全格涂红并说明原因，别假装是某个依赖坏了。 */
  function unreachable(name, message) {
    return {
      className: CLASS_BY_STATE[ERROR],
      text: name + " · " + UNREACHABLE_TEXT,
      title: "paperbox " + UNREACHABLE_TEXT + (message ? "：" + message : "")
    };
  }

  function degradedText(payload) {
    return payload && payload.degraded === true ? DEGRADED_TEXT : "";
  }

  return {
    STATES: STATES,
    OK: OK,
    ERROR: ERROR,
    DISABLED: DISABLED,
    UNKNOWN: UNKNOWN,
    PENDING_CLASS: PENDING_CLASS,
    DEGRADED_TEXT: DEGRADED_TEXT,
    UNREACHABLE_TEXT: UNREACHABLE_TEXT,
    NO_REASON_TEXT: NO_REASON_TEXT,
    stateOf: stateOf,
    chipClass: chipClass,
    chipText: chipText,
    chipTitle: chipTitle,
    chip: chip,
    isFailing: isFailing,
    localTime: localTime,
    unreachable: unreachable,
    degradedText: degradedText
  };
});
