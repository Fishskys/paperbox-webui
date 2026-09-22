/* 任务列表纯逻辑的 node:test 用例（node --test tests/js/）。
 *
 * 服务端分页的页数换算与耗时文案是"会算错"的部分，所以它们有真测试；
 * app.js 里的 DOM 渲染仍然只有字符串守卫。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jobs = require("../../webui/static/jobs-logic.js");

/* ---------------- durationText ---------------- */

test("durationText measures a finished job in seconds, minutes or hours", () => {
  assert.equal(
    jobs.durationText({ created_at: "2026-09-23T10:00:00Z", finished_at: "2026-09-23T10:00:12.5Z" }),
    "12.5 s"
  );
  assert.equal(
    jobs.durationText({ created_at: "2026-09-23T10:00:00Z", finished_at: "2026-09-23T10:02:30Z" }),
    "2.5 min"
  );
  assert.equal(
    jobs.durationText({ created_at: "2026-09-23T10:00:00Z", finished_at: "2026-09-23T12:00:00Z" }),
    "2.0 h"
  );
});

test("durationText says 进行中 while the job has no finished_at", () => {
  assert.equal(jobs.durationText({ created_at: "2026-09-23T10:00:00Z", finished_at: null }), "进行中");
  assert.equal(jobs.durationText({ created_at: "2026-09-23T10:00:00Z" }), "进行中");
  assert.equal(jobs.RUNNING, "进行中");
});

test("durationText degrades to a dash without a usable timestamp", () => {
  assert.equal(jobs.durationText(null), "—");
  assert.equal(jobs.durationText({}), "—");
  assert.equal(jobs.durationText({ created_at: "not a date" }), "—");
  assert.equal(
    jobs.durationText({ created_at: "2026-09-23T10:00:00Z", finished_at: "nope" }),
    "—"
  );
});

test("durationText never goes negative when the clock looks wrong", () => {
  assert.equal(
    jobs.durationText({ created_at: "2026-09-23T10:00:10Z", finished_at: "2026-09-23T10:00:00Z" }),
    "0.0 s"
  );
});

/* ---------------- pagerState ---------------- */

test("pagerState converts an offset window into pages", () => {
  const first = jobs.pagerState({ total: 137, limit: 20, offset: 0 });
  assert.equal(first.pages, 7);
  assert.equal(first.page, 1);
  assert.equal(first.canPrev, false);
  assert.equal(first.canNext, true);
  assert.equal(first.label, "第 1 / 7 页");
  assert.equal(first.totalLabel, "共 137 条");

  const third = jobs.pagerState({ total: 137, limit: 20, offset: 40 });
  assert.equal(third.page, 3);
  assert.equal(third.canPrev, true);
  assert.equal(third.canNext, true);
});

test("pagerState clamps the last page and disables next", () => {
  const last = jobs.pagerState({ total: 137, limit: 20, offset: 120 });
  assert.equal(last.pages, 7);
  assert.equal(last.page, 7);
  assert.equal(last.canNext, false, "120 + 20 = 140 >= 137");
});

test("pagerState always reports at least one page", () => {
  const empty = jobs.pagerState({ total: 0, limit: 20, offset: 0 });
  assert.equal(empty.pages, 1);
  assert.equal(empty.page, 1);
  assert.equal(empty.canPrev, false);
  assert.equal(empty.canNext, false);
  assert.equal(empty.totalLabel, "共 0 条");
});

test("pagerState clamps an offset past the end instead of showing page 9/7", () => {
  const beyond = jobs.pagerState({ total: 137, limit: 20, offset: 400 });
  assert.equal(beyond.page, 7);
  assert.equal(beyond.pages, 7);
});

test("pagerState survives junk input", () => {
  const junk = jobs.pagerState({ total: null, limit: 0, offset: -5 });
  assert.equal(junk.limit, 20, "a zero limit falls back to the default page size");
  assert.equal(junk.total, 0);
  assert.equal(junk.offset, 0);
  assert.equal(junk.page, 1);
  assert.equal(jobs.pagerState().pages, 1);
});

/* ---------------- nextOffset ---------------- */

test("nextOffset steps by the page size and never goes below zero", () => {
  assert.equal(jobs.nextOffset(0, 20, "next"), 20);
  assert.equal(jobs.nextOffset(40, 20, "next"), 60);
  assert.equal(jobs.nextOffset(20, 20, "prev"), 0);
  assert.equal(jobs.nextOffset(0, 20, "prev"), 0);
  assert.equal(jobs.nextOffset(10, 20, "prev"), 0);
  assert.equal(jobs.nextOffset(null, null, "next"), 20);
});
