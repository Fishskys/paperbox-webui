/* paperbox 控制台：元数据导入报告的纯逻辑测试（node:test）。
 *
 * 为什么单独有这么一个模块：报告一次可能带 5000+ 行来源（真机 IEEE 批次 5933 条），
 * 全铺出来会把下面的复核清单、批量应用顶出屏幕；而"截了多少"必须如实说出来，
 * 不能悄悄吞掉。另外「来源类型」这一列曾经永远是空的 —— paperbox 的
 * /api/metadata/import 响应里根本没有 source_type 字段，它只该出现在摘要行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ML = require("../../webui/static/metadata-logic.js");

test("capRows keeps the head and reports exactly how many are hidden", () => {
  const items = Array.from({ length: 5933 }, (_, index) => ({ source_ref: `doi:${index}` }));

  const capped = ML.capRows(items, 50);

  assert.equal(capped.rows.length, 50);
  assert.equal(capped.hidden, 5883);
  assert.equal(capped.total, 5933, "总数必须保留，界面靠它说明截断");
  assert.equal(capped.rows[0].source_ref, "doi:0");
});

test("capRows is a no-op when the report is short", () => {
  const capped = ML.capRows([{ a: 1 }, { a: 2 }], 50);

  assert.equal(capped.rows.length, 2);
  assert.equal(capped.hidden, 0);
  assert.equal(ML.hiddenNote(capped.hidden, capped.total, "来源"), "", "没截断就不该有提示行");
});

test("capRows survives missing or junk input", () => {
  assert.deepEqual(ML.capRows(undefined, 50).rows, []);
  assert.equal(ML.capRows(null, 50).total, 0);
  assert.equal(ML.capRows([1, 2, 3], 0).rows.length, 3, "limit 非法时退回默认上限");
});

test("hiddenNote says how many and out of what", () => {
  const note = ML.hiddenNote(5883, 5933, "来源");

  assert.match(note, /5883/);
  assert.match(note, /5933/);
  assert.match(note, /来源/);
});

test("reportSummary carries the source type that the response does not", () => {
  const line = ML.reportSummary(
    { dry_run: true, format: "ieee_raw", detected: 1103, matched: 1102, failed: 1 },
    "ieee_api"
  );

  assert.match(line, /试运行/);
  assert.match(line, /来源 ieee_api/);
  assert.match(line, /格式 ieee_raw/);
  assert.match(line, /检测到 1103 条/);
  assert.match(line, /失败 1 条/);
});

test("reportSummary does not mention failures when there are none", () => {
  const line = ML.reportSummary({ dry_run: false, format: "csl", detected: 5, matched: 5, failed: 0 }, "import_file");

  assert.match(line, /已写入/);
  assert.doesNotMatch(line, /失败/);
});

test("matchLabel translates the statuses paperbox actually returns", () => {
  assert.equal(ML.matchLabel("matched"), "已匹配");
  assert.equal(ML.matchLabel("ambiguous"), "歧义");
  assert.equal(ML.matchLabel("unmatched"), "未匹配");
  assert.equal(ML.matchLabel(undefined), "—");
});

test("an unknown status is shown as-is instead of vanishing", () => {
  /* paperbox 加了新状态时，界面宁可显示英文原值，也不能显示成空。 */
  assert.equal(ML.matchLabel("something_new"), "something_new");
});
