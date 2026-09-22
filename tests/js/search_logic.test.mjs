/* 检索过滤器纯逻辑的 node:test 用例（node --test tests/js/）。
 *
 * 这份文件是"哪些过滤键真的会被发出去"的真测试：app.js 的 DOM 部分只有字符串守卫，
 * 但空值不发、非法标识符就地拦下、年份解析这些会算错的规则都落在这里，可以真跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const search = require("../../webui/static/search-logic.js");

/* ---------------- 集合本身 ---------------- */

test("SCHEMES matches the schemes paperbox accepts", () => {
  // app/services/metadata_identifiers.py 的 SCHEMES
  for (const scheme of [
    "doi",
    "arxiv",
    "ieee_article_number",
    "issn",
    "isbn",
    "pmid",
    "openalex",
    "semantic_scholar",
    "url",
    "sha256"
  ]) {
    assert.ok(search.SCHEMES.includes(scheme), scheme);
  }
  assert.equal(search.SCHEMES.length, 10, "a new scheme must be added here too");
});

test("PAPER_TYPES matches the stored paper_type values", () => {
  assert.deepEqual(search.PAPER_TYPES, [
    "journal",
    "conference",
    "preprint",
    "early_access",
    "standard"
  ]);
});

/* ---------------- splitList / parseYear ---------------- */

test("splitList accepts both comma flavours and drops blanks", () => {
  assert.deepEqual(search.splitList("a, b"), ["a", "b"]);
  assert.deepEqual(search.splitList("a，b"), ["a", "b"]);
  assert.deepEqual(search.splitList(" a ,, b "), ["a", "b"]);
  assert.deepEqual(search.splitList(""), []);
  assert.deepEqual(search.splitList(null), []);
});

test("parseYear only accepts four digits", () => {
  assert.equal(search.parseYear("2021"), 2021);
  assert.equal(search.parseYear(" 2015 "), 2015);
  assert.equal(search.parseYear("21"), null);
  assert.equal(search.parseYear("20211"), null);
  assert.equal(search.parseYear("abcd"), null);
  assert.equal(search.parseYear(""), null);
  assert.equal(search.parseYear(undefined), null);
});

test("parseYears splits good years from junk", () => {
  assert.deepEqual(search.parseYears("2021, 2022"), { years: [2021, 2022], bad: [] });
  assert.deepEqual(search.parseYears("2021, 20"), { years: [2021], bad: ["20"] });
  assert.deepEqual(search.parseYears("2021,2021"), { years: [2021], bad: [] }, "deduped");
});

/* ---------------- identifiers ---------------- */

test("parseIdentifier accepts scheme:value and folds the scheme", () => {
  assert.deepEqual(search.parseIdentifier("doi:10.1109/JSSC.2020.1"), {
    scheme: "doi",
    value: "10.1109/JSSC.2020.1",
    text: "doi:10.1109/JSSC.2020.1"
  });
  assert.equal(search.parseIdentifier("DOI:10.1/x").text, "doi:10.1/x");
  assert.equal(search.parseIdentifier("ieee_article_number:7065247").text, "ieee_article_number:7065247");
});

test("parseIdentifier rejects a scheme paperbox would 422 on", () => {
  assert.equal(search.parseIdentifier("ieee:7065247"), null, "unknown scheme");
  assert.equal(search.parseIdentifier("doi:"), null, "empty value");
  assert.equal(search.parseIdentifier(":10.1/x"), null, "empty scheme");
  assert.equal(search.parseIdentifier("10.1/x"), null, "no scheme at all");
  assert.equal(search.parseIdentifier(""), null);
});

test("parseIdentifiers keeps the good ones and reports the rest", () => {
  const parsed = search.parseIdentifiers("doi:10.1/x, ieee:1, arxiv:1706.03762");
  assert.deepEqual(parsed.identifiers, ["doi:10.1/x", "arxiv:1706.03762"]);
  assert.deepEqual(parsed.bad, ["ieee:1"]);
});

