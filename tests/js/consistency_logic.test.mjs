/* paperbox 控制台：一致性 Tab 的纯逻辑测试（node:test，真跑，不做字符串断言）。
 *
 * 覆盖两件容易出错、又只影响显示的事：
 *   1. 问题码映射要盖住 paperbox 定义的全部 9 个码 —— 少一个就把英文码甩给使用者；
 *   2. 0.4.1 的 embedding 模型普查要能摊平成表格、并认出"换模型只换一半"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CL = require("../../webui/static/consistency-logic.js");

test("every issue code paperbox can return has a Chinese label", () => {
  // 取自 paperbox app/services/consistency_service.py 的 ISSUE_* 常量
  const codes = [
    "missing_object",
    "orphan_object",
    "missing_chunks",
    "missing_index",
    "orphan_index",
    "chunk_count_mismatch",
    "deleted_paper_residue",
    "parser_stamp_mismatch",
    "embedding_model_mismatch"
  ];
  codes.forEach((code) => {
    const label = CL.issueLabel(code);
    assert.notEqual(label, code, `${code} 还没翻译`);
    assert.ok(label.length > 0);
  });
  assert.equal(CL.issueLabel("embedding_model_mismatch"), "向量模型不一致（换模型只换一半）");
  assert.equal(CL.issueLabel("parser_stamp_mismatch"), "解析后端戳不一致");
});

test("an unknown issue code falls back to the raw code instead of disappearing", () => {
  assert.equal(CL.issueLabel("brand_new_code"), "brand_new_code");
  assert.equal(CL.issueLabel(""), "");
  assert.equal(CL.issueLabel(null), "");
});

test("the census is flattened in scope order, biggest first", () => {
  assert.deepEqual(
    CL.censusRows({
      chunks: { "intfloat/multilingual-e5-large": 2302 },
      documents: { "intfloat/multilingual-e5-large": 2302 }
    }),
    [
      ["chunks", "intfloat/multilingual-e5-large", 2302],
      ["documents", "intfloat/multilingual-e5-large", 2302]
    ]
  );

  const mixed = CL.censusRows({
    chunks: { small: 3, big: 100 },
    documents: { big: 100 }
  });
  assert.deepEqual(mixed[0], ["chunks", "big", 100]);
  assert.deepEqual(mixed[1], ["chunks", "small", 3]);
  assert.deepEqual(mixed[2], ["documents", "big", 100]);
});

test("the census tolerates a thin or empty payload", () => {
  assert.deepEqual(CL.censusRows({}), []);
  assert.deepEqual(CL.censusRows(null), []);
  assert.deepEqual(CL.censusRows({ chunks: null, documents: {} }), []);
  // 空模型名归 unknown，而不是显示成空字符串
  assert.deepEqual(CL.censusRows({ chunks: { "": 5 } }), [["chunks", "unknown", 5]]);
  // 计数为 0 也照实显示（0 与"没有这个模型"是两件事）
  assert.deepEqual(CL.censusRows({ chunks: { m: 0 } }), [["chunks", "m", 0]]);
});

test("a census spanning two models warns about a half-finished switch", () => {
  const clean = CL.censusWarning({
    chunks: { "model-a": 2302 },
    documents: { "model-a": 2302 }
  });
  assert.equal(clean, null);

  const half = CL.censusWarning({
    chunks: { "model-a": 2000, "model-b": 302 },
    documents: { "model-a": 2000, "model-b": 302 }
  });
  assert.match(half, /2 个向量模型/);
  assert.match(half, /重嵌/);

  const withUnknown = CL.censusWarning({
    chunks: { "model-a": 2000, unknown: 10 },
    documents: { "model-a": 2000, unknown: 10 }
  });
  assert.match(withUnknown, /unknown/);

  assert.equal(CL.censusWarning({}), null);
});

test("per-paper models are joined for the row, empty becomes a dash", () => {
  assert.equal(CL.paperModelsText(["model-a"]), "model-a");
  assert.equal(CL.paperModelsText(["model-a", "model-b"]), "model-a / model-b");
  assert.equal(CL.paperModelsText([]), "—");
  assert.equal(CL.paperModelsText(null), "—");
  assert.equal(CL.paperModelsText(["", null, "model-a"]), "model-a");
});

/* ---------------- DOI 镜像审计的漂移类型映射 ---------------- */

test("driftLabel covers every DRIFT_KINDS value paperbox emits", () => {
  // app/services/identifier_mirror_audit.py 的 DRIFT_KINDS
  for (const kind of [
    "mirror_without_identifier",
    "identifier_without_mirror",
    "value_mismatch",
    "duplicate_identifier",
    "orphan_identifier",
    "missing_normalized_value"
  ]) {
    assert.ok(CL.DRIFT_KIND_LABELS[kind], kind);
    assert.notEqual(CL.driftLabel(kind), kind, kind);
  }
});

test("driftLabel passes an unknown code through unchanged", () => {
  assert.equal(CL.driftLabel("some_future_kind"), "some_future_kind");
  assert.equal(CL.driftLabel(null), "");
});
