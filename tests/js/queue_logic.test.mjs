/* 上传队列纯逻辑的 node:test 用例（node --test tests/js/）。
 *
 * 这份文件是并发 / 429 退避 / 两阶段进度的"真测试"：app.js 里的 DOM 部分仍然只有
 * 字符串守卫，但所有会算错的规则都落在这里，可以真跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const queue = require("../../webui/static/queue-logic.js");

/* ---------------- parseRetryAfter ---------------- */

test("parseRetryAfter reads the seconds paperbox actually sends", () => {
  assert.equal(queue.parseRetryAfter("2"), 2);
  assert.equal(queue.parseRetryAfter(" 3 "), 3);
  assert.equal(queue.parseRetryAfter("0"), 0);
  assert.equal(queue.parseRetryAfter("2.5"), 2.5);
  assert.equal(queue.parseRetryAfter(4), 4);
});

test("parseRetryAfter rejects dates, junk and negatives", () => {
  assert.equal(queue.parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(queue.parseRetryAfter(""), null);
  assert.equal(queue.parseRetryAfter("   "), null);
  assert.equal(queue.parseRetryAfter("soon"), null);
  assert.equal(queue.parseRetryAfter("-1"), null);
  assert.equal(queue.parseRetryAfter(-1), null);
  assert.equal(queue.parseRetryAfter(null), null);
  assert.equal(queue.parseRetryAfter(undefined), null);
  assert.equal(queue.parseRetryAfter({}), null);
});

/* ---------------- retryDelayMs ---------------- */

test("retryDelayMs prefers Retry-After over the exponential ladder", () => {
  const opts = { baseMs: 2000, capMs: 60000, random: () => 0 };
  assert.equal(queue.retryDelayMs(1, "2", opts), 2000);
  assert.equal(queue.retryDelayMs(4, "2", opts), 2000, "attempt is ignored when the server answered");
  assert.equal(queue.retryDelayMs(1, 0, opts), 0, "Retry-After: 0 means retry now");
  assert.equal(queue.retryDelayMs(1, "600", opts), 60000, "Retry-After is capped too");
});

test("retryDelayMs doubles without a header and stays inside the jitter band", () => {
  const noJitter = { baseMs: 2000, capMs: 60000, jitter: 0, random: () => 0 };
  assert.equal(queue.retryDelayMs(1, null, noJitter), 2000);
  assert.equal(queue.retryDelayMs(2, null, noJitter), 4000);
  assert.equal(queue.retryDelayMs(3, null, noJitter), 8000);
  assert.equal(queue.retryDelayMs(4, undefined, noJitter), 16000);

  const maxJitter = { baseMs: 2000, capMs: 60000, jitter: 0.25, random: () => 1 };
  assert.equal(queue.retryDelayMs(3, null, maxJitter), 10000, "8000 × 1.25");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const base = 2000 * 2 ** (attempt - 1);
    const delay = queue.retryDelayMs(attempt, null, { baseMs: 2000, capMs: 60000 });
    assert.ok(delay >= base && delay <= base * 1.25, `attempt ${attempt}: ${delay}`);
  }
});

test("retryDelayMs caps the ladder and tolerates a missing attempt", () => {
  const opts = { baseMs: 2000, capMs: 60000, jitter: 0, random: () => 0 };
  assert.equal(queue.retryDelayMs(20, null, opts), 60000);
  assert.equal(queue.retryDelayMs(undefined, null, opts), 2000);
  assert.equal(queue.retryDelayMs(0, null, opts), 2000, "attempt is 1-based");
});

/* ---------------- summarizeProgress ---------------- */

test("summarizeProgress counts an empty queue", () => {
  assert.deepEqual(queue.summarizeProgress([]), {
    total: 0,
    toUpload: 0,
    uploaded: 0,
    submitted: 0,
    terminal: 0,
    failed: 0
  });
  assert.equal(queue.summarizeProgress(undefined).total, 0);
});

