/* paperbox 控制台：「重建全库索引」的纯逻辑测试（node:test）。
 *
 * 这块的风险不是算法，而是**话说得准不准**：要让主人点确认之前就知道影响面（几篇、为什么），
 * 而"什么都不用重建"也必须说清楚，不能被糊成"正在忙"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RL = require("../../webui/static/reindex-logic.js");

const driftReport = {
  dry_run: true,
  selected: 30,
  reasons: [
    { code: "embedding_model_changed", detail: "换模型", papers: 30, scope: "all" }
  ],
  skipped_reasons: [],
  embedding: {
    configured: "intfloat/multilingual-e5-large",
    seen: { "BAAI/bge-m3": 2302 },
    drifted: true
  },
  parser: { configured: "docling", stamps: { docling: 30 }, stale: 0 }
};

test("a model change reads as a whole-library rebuild", () => {
  const lines = RL.reasonLines(driftReport, "reasons");

  assert.equal(lines.length, 1);
  assert.match(lines[0], /embedding 模型变了/);
  assert.match(lines[0], /30 篇/);
  assert.match(lines[0], /整库/);
});

test("a subset reason is distinguished from a whole-library one", () => {
  const report = {
    reasons: [{ code: "open_degradations", detail: "x", papers: 2, scope: "subset" }]
  };

  assert.match(RL.reasonLines(report, "reasons")[0], /部分/);
});

test("an unknown reason code is shown as-is instead of vanishing", () => {
  const report = { reasons: [{ code: "brand_new_reason", papers: 1, scope: "subset" }] };

  assert.match(RL.reasonLines(report, "reasons")[0], /brand_new_reason/);
  assert.equal(RL.reasonLabel("open_degradations"), "上次流水线让步且未解决");
});

test("the confirm button states the blast radius, not 'OK'", () => {
  assert.equal(RL.confirmLabel(driftReport), "确认：排队重建这 30 篇");
  assert.equal(RL.confirmLabel({ selected: 0 }), "没有需要重建的");
  assert.equal(RL.selectedCount({ selected: 0 }), 0);
  assert.equal(RL.selectedCount(undefined), 0);
});

test("nothing to rebuild is said plainly", () => {
  const note = RL.previewNote({ selected: 0 });

  assert.match(note, /没有需要重建/);
  assert.doesNotMatch(note, /个小时|小时级/);
});

test("a pending rebuild says what happens next, including the cost", () => {
  const note = RL.previewNote({ selected: 12 });

  assert.match(note, /12 篇/);
  assert.match(note, /串行/);
  assert.match(note, /小时级/);
});

test("the census explains why it said 'no rebuild needed'", () => {
  const lines = RL.censusLines({
    embedding: { configured: "intfloat/multilingual-e5-large", seen: { "intfloat/multilingual-e5-large": 2302 }, drifted: false },
    parser: { configured: "docling", stamps: { docling: 30, pypdf: 2 }, stale: 2 }
  });

  assert.match(lines[0], /intfloat\/multilingual-e5-large/);
  assert.match(lines[0], /一致/);
  assert.match(lines[1], /x2302/);
  assert.match(lines[2], /有 2 篇戳不同/);
  assert.match(lines[3], /pypdf x2/);
});

test("a drifted census says so, and a missing stamp reads as (无戳)", () => {
  const lines = RL.censusLines({
    embedding: { configured: "new-model", seen: { "": 5, "old-model": 2 }, drifted: true },
    parser: {}
  });

  assert.match(lines[0], /与索引里的不一致/);
  assert.match(lines[1], /\(无戳\) x5/);
  assert.match(lines[1], /old-model x2/);
});

test("skipped papers are counted so the preview can warn", () => {
  assert.equal(RL.skippedCount({ skipped: [{ paper_id: "a", reason: "x" }] }), 1);
  assert.equal(RL.skippedCount({}), 0);
});
