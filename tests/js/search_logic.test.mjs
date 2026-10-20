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
  // 存量论文的 venue/卷期页都是 NULL，DOI 常是卡片上唯一的标识符
  assert.deepEqual(search.metadataLine({ doi: "10.1145/3719027.3744840" }), [
    "doi:10.1145/3719027.3744840"
  ]);
  assert.deepEqual(
    search.metadataLine({ venue: "ISSCC", venue_year: 2021, doi: "10.1/x" }),
    ["ISSCC 2021", "doi:10.1/x"]
  );
  assert.deepEqual(search.metadataLine({ doi: "  " }), []);
});

// --------------------------------------------------------------------------- //
// 检索请求体：rerank 默认关（与 paperbox 的默认一致），backend 仅在选择了覆盖值时发
// --------------------------------------------------------------------------- //

test("rerank defaults to off and is always sent as a boolean", () => {
  const off = search.buildSearchBody({ query: "x", mode: "hybrid", topK: 10, filters: {} });
  assert.equal(off.rerank, false);
  assert.equal(typeof off.rerank, "boolean", "发 undefined 会被后端当缺省字段");

  const on = search.buildSearchBody({
    query: "x",
    mode: "hybrid",
    topK: 10,
    rerank: true,
    filters: {}
  });
  assert.equal(on.rerank, true);

  // 只有真值 true 才算勾上：字符串 "false"、1、undefined 都不许开
  for (const falsy of ["false", "true", 1, 0, null, undefined]) {
    assert.equal(
      search.buildSearchBody({ query: "x", rerank: falsy, filters: {} }).rerank,
      false,
      String(falsy)
    );
  }
});

test("a backend override is sent only when chosen", () => {
  const auto = search.buildSearchBody({ query: "x", mode: "hybrid", topK: 10, filters: {} });
  assert.equal("backend" in auto, false, "空 = 让服务端按 SEARCH_BACKEND 决定");

  const pinned = search.buildSearchBody({
    query: "x",
    mode: "hybrid",
    topK: 10,
    backend: "python",
    filters: {}
  });
  assert.equal(pinned.backend, "python");
});

test("the search body carries query, mode, top_k and filters", () => {
  const body = search.buildSearchBody({
    query: "  attention  ",
    mode: "keyword",
    topK: "25",
    filters: { year_from: 2017 }
  });
  assert.deepEqual(body, {
    query: "attention",
    mode: "keyword",
    top_k: 25,
    rerank: false,
    filters: { year_from: 2017 }
  });
  // 缺省值兜底，避免发 top_k=0 / 空 mode
  const defaults = search.buildSearchBody({});
  assert.equal(defaults.mode, "hybrid");
  assert.equal(defaults.top_k, 10);
  assert.deepEqual(defaults.filters, {});
});

// --------------------------------------------------------------------------- //
// 命中摘要：候选数与精排状态要能看出来（rerank.model 非空 = 真的跑了）
// --------------------------------------------------------------------------- //

test("searchSummary shows the candidates and whether rerank ran", () => {
  // 没勾：paperbox 会回 enabled=true / model=null —— 这是正常状态，要显示「关」
  const off = search.searchSummary(
    { mode: "hybrid", backend: "native", total: 30, candidates: 31, took_ms: 412.34, rerank: { enabled: true, model: null, took_ms: null } },
    { topK: 10, rerankRequested: false }
  );
  assert.match(off, /后端 native/);
  assert.match(off, /命中 30 篇/);
  assert.match(off, /候选 31/);
  assert.match(off, /精排 关/);
  assert.match(off, /耗时 412\.3 ms/);

  // 勾了但 model 仍是 null = 服务端静默降级，必须与「关」区分开
  const requested = search.searchSummary(
    { mode: "hybrid", backend: "native", total: 30, took_ms: 5000, rerank: { enabled: true, model: null, took_ms: null } },
    { rerankRequested: true }
  );
  assert.match(requested, /精排 未生效/);

  const on = search.searchSummary(
    { mode: "hybrid", backend: "native", total: 30, candidates: 50, took_ms: 4720.1, rerank: { enabled: true, model: "temsa/mmarco-x", took_ms: 3975 } },
    { rerankRequested: true }
  );
  assert.match(on, /精排 temsa\/mmarco-x 3975 ms/);
  assert.match(on, /候选 50/);
});

test("searchSummary degrades gracefully on a thin payload", () => {
  const text = search.searchSummary({}, { topK: 10 });
  assert.match(text, /后端 —/);
  assert.match(text, /命中 — 篇/);
  assert.match(text, /top_k 10/);
});

/* ---------------- 搜索项下拉（仿 IEEE）+ 参考文献开关 ---------------- */

test("buildScopedSearch: scope=all keeps the plain free-text query", () => {
  const out = search.buildScopedSearch({ scope: "all", value: "attention", mode: "hybrid", topK: 10 });
  assert.equal(out.body.query, "attention");
  assert.deepEqual(out.body.filters, {});
});

test("buildScopedSearch: scope=author adds an authors filter (and keeps the query)", () => {
  const out = search.buildScopedSearch({ scope: "author", value: "David Patterson", mode: "hybrid", topK: 10 });
  assert.equal(out.body.query, "David Patterson");
  assert.deepEqual(out.body.filters.authors, ["David Patterson"]);
});

test("buildScopedSearch: scope=doi adds a doi filter", () => {
  const out = search.buildScopedSearch({ scope: "doi", value: "10.1109/isscc49663.2026.11409034" });
  assert.equal(out.body.filters.doi, "10.1109/isscc49663.2026.11409034");
});

test("buildScopedSearch: scope=arxiv adds an arxiv_id filter", () => {
  const out = search.buildScopedSearch({ scope: "arxiv", value: "1706.03762" });
  assert.equal(out.body.filters.arxiv_id, "1706.03762");
});

test("buildScopedSearch: an unknown scope falls back to all (no filter added)", () => {
  const out = search.buildScopedSearch({ scope: "venue", value: "x" });
  assert.deepEqual(out.body.filters, {});
});

test("buildScopedSearch: includeReferences sets include_references=true, default absent", () => {
  const off = search.buildScopedSearch({ scope: "all", value: "x" });
  assert.equal(off.body.filters.include_references, undefined);
  const on = search.buildScopedSearch({ scope: "all", value: "x", includeReferences: true });
  assert.equal(on.body.filters.include_references, true);
});

test("buildScopedSearch: existing filters are preserved and extended", () => {
  const out = search.buildScopedSearch({
    scope: "author",
    value: "a. lee",
    filters: { year_from: 2020 }
  });
  assert.equal(out.body.filters.year_from, 2020);
  assert.deepEqual(out.body.filters.authors, ["a. lee"]);
});
