/* paperbox 控制台：检索过滤器的纯逻辑（无 DOM、无网络、无依赖）。
 *
 * 同一份文件两个入口：浏览器里挂成 window.PaperboxSearch，node 里走 module.exports
 * （见 tests/js/search_logic.test.mjs）。这样"哪些过滤键会被发出去、哪些输入会被就地拦下"
 * 能被 node:test 真测，而不是只对 app.js 做字符串断言。
 *
 * 与后端的对应关系（2026-09-22 的 paperbox）：
 *   - filters 支持 year_from / year_to / authors / venue / doi / arxiv_id / tag，
 *     以及元数据快照带来的 venue_year / paper_type / identifier /
 *     ieee_terms / author_terms / dynamic_index_terms / source_tags
 *     （app/schemas/search.py 的 SearchFilters）；
 *   - identifier 必须是 `scheme:value`，未知 scheme 后端会 422 —— 所以这里就地校验，
 *     把打错的项留成一条提示，而不是让整次检索失败；
 *   - 空值一律**不发**（后端对缺省字段按"不过滤"处理）。
 *
 * 不引入任何构建工具（SPEC §4）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PaperboxSearch = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 与 paperbox app/services/metadata_identifiers.py 的 SCHEMES 同集合。
   * 多一个少一个都会让 UI 与后端对"什么算合法标识符"产生分歧。 */
  var SCHEMES = [
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
  ];

  /* 与 papers.paper_type 的取值一致（app/db/models.py 的注释）。 */
  var PAPER_TYPES = ["journal", "conference", "preprint", "early_access", "standard"];

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
  }

  /* 逗号切分（中英文逗号都认），去空白、丢空项。 */
  function splitList(value) {
    if (isBlank(value)) return [];
    return String(value)
      .split(/[,，]/)
      .map(function (item) {
        return item.trim();
      })
      .filter(function (item) {
        return item.length > 0;
      });
  }

  function parseYear(value) {
    if (isBlank(value)) return null;
    var trimmed = String(value).trim();
    if (!/^\d{4}$/.test(trimmed)) return null;
    return Number(trimmed);
  }

  /* 多值年份（venue_year）：返回 {years, bad}，坏项留给调用方提示。 */
  function parseYears(value) {
    var years = [];
    var bad = [];
    splitList(value).forEach(function (item) {
      var year = parseYear(item);
      if (year === null) bad.push(item);
      else if (years.indexOf(year) < 0) years.push(year);
    });
    return { years: years, bad: bad };
  }

  /* `scheme:value` → {scheme, value}；scheme 大小写不敏感，输出统一小写。 */
  function parseIdentifier(entry) {
    if (isBlank(entry)) return null;
    var raw = String(entry).trim();
    var at = raw.indexOf(":");
    if (at <= 0 || at === raw.length - 1) return null;
    var scheme = raw.slice(0, at).trim().toLowerCase();
    var value = raw.slice(at + 1).trim();
    if (!value || SCHEMES.indexOf(scheme) < 0) return null;
    return { scheme: scheme, value: value, text: scheme + ":" + value };
  }

  /* 一组标识符 → {identifiers: [...], bad: [...]}（bad 是原样输入，用于提示）。 */
  function parseIdentifiers(value) {
    var identifiers = [];
    var bad = [];
    splitList(value).forEach(function (item) {
      var parsed = parseIdentifier(item);
      if (parsed === null) bad.push(item);
      else identifiers.push(parsed.text);
    });
    return { identifiers: identifiers, bad: bad };
  }

  /* 论文类型多选：只保留已知取值，未知的丢弃（后端是自由字符串，前端不必发明新值）。 */
  function normalizePaperTypes(values) {
    var list = Array.isArray(values) ? values : splitList(values);
    var out = [];
    list.forEach(function (item) {
      var value = String(item || "").trim().toLowerCase();
      if (value && PAPER_TYPES.indexOf(value) >= 0 && out.indexOf(value) < 0) out.push(value);
    });
    return out;
  }

  /* 把表单里的原始字符串整理成 paperbox 的 `filters`。
   *
   * raw 的键（全部可选，空 = 不过滤）：
   *   yearFrom yearTo authors venue doi arxivId tag venueYear paperTypes
   *   identifiers ieeeTerms authorTerms dynamicIndexTerms sourceTags
   *
   * 返回 {filters, problems}：problems 是给人看的中文提示（不阻断检索）。 */
  function buildFilters(raw) {
    var source = raw || {};
    var filters = {};
    var problems = [];

    var yearFrom = parseYear(source.yearFrom);
    var yearTo = parseYear(source.yearTo);
    if (!isBlank(source.yearFrom) && yearFrom === null) problems.push("年份从必须是 4 位数字");
    if (!isBlank(source.yearTo) && yearTo === null) problems.push("年份到必须是 4 位数字");
    if (yearFrom !== null) filters.year_from = yearFrom;
    if (yearTo !== null) filters.year_to = yearTo;

    var venueYears = parseYears(source.venueYear);
    if (venueYears.bad.length) problems.push("会议年份必须是 4 位数字：" + venueYears.bad.join("、"));
    if (venueYears.years.length) filters.venue_year = venueYears.years;

    var paperTypes = normalizePaperTypes(source.paperTypes);
    if (paperTypes.length) filters.paper_type = paperTypes;

    var identifiers = parseIdentifiers(source.identifiers);
    if (identifiers.bad.length) {
      problems.push(
        "标识符必须是 scheme:value（" +
          SCHEMES.join(" / ") +
          "），已忽略：" +
          identifiers.bad.join("、")
      );
    }
    if (identifiers.identifiers.length) filters.identifier = identifiers.identifiers;

    var lists = {
      authors: splitList(source.authors),
      venue: splitList(source.venue),
      tag: splitList(source.tag),
      ieee_terms: splitList(source.ieeeTerms),
      author_terms: splitList(source.authorTerms),
      dynamic_index_terms: splitList(source.dynamicIndexTerms),
      source_tags: splitList(source.sourceTags)
    };
    Object.keys(lists).forEach(function (key) {
      if (lists[key].length) filters[key] = lists[key];
    });

    var doi = isBlank(source.doi) ? "" : String(source.doi).trim();
    if (doi) filters.doi = doi;
    var arxivId = isBlank(source.arxivId) ? "" : String(source.arxivId).trim();
    if (arxivId) filters.arxiv_id = arxivId;

    return { filters: filters, problems: problems };
  }

  /* 结果摘要里显示"过滤 N 项"：数组算一个键、标量算一个键。 */
  function countFilters(filters) {
    if (!filters) return 0;
    return Object.keys(filters).filter(function (key) {
      var value = filters[key];
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }).length;
  }

  /* 结果卡片上那一行元数据：venue · 那一届 · 类型 · 卷(期) · 页码 · 发表日期。
   * 只拼后端真的回显了的字段（app/schemas/search.py 的 SearchResult）。 */
  function metadataLine(result) {
    if (!result) return [];
    var parts = [];
    var venue = isBlank(result.venue) ? "" : String(result.venue).trim();
    if (venue) {
      parts.push(
        result.venue_year ? venue + " " + result.venue_year : venue
      );
    }
    if (!isBlank(result.paper_type)) parts.push(String(result.paper_type));
    var volume = isBlank(result.volume) ? "" : String(result.volume).trim();
    var issue = isBlank(result.issue) ? "" : String(result.issue).trim();
    if (volume) parts.push(issue ? volume + "(" + issue + ")" : volume);
    else if (issue) parts.push("(" + issue + ")");
    if (!isBlank(result.pages)) parts.push("pp. " + String(result.pages).trim());
    if (!isBlank(result.publication_date)) parts.push(String(result.publication_date).trim());
    return parts;
  }

  return {
    SCHEMES: SCHEMES,
    PAPER_TYPES: PAPER_TYPES,
    splitList: splitList,
    parseYear: parseYear,
    parseYears: parseYears,
    parseIdentifier: parseIdentifier,
    parseIdentifiers: parseIdentifiers,
    normalizePaperTypes: normalizePaperTypes,
    buildFilters: buildFilters,
    countFilters: countFilters,
    metadataLine: metadataLine
  };
});
