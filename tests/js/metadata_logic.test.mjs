/* paperbox 控制台：元数据导入报告的纯逻辑测试（node:test）。
 *
 * 三组用例，各自对应一次真机翻车：
 *   1. 分页：一次导入可能有 5933 条来源，不能全铺；默认每页 5 条（冲突 3 条）、可改，
 *      最后一页不能空、页码越界要夹住。
 *   2. 优先级：未匹配 → 歧义 → 其余，需要人动手的排前面；同组内保持 paperbox 的顺序。
 *   3. 行规格：**长度恒为 4**。真机上出现过"表头 4 列、内容 5 列、中间多一个 —"，
 *      根因是单元格在渲染里逐个 append、多一个少一个没人管。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ML = require("../../webui/static/metadata-logic.js");

const sources = (count) =>
  Array.from({ length: count }, (_, index) => ({
    source_ref: `doi:10.1/${index}`,
    match_status: "matched",
    match_method: "doi"
  }));

test("sources default to 5 per page and conflicts to 3", () => {
  assert.equal(ML.SOURCES_PAGE_SIZE, 5);
  assert.equal(ML.CONFLICTS_PAGE_SIZE, 3);

  assert.equal(ML.paginate(sources(40), 1, ML.SOURCES_PAGE_SIZE).rows.length, 5);
  assert.equal(ML.paginate(sources(40), 1, ML.CONFLICTS_PAGE_SIZE).rows.length, 3);
});

test("pagination reports the window and the page count", () => {
  const result = ML.paginate(sources(12), 2, 5);

  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 3);
  assert.equal(result.first, 6);
  assert.equal(result.last, 10);
  assert.equal(result.total, 12);
  assert.equal(result.rows.length, 5);
});

test("the last page holds the remainder instead of going empty", () => {
  const result = ML.paginate(sources(12), 3, 5);

  assert.equal(result.rows.length, 2);
  assert.equal(result.first, 11);
  assert.equal(result.last, 12);
});

test("an out-of-range page is clamped, not honoured", () => {
  assert.equal(ML.paginate(sources(12), 99, 5).page, 3);
  assert.equal(ML.paginate(sources(12), 0, 5).page, 1);
  assert.equal(ML.paginate(sources(12), -4, 5).page, 1);
  assert.equal(ML.paginate([], 3, 5).pageCount, 1, "空列表也算一页，别显示 第 0/0 页");
});

test("a broken page size falls back to the default", () => {
  assert.equal(ML.paginate(sources(10), 1, 0).pageSize, ML.SOURCES_PAGE_SIZE);
  assert.equal(ML.paginate(sources(10), 1, "abc").pageSize, ML.SOURCES_PAGE_SIZE);
  assert.equal(ML.paginate(sources(11), 1, 10).pageCount, 2);
});

test("pageSummary spells out the window, the total and the page", () => {
  const line = ML.pageSummary(ML.paginate(sources(5933), 1, 5));

  assert.match(line, /第 1–5 条/);
  assert.match(line, /共 5933 条/);
  assert.match(line, /第 1\/1187 页/);
  assert.equal(ML.pageSummary(ML.paginate([], 1, 5)), "共 0 条");
});

test("unmatched and ambiguous rows come first, stably", () => {
  const items = [
    { source_ref: "a", match_status: "matched" },
    { source_ref: "b", match_status: "unmatched" },
    { source_ref: "c", match_status: "ambiguous" },
    { source_ref: "d", match_status: "matched" },
    { source_ref: "e", match_status: "unmatched" }
  ];

  const sorted = ML.sortForReview(items).map((item) => item.source_ref);

  /* unmatched 组（b, e）→ ambiguous（c）→ 其余按原顺序（a, d） */
  assert.deepEqual(sorted, ["b", "e", "c", "a", "d"]);
});

test("sortForReview tolerates a missing status and junk input", () => {
  assert.deepEqual(ML.sortForReview(undefined), []);
  const sorted = ML.sortForReview([
    { source_ref: "x" },
    { source_ref: "y", match_status: "unmatched" }
  ]);
  assert.deepEqual(sorted.map((item) => item.source_ref), ["y", "x"]);
  assert.equal(ML.priorityOf("UNMATCHED"), 0, "状态大小写不该影响优先级");
  assert.equal(ML.priorityOf(undefined), 2);
});

