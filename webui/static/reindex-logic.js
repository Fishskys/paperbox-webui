/* paperbox 控制台 · 「重建全库索引」的纯逻辑（无 DOM，node --test 直接跑）。
 *
 * 三件事要有确定口径、又要能被测：
 *   1) 预览里怎么把检测结果讲清楚（换了模型？换了解析器？有降级？各命中几篇）；
 *   2) 确认按钮上写几篇 —— 点之前必须知道影响面；
 *   3) "没有需要重建的"也是一个正常答案，界面不能装作在忙。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.RL = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*: 原因码 → 人话。paperbox 新加的码还没进表时原样显示，不吞掉。 */
  var REASON_LABELS = {
    all: "全库重建（不看检测结果）",
    explicit: "调用方指名",
    embedding_model_changed: "embedding 模型变了",
    parser_backend_changed: "解析器变了",
    open_degradations: "上次流水线让步且未解决",
    missing_chunks: "还没有 chunk",
    unknown_paper: "id 不存在或已删除"
  };

  function reasonLabel(code) {
    return REASON_LABELS[code] || String(code || "");
  }

  /*: 每条理由一行：「模型变了 · 30 篇 · 整库」/「有未决降级 · 2 篇」。 */
  function reasonLines(report, key) {
    var data = (report || {})[key] || [];
    return data.map(function (item) {
      var scope = item.scope === "all" ? "整库" : "部分";
      return reasonLabel(item.code) + " · " + item.papers + " 篇 · " + scope;
    });
  }

  /*: 本轮要排队的篇数（预览里 show 的就是它）。 */
  function selectedCount(report) {
    var value = Number((report || {}).selected);
    return value > 0 ? value : 0;
  }

  function confirmLabel(report) {
    var count = selectedCount(report);
    return count ? "确认：排队重建这 " + count + " 篇" : "没有需要重建的";
  }

  /*: 当前索引事实：embedding 模型 + 解析戳 —— 用来解释"为什么它说不用重建"。 */
  function censusLines(report) {
    var data = report || {};
    var embedding = data.embedding || {};
    var parser = data.parser || {};
    var lines = [];
    if (embedding.configured) {
      var drifted = embedding.drifted ? "（与索引里的不一致）" : "（一致）";
      lines.push("embedding 模型：" + embedding.configured + drifted);
    }
    var seen = embedding.seen || {};
    var models = Object.keys(seen);
    if (models.length) {
      lines.push(
        "索引里的模型：" +
          models
            .map(function (model) {
              return (model || "(无戳)") + " x" + seen[model];
            })
            .join(", ")
      );
    }
    if (parser.configured) {
      var stale = Number(parser.stale) || 0;
      lines.push("解析器：" + parser.configured + (stale ? "（有 " + stale + " 篇戳不同）" : "（全部一致）"));
    }
    var stamps = parser.stamps || {};
    var stampNames = Object.keys(stamps);
    if (stampNames.length) {
      lines.push(
        "解析戳分布：" +
          stampNames
            .map(function (stamp) {
              return stamp + " x" + stamps[stamp];
            })
            .join(", ")
      );
    }
    return lines;
  }

  /*: 预览面板上那一段总述。 */
  function previewNote(report) {
    var data = report || {};
    var count = selectedCount(data);
    if (!count) {
      return "检测为空：没有需要重建的论文（模型与解析戳都一致、也没有未决降级）。";
    }
    return (
      "检测到 " +
      count +
      " 篇需要重建。确认后会按篇排队（队列按 INGEST_CONCURRENCY 串行执行，整库是小时级操作）。"
    );
  }

  function skippedCount(report) {
    var skipped = (report || {}).skipped || [];
    return Array.isArray(skipped) ? skipped.length : 0;
  }

  return {
    REASON_LABELS: REASON_LABELS,
    reasonLabel: reasonLabel,
    reasonLines: reasonLines,
    selectedCount: selectedCount,
    confirmLabel: confirmLabel,
    censusLines: censusLines,
    previewNote: previewNote,
    skippedCount: skippedCount
  };
});
