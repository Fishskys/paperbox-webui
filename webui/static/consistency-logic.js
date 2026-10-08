/* paperbox 控制台：一致性 Tab 的纯逻辑（无 DOM、无网络、无依赖）。
 *
 * 同一份文件两个入口：浏览器里挂成 window.PaperboxConsistency，node 里走 module.exports
 * （见 tests/js/consistency_logic.test.mjs）。
 *
 * 与后端的对应关系（paperbox 0.4.1 的 `/api/consistency`）：
 *   - 问题码由 app/services/consistency_service.py 定义，共 9 个：7 个是 2026-09 就有的，
 *     parser_stamp_mismatch 与 embedding_model_mismatch 是之后补的 —— 少一个映射，
 *     界面就会把英文码直接甩给使用者；
 *   - 顶层 `embedding_models.{chunks,documents}` 是 0.4.1 新增的普查：PG 切块行与索引文档
 *     各按产出它们的模型计数，没有记录的归 `unknown`；同一篇论文跨两个已知模型 → mismatch。
 *
 * 不引入任何构建工具（SPEC §4）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PaperboxConsistency = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 问题码 → 中文。键必须覆盖 paperbox 的全部取值（多一个无害，少一个就是漏翻译）。 */
  var ISSUE_LABELS = {
    missing_object: "缺对象",
    orphan_object: "孤儿对象",
    missing_chunks: "缺 chunk 行",
    missing_index: "缺索引文档",
    orphan_index: "孤儿索引文档",
    chunk_count_mismatch: "chunk 数不符",
    deleted_paper_residue: "删除残留",
    parser_stamp_mismatch: "解析后端戳不一致",
    embedding_model_mismatch: "向量模型不一致（换模型只换一半）"
  };

  var UNKNOWN_MODEL = "unknown";

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
  }

  function issueLabel(code) {
    if (isBlank(code)) return "";
    var key = String(code).trim();
    return Object.prototype.hasOwnProperty.call(ISSUE_LABELS, key) ? ISSUE_LABELS[key] : key;
  }

  /* 普查 → 表格行 [[scope, model, count], ...]，chunks 在前、documents 在后，
   * 每个 scope 内按计数从多到少（模型相同的行相邻，便于一眼看出"只换了一半"）。
   * 缺计数、计数为 0 的项照实显示（0 与"没有这个模型"是两件事，别吞掉）。 */
  function censusRows(census) {
    var data = census || {};
    var rows = [];
    ["chunks", "documents"].forEach(function (scope) {
      var counts = data[scope];
      if (!counts || typeof counts !== "object") return;
      Object.keys(counts)
        .sort(function (a, b) {
          var diff = Number(counts[b]) - Number(counts[a]);
          return diff !== 0 ? diff : String(a).localeCompare(String(b));
        })
        .forEach(function (model) {
          rows.push([scope, isBlank(model) ? UNKNOWN_MODEL : String(model), Number(counts[model]) || 0]);
        });
    });
    return rows;
  }

  /* 两个 scope 的模型集合不一致（或某一侧出现 unknown）时值得提醒：
   * 只换了一半、或者有文档早于 embedding_model 字段。返回 null = 没什么可说的。 */
  function censusWarning(census) {
    var rows = censusRows(census);
    if (!rows.length) return null;
    var models = {};
    rows.forEach(function (row) {
      models[row[1]] = true;
    });
    var names = Object.keys(models);
    if (names.length > 1 && names.indexOf(UNKNOWN_MODEL) >= 0) {
      return "有 " + (names.length - 1) + " 个已知模型，另有 unknown（早于 embedding_model 字段的记录）：换模型只换了一部分";
    }
    if (names.length > 1) {
      return "库里同时存在 " + names.length + " 个向量模型：向量不可比，少数派需要重嵌";
    }
    return null;
  }

  /* 单篇论文的 embedding_models（string[]）→ 一行文本；空 = "—"。 */
  function paperModelsText(models) {
    var list = Array.isArray(models) ? models.filter(function (m) {
      return !isBlank(m);
    }) : [];
    if (!list.length) return "—";
    return list.join(" / ");
  }

  return {
    ISSUE_LABELS: ISSUE_LABELS,
    UNKNOWN_MODEL: UNKNOWN_MODEL,
    issueLabel: issueLabel,
    censusRows: censusRows,
    censusWarning: censusWarning,
    paperModelsText: paperModelsText
  };
});