test("a source row is exactly four cells -- no phantom 来源类型 column", () => {
  const row = ML.sourcesRow({
    source_ref: "doi:10.1/x",
    match_status: "matched",
    match_method: "doi",
    paper_id: "p-1",
    /* 就算 paperbox 以后真给了 source_type，也不该变成第 5 格 */
    source_type: "ieee_api"
  });

  assert.equal(row.length, 4);
  assert.equal(row[0].text, "doi:10.1/x");
  assert.equal(row[1].text, "已匹配");
  assert.equal(row[2].text, "doi");
  assert.equal(row[3].kind, "paper");
  assert.ok(
    row.every((cell) => cell.text !== "ieee_api"),
    "来源类型只出现在摘要行，不进表格"
  );
});

test("an unmatched source row shows the note where the paper would be", () => {
  const row = ML.sourcesRow({ source_ref: "x", match_status: "unmatched", note: "no candidate" });

  assert.equal(row.length, 4);
  assert.equal(row[1].text, "未匹配");
  assert.equal(row[2].text, "—");
  assert.equal(row[3].kind, "note");
  assert.equal(row[3].text, "no candidate");
});

test("a conflict row is exactly five cells and flattens list values", () => {
  /* 第 5 格是操作列（采纳被拒值 / 保留现值），带裁决需要的 paper_id/field/provenance_id。 */
  const row = ML.conflictRow({
    paper_id: "p-1",
    field: "authors",
    kept: ["Lei Wang", "Yuanzi Li"],
    rejected: "single",
    provenance_id: "claim-9"
  });

  assert.equal(row.length, 5);
  assert.equal(row[1].text, "authors");
  assert.equal(row[2].text, "Lei Wang, Yuanzi Li");
  assert.equal(row[3].text, "single");
  assert.equal(row[4].kind, "actions");
  assert.deepEqual(
    { p: row[4].paperId, f: row[4].field, id: row[4].provenanceId },
    { p: "p-1", f: "authors", id: "claim-9" }
  );
});

test("a conflict from a dry-run report has no claim to act on", () => {
  /* 导入报告里的冲突来自试运行，还没落库：没有 provenance_id，界面据此不给按钮。 */
  const row = ML.conflictRow({ paper_id: "p-1", field: "year", kept: 2024, rejected: 2014 });

  assert.equal(row.length, 5);
  assert.equal(row[4].kind, "actions");
  assert.equal(row[4].provenanceId, "");
});

test("missing values read as — rather than empty cells", () => {
  const row = ML.conflictRow({});

  assert.equal(row.length, 5);
  assert.equal(row[1].text, "—");
  assert.equal(row[2].text, "—");
  assert.equal(ML.valueText(null), "—");
  assert.equal(ML.valueText({ a: 1 }), '{"a":1}');
});

test("reportSummary carries the source type that the response does not", () => {
  const line = ML.reportSummary(
    { dry_run: true, format: "ieee_raw", detected: 1103, matched: 1102, failed: 1 },
    "ieee_api"
  );

  assert.match(line, /来源 ieee_api/);
  assert.match(line, /格式 ieee_raw/);
  assert.match(line, /检测到 1103 条/);
  assert.match(line, /命中已有论文 1102 条/);
  assert.match(line, /失败 1 条/);
});

test("reportSummary leaves 试运行 to the chip -- no duplicate phrasing", () => {
  /* 真机上一次是"试运行（未写库） · 试运行（未写库） · 来源 …"：chip 与摘要各说一遍。 */
  const line = ML.reportSummary({ dry_run: true, format: "generic", detected: 12 }, "import_file");

  assert.doesNotMatch(line, /试运行/);
  assert.doesNotMatch(line, /已写入/);
});

test("reportSummary does not call a shell-creation run a total miss", () => {
  /* paperbox 的 matched 是"命中已有论文"，造壳不算。只显示"匹配 0 条"会吓人。 */
  const line = ML.reportSummary(
    { dry_run: true, format: "generic", detected: 12, matched: 0, created_shell: 12 },
    "import_file"
  );

  assert.match(line, /待补文件的新壳 12 条/);
  assert.doesNotMatch(line, /命中已有论文/);
});

test("reportSummary does not mention failures when there are none", () => {
  const line = ML.reportSummary({ dry_run: false, format: "csl", detected: 5, matched: 5 }, "import_file");

  assert.doesNotMatch(line, /失败/);
  assert.match(line, /命中已有论文 5 条/);
});

test("matchLabel translates the statuses paperbox actually returns", () => {
  assert.equal(ML.matchLabel("matched"), "已匹配");
  assert.equal(ML.matchLabel("ambiguous"), "歧义");
  assert.equal(ML.matchLabel("unmatched"), "未匹配");
  assert.equal(ML.matchLabel(undefined), "—");
  assert.equal(ML.matchLabel("something_new"), "something_new", "未知状态原样显示，不能吞掉");
});