/* ---------------- buildFilters ---------------- */

test("buildFilters omits every empty field", () => {
  const { filters, problems } = search.buildFilters({});
  assert.deepEqual(filters, {}, "an empty form must not send filters at all");
  assert.deepEqual(problems, []);
});

test("buildFilters sends the pre-2026-09 keys exactly as before", () => {
  const { filters } = search.buildFilters({
    yearFrom: "2015",
    yearTo: "2024",
    authors: "a, b",
    venue: "ISSCC",
    doi: "10.1/x",
    arxivId: "1706.03762",
    tag: "sram"
  });
  assert.deepEqual(filters, {
    year_from: 2015,
    year_to: 2024,
    authors: ["a", "b"],
    venue: ["ISSCC"],
    tag: ["sram"],
    doi: "10.1/x",
    arxiv_id: "1706.03762"
  });
});

test("buildFilters carries the metadata snapshot keys", () => {
  const { filters, problems } = search.buildFilters({
    venueYear: "2021, 2022",
    paperTypes: ["conference", "journal", "bogus"],
    identifiers: "ieee_article_number:7065247",
    ieeeTerms: "low power sram",
    authorTerms: "j. smith",
    dynamicIndexTerms: "dynamic index",
    sourceTags: "ieee"
  });
  assert.deepEqual(filters.venue_year, [2021, 2022]);
  assert.deepEqual(filters.paper_type, ["conference", "journal"], "unknown types are dropped");
  assert.deepEqual(filters.identifier, ["ieee_article_number:7065247"]);
  assert.deepEqual(filters.ieee_terms, ["low power sram"]);
  assert.deepEqual(filters.author_terms, ["j. smith"]);
  assert.deepEqual(filters.dynamic_index_terms, ["dynamic index"]);
  assert.deepEqual(filters.source_tags, ["ieee"]);
  assert.deepEqual(problems, []);
});

test("buildFilters reports a bad year and a bad identifier without dropping the rest", () => {
  const { filters, problems } = search.buildFilters({
    yearFrom: "20xx",
    venueYear: "20",
    identifiers: "ieee:1",
    venue: "ISSCC"
  });
  assert.equal(filters.year_from, undefined);
  assert.equal(filters.venue_year, undefined);
  assert.equal(filters.identifier, undefined);
  assert.deepEqual(filters.venue, ["ISSCC"], "the valid filter still goes out");
  assert.equal(problems.length, 3);
  assert.ok(problems[0].includes("年份从"));
  assert.ok(problems[1].includes("会议年份"));
  assert.ok(problems[2].includes("ieee:1"));
});

test("buildFilters treats whitespace as empty", () => {
  const { filters } = search.buildFilters({ authors: "   ", doi: "  ", tag: " , " });
  assert.deepEqual(filters, {});
});

/* ---------------- countFilters / metadataLine ---------------- */

test("countFilters counts keys, not values", () => {
  assert.equal(search.countFilters(null), 0);
  assert.equal(search.countFilters({}), 0);
  assert.equal(search.countFilters({ authors: [], tag: null, doi: "" }), 0);
  assert.equal(search.countFilters({ authors: ["a", "b"], year_from: 2020 }), 2);
});

test("metadataLine renders only what paperbox echoed back", () => {
  assert.deepEqual(search.metadataLine({}), []);
  assert.deepEqual(
    search.metadataLine({
      venue: "ISSCC",
      venue_year: 2021,
      paper_type: "conference",
      volume: "56",
      issue: "2",
      pages: "1-8",
      publication_date: "2021-02-18"
    }),
    ["ISSCC 2021", "conference", "56(2)", "pp. 1-8", "2021-02-18"]
  );
  // 只有 venue、没有那一届时不要凭空补年份
  assert.deepEqual(search.metadataLine({ venue: "JSSC" }), ["JSSC"]);
  assert.deepEqual(search.metadataLine({ volume: "56" }), ["56"]);
  assert.deepEqual(search.metadataLine({ issue: "2" }), ["(2)"]);
});