test("summarizeProgress keeps the two phases apart", () => {
  const items = [
    { kind: "file", status: "done", jobId: "j1", jobDone: true },
    { kind: "file", status: "processing", jobId: "j2", jobDone: false },
    { kind: "file", status: "uploading", jobId: null, jobDone: false },
    { kind: "file", status: "pending", jobId: null, jobDone: false },
    { kind: "file", status: "failed", jobId: "j3", jobDone: true },
    { kind: "url", status: "processing", jobId: "j4", jobDone: false }
  ];
  assert.deepEqual(queue.summarizeProgress(items), {
    total: 6,
    toUpload: 5,
    uploaded: 3,
    submitted: 4,
    terminal: 2,
    failed: 1
  });
});

test("summarizeProgress drops canceled files from the upload denominator", () => {
  const items = [
    { kind: "file", status: "canceled", jobId: null },
    { kind: "file", status: "done", jobId: "j1", jobDone: true },
    { kind: "url", status: "done", jobId: "j2", jobDone: true }
  ];
  const summary = queue.summarizeProgress(items);
  assert.equal(summary.total, 3);
  assert.equal(summary.toUpload, 1, "a canceled file will never be uploaded");
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.submitted, 2, "URL submissions are jobs too");
  assert.equal(summary.terminal, 2);
});

test("summarizeProgress separates an upload failure from a job failure", () => {
  const items = [
    { kind: "file", status: "failed", jobId: null, error: "服务端持续繁忙（429）" },
    { kind: "file", status: "failed", jobId: "j1", jobDone: true }
  ];
  const summary = queue.summarizeProgress(items);
  assert.equal(summary.failed, 2);
  assert.equal(summary.uploaded, 1, "only the second one ever reached paperbox");
  assert.equal(summary.terminal, 1);
});

/* ---------------- uploadSlots ---------------- */

test("uploadSlots hands out at most `slots` pending items", () => {
  const items = [
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
    { id: "c", status: "pending" }
  ];
  assert.deepEqual(queue.uploadSlots(items, 2, 1000).map((item) => item.id), ["a", "b"]);
  assert.deepEqual(queue.uploadSlots(items, 3, 1000).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(queue.uploadSlots(items, 0, 1000), []);
  assert.deepEqual(queue.uploadSlots(items, -1, 1000), []);
});

test("uploadSlots skips everything that is not pending", () => {
  const items = [
    { id: "up", status: "uploading" },
    { id: "sub", status: "submitted" },
    { id: "run", status: "processing" },
    { id: "done", status: "done" },
    { id: "bad", status: "failed" },
    { id: "ok", status: "pending" }
  ];
  assert.deepEqual(queue.uploadSlots(items, 4, 1000).map((item) => item.id), ["ok"]);
});

test("uploadSlots skips items still backing off", () => {
  const items = [
    { id: "waiting", status: "pending", retryAt: 5000 },
    { id: "ready", status: "pending", retryAt: 1000 },
    { id: "fresh", status: "pending" }
  ];
  assert.deepEqual(
    queue.uploadSlots(items, 3, 2000).map((item) => item.id),
    ["ready", "fresh"]
  );
  assert.deepEqual(
    queue.uploadSlots(items, 3, 5000).map((item) => item.id),
    ["waiting", "ready", "fresh"],
    "retryAt == now is due"
  );
});

/* ---------------- shouldSuggestServerSide ---------------- */

test("shouldSuggestServerSide fires at the threshold only", () => {
  assert.equal(queue.shouldSuggestServerSide(20, 20), true);
  assert.equal(queue.shouldSuggestServerSide(21, 20), true);
  assert.equal(queue.shouldSuggestServerSide(19, 20), false);
  assert.equal(queue.shouldSuggestServerSide(0, 20), false);
  assert.equal(queue.shouldSuggestServerSide(5, 0), false, "a disabled threshold never fires");
  assert.equal(queue.shouldSuggestServerSide(undefined, 20), false);
});
