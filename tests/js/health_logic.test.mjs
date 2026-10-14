/* paperbox 控制台：顶部状态条依赖徽标的纯逻辑测试（node:test，真跑，不做字符串断言）。
 *
 * 覆盖四件"算错就会骗人"的事：
 *   1. 四种状态各一色（ok/error/disabled/unknown），认不出的值按 unknown —— 宁可黄，不要假绿；
 *   2. 悬停只有失败（error / unknown）才有内容，ok / disabled 一律空；
 *   3. 悬停里的结论时刻用 paperbox 的 checked_at（不是浏览器取回的时刻），缓存命中要写明；
 *   4. degraded 只在 true 时说话；paperbox 不可达时全格红并给原因。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HL = require("../../webui/static/health-logic.js");

const FAILING_ENTRY = {
  status: "error",
  required: true,
  latency_ms: 185.2,
  checked_at: "2026-10-14T12:47:06+00:00",
  cached: true,
  reason: 'HTTP 401: {"error":{"message":"Invalid API-key provided."}}'
};

test("the four states paperbox can report are all recognised", () => {
  // 取自 paperbox app/services/health_service.py 的 OK/ERROR/DISABLED/UNKNOWN 常量
  assert.deepEqual(HL.STATES, ["ok", "error", "disabled", "unknown"]);
  ["ok", "error", "disabled", "unknown"].forEach((state) => {
    assert.equal(HL.stateOf(state), state, state);
  });
});

test("an unrecognised value is painted as unknown, never as ok", () => {
  [undefined, null, "", "OK", "green", 200, {}, []].forEach((value) => {
    assert.equal(HL.stateOf(value), "unknown", String(value));
    assert.equal(HL.chipClass(value), "chip chip-unknown", String(value));
    assert.notEqual(HL.chipClass(value), "chip chip-ok");
  });
});

test("each state gets its own class", () => {
  assert.equal(HL.chipClass("ok"), "chip chip-ok");
  assert.equal(HL.chipClass("error"), "chip chip-error");
  assert.equal(HL.chipClass("disabled"), "chip chip-disabled");
  assert.equal(HL.chipClass("unknown"), "chip chip-unknown");
});

test("chip text is name plus the state paperbox reported", () => {
  assert.equal(HL.chipText("postgres", "ok"), "postgres · ok");
  assert.equal(HL.chipText("docling", "disabled"), "docling · disabled");
  assert.equal(HL.chipText("rerank", undefined), "rerank · unknown");
});

test("only failing states have something to hover", () => {
  assert.equal(HL.chipTitle("postgres", "ok", FAILING_ENTRY), "");
  assert.equal(HL.chipTitle("docling", "disabled", undefined), "");
  assert.equal(HL.isFailing("ok"), false);
  assert.equal(HL.isFailing("disabled"), false);
  assert.equal(HL.isFailing("error"), true);
  // unknown 也是要人看一眼的：容器答得上话但还不能干活
  assert.equal(HL.isFailing("unknown"), true);
});

test("the tooltip carries the reason, the latency and paperbox's checked_at", () => {
  const title = HL.chipTitle("embedding", "error", FAILING_ENTRY);

  assert.match(title, /^embedding · error/);
  assert.ok(title.includes("Invalid API-key provided"), title);
  assert.ok(title.includes("185 ms"), title);
  // checked_at 是 paperbox 的结论时刻，缓存命中要写明（"查得新"不等于"结论新"）
  assert.ok(title.includes("复用缓存结论"), title);
  assert.match(title, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("a failing dependency without a reason still names who is silent", () => {
  const title = HL.chipTitle("opensearch", "unknown", { status: "unknown" });

  assert.ok(title.includes(HL.NO_REASON_TEXT), title);
});

test("a NON-cached failing verdict does not claim to be cached", () => {
  const title = HL.chipTitle("minio", "error", {
    reason: "S3Error: access denied",
    latency_ms: 14,
    checked_at: "2026-10-14T12:47:06+00:00",
    cached: false
  });

  assert.ok(title.includes("S3Error"), title);
  assert.ok(!title.includes("缓存"), title);
});

test("chip() bundles the three presentation fields", () => {
  const view = HL.chip("embedding", "error", FAILING_ENTRY);

  assert.deepEqual(Object.keys(view).sort(), ["className", "text", "title"]);
  assert.equal(view.className, "chip chip-error");
  assert.equal(view.text, "embedding · error");
  assert.ok(view.title.includes("原因："), view.title);
  // 健康的一格：没有 title，界面因此不会显示悬停
  assert.equal(HL.chip("embedding", "ok", FAILING_ENTRY).title, "");
});

test("checked_at is rendered in local time and back-parses to the same instant", () => {
  const iso = "2026-10-14T12:47:06+00:00";
  const rendered = HL.localTime(iso);

  assert.match(rendered, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(new Date(rendered.replace(" ", "T")).getTime(), new Date(iso).getTime());
  // 解析不出来就不显示这一行，而不是显示 "Invalid Date"
  assert.equal(HL.localTime("not-a-date"), "");
  assert.equal(HL.localTime(undefined), "");
});

test("degraded is only spoken when paperbox says it is true", () => {
  assert.equal(HL.degradedText({ degraded: true }), HL.DEGRADED_TEXT);
  assert.equal(HL.degradedText({ degraded: false }), "");
  assert.equal(HL.degradedText({}), "");
  assert.equal(HL.degradedText(null), "");
  assert.equal(HL.degradedText({ degraded: "yes" }), "");
});

test("an unreachable paperbox paints every chip red with the message", () => {
  const view = HL.unreachable("postgres", "unreachable: ConnectError");

  assert.equal(view.className, "chip chip-error");
  assert.equal(view.text, "postgres · 不可用");
  assert.ok(view.title.includes("ConnectError"), view.title);
  assert.equal(HL.unreachable("postgres").title, "paperbox 不可用");
});
