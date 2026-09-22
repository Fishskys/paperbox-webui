# 真机验收记录：搜索选项 / 一致性检查 / 元数据导入 / 任务分页

日期：2026-09-23 ｜ 仓库：`paperbox-webui`（WebUI 改动 commit `8891f58`、`20f5660`、`9fa08df`、`7c1078c`）

paperbox 侧版本：`C:\Users\xuanj\Desktop\hermes\paperbox`（2026-09-22/23 契约：
`/api/consistency`、`/api/metadata/*`、`GET /api/jobs` 的 `offset`/`stage`、`POST /api/jobs/{id}/retry`、
检索过滤新增 `venue_year`/`paper_type`/`identifier`/四类索引词）。**paperbox 一个字节都没改。**

跑法：四个依赖容器（PG / OpenSearch / MinIO / Embedding）已在 WSL Docker 里 healthy，
paperbox `uv run uvicorn app.main:app --host 127.0.0.1 --port 8077`，
WebUI `uv run uvicorn webui.main:app --host 127.0.0.1 --port 8088`（默认配置）。

真机基线（本机库）：**68 篇存活论文 / 139 篇已删除 / 68 个 MinIO 对象 / 2883 个 OpenSearch 文档**，
迁移 head `0de3ab5e24dc`，索引别名 `paper_chunks_current`。

---

## 1. 任务分页（`GET /api/ui/jobs`）

```
$ curl -s "http://127.0.0.1:8088/api/ui/jobs?limit=2&offset=0"
{"total":237,"limit":2,"offset":0,"stage":null,"jobs":[{"job_id":"47b0c586-…"},{"job_id":"99716b8e-…"}]}

$ curl -s "http://127.0.0.1:8088/api/ui/jobs?limit=2&offset=2"
{"total":237,"limit":2,"offset":2,"stage":null,"jobs":[{"job_id":"0f95820e-…"},{"job_id":"0ff8b6ba-…"}]}

$ curl -s "http://127.0.0.1:8088/api/ui/jobs?limit=3&stage=FAILED"
{"total":19,"limit":3,"offset":0,"stage":"FAILED","jobs":[{"stage":"FAILED","error_code":"INTERNAL"}, …]}
```

`offset` 真的在切窗口（两页没有重复 job），`stage` 过滤由 paperbox 侧执行（`total` 是**过滤后**的 19），
`limit`/`offset`/`stage` 与 `total` 一起回显 —— 前端页码就靠这一组数算，不自己数行。

浏览器里（`http://127.0.0.1:8088/` → Tab 4）：

```
分页条：第 1 / 12 页 ｜ 共 237 条 ｜ 每页 20 行
第 1 页 job_id：47b0c586 99716b8e 0f95820e 0ff8b6ba 1dee942e ca848613 …
点「下一页」：第 2 页 job_id：368ac8b1 96538e89 017c44d9 6a173116 …
两页交集：set()   ← 空集
点「上一页」：第 1 / 12 页
行内文本示例：368ac8b1-…  已完成 ｜ 100.0% ｜ 是 ｜ — ｜ 打开 693fce72-… ｜
             2026/9/20 13:20:05 ｜ 2026/9/20 13:20:48 ｜ 2026/9/20 13:20:48 ｜ 42.8 s
```

耗时是 `finished_at - created_at`（42.8 s）；没有 `finished_at` 的作业显示「进行中」——
这条规则在 `webui/static/jobs-logic.js`，由 `tests/js/jobs_logic.test.mjs` 真跑（含
`offset` 越界夹到最后一页，否则会出现「第 9 / 7 页」）。

**失败作业的「重试」按钮没有在真机上点下去**：本机有 19 个 `FAILED`（`error_code=INTERNAL`）作业，
重试会真的重新下载/解析论文，属于改数据，按约定留给人工点。改测了**零副作用**的那一半：

```
$ curl -s -o /dev/null -w "%{http_code}\n" -X POST \
       "http://127.0.0.1:8088/api/ui/jobs/47b0c586-d5a3-4624-9cf4-22c40f3db1a9/retry"   # 这是一个 COMPLETED 作业
409
{"detail":"only FAILED jobs can be retried"}
```

即 BFF 把 paperbox 的 409 原文透传给了前端（前端会 toast 出来），没有触发任何作业。

## 2. 一致性检查（`GET /api/ui/consistency`）

```
$ curl -s "http://127.0.0.1:8088/api/ui/consistency?limit=50"
consistent = True     took_ms = 437.5     index = paper_chunks_current (exists)     errors = []     truncated = False
totals = {papers: 207, papers_live: 68, papers_deleted: 139, files_pg: 68, objects_minio: 68,
          chunks_pg: 3892, documents_os: 2883, staging_objects: 0,
          problems: 0, orphan_objects: 0, orphan_documents: 0}
problems = 0   orphan_objects = 0   orphan_documents = 0
```

`chunks_pg`（3892 行 chunk）与 `documents_os`（2883 个索引文档）不是同一个计数，逐篇对账后
`problems=0` 才是结论。浏览器 Tab 5：

```
结论：一致 · 0 篇不一致 · 索引 paper_chunks_current（存在） · 耗时 404.0 ms · 检查于 2026-09-22T17:43:11Z
总数格子：11 个（论文含已删 / 存活 / 已删 / 文件行 / 对象 / chunk 行 / 文档 / staging 残留 /
          不一致论文 / 孤儿对象 / 孤儿文档）
errors 横条：hidden=True（本次没有 store 不可达）   问题表：（0）   空态提示：显示
```

`errors` 非空的路径由单测覆盖（上游 200 且 `errors` 非空时 BFF 仍返回 200 与整份报告）——
这是 paperbox 的语义：一个 store 连不上，另外两端照样给结论。

## 3. 搜索选项（`POST /api/ui/search`）

```
$ curl -s -X POST http://127.0.0.1:8088/api/ui/search -H 'Content-Type: application/json' \
   -d '{"query":"membership inference","mode":"hybrid","top_k":3,
        "filters":{"identifier":["doi:10.1145/3719027.3744840"]}}'
total = 1     ids = ['052a4c85']

$ curl -s -X POST http://127.0.0.1:8088/api/ui/search -H 'Content-Type: application/json' \
   -d '{"query":"attention","mode":"keyword","top_k":3,"filters":{"year_from":2025}}'
total = 1     years = [2026]

$ curl -s -X POST http://127.0.0.1:8088/api/ui/search -H 'Content-Type: application/json' \
   -d '{"query":"attention","mode":"hybrid","top_k":2,"filters":{"identifier":["nope:1"]}}'
422
{"detail":[{"type":"value_error","loc":["body","filters","identifier"],
  "msg":"Value error, identifier entries must be scheme:value with a known scheme
         (doi, arxiv, ieee_article_number, issn, isbn, pmid, openalex, semantic_scholar, url, sha256)",
  "input":["nope:1"]}]}
```

`identifier` 命中真实 DOI（1 篇）；未知 scheme 是 paperbox 的 422，BFF 原样透传。
**前端不会让这种请求发出去**：`search-logic.js` 的 `parseIdentifier` 就地丢弃非法项并提示
（`tests/js/search_logic.test.mjs` 真跑），422 只是"绕过 UI 时的正确行为"。

浏览器 Tab 1（填 `#filter-identifier = doi:10.1145/3719027.3744840` 后提交）：

```
摘要：模式 hybrid · 命中 1 篇 · 耗时 599.7 ms · 过滤 1 项
结果卡片新增行：doi:10.1145/3719027.3744840
卡片全文：Riddle Me This! Stealthy Membership Inference for Retrieval-Augmented Generation ｜
          Retrieval-Augmented Generation，Ali Naseh，… ｜ 年份 2025 ｜ doi:10.1145/3…
```

元数据行（venue + 那一届 / 论文类型 / 卷(期) / 页码 / 发表日期 / doi）**只在有值时出现**：
本机 66 篇存量论文的这些列全是 NULL，所以卡片多数还是老样子——这是预期，不是渲染失败。
新增过滤键（`venue_year` / `paper_type` / `source_tags` …）在真机上**命中 0 篇**同理：
过滤器已就位，等元数据落库（`scripts/refresh_index_metadata.py` 刷新索引快照后即可命中）。

## 4. 元数据导入（`POST /api/ui/metadata/import` + review）

探针文件：`.hermes/acceptance/probe_records_2026-09-23.json`（两条最小 generic 记录，
DOI 是编造的 `10.9999/…`；该目录不进版本控制，与上一轮上传验收的探针脚本同处）。

```
$ curl -s -X POST http://127.0.0.1:8088/api/ui/metadata/import -F file=@probe_records.json
format = generic     dry_run = True
total = 2   matched = 0   created_shell = 2   ambiguous = 0   unmatched = 0   unchanged = 0
sources = [('doi:10.9999/paperbox-webui-probe-a', 'matched'),
           ('doi:10.9999/paperbox-webui-probe-b', 'matched')]
conflicts = 0

$ curl -s -X POST "http://127.0.0.1:8088/api/ui/metadata/import?dry_run=false&apply=false&source_type=manual" \
       -H 'Content-Type: application/json' --data-binary @probe_records.json
format = generic     dry_run = True     total = 2   matched = 0   ambiguous = 0   unchanged = 0
```

两条入口（multipart 字段 `file` / 原始 JSON 体）都通；`dry_run` 默认 true，报告 `dry_run=true`
且 `created_shell=2`（"这两条记录会新建壳论文"），**库里什么都没变**：

```
$ curl -s "http://127.0.0.1:8088/api/ui/papers?limit=1"          # 试运行前后都是 68
papers total = 68
$ curl -s "http://127.0.0.1:8088/api/ui/metadata/review?limit=5"
items = 0   conflicts = 2   total = 0                            # 没有新增待人工记录
```

浏览器 Tab 6（粘贴 JSON → 点「试运行（不写库）」）：

```
报告摘要：试运行（未写库） · 格式 generic
报告格子：1=记录总数 ; 0=已匹配 ; 1=新建壳论文 ; 0=歧义（待人工） ; 0=未匹配 ; 0=无变化
来源明细首行：doi:10.9999/webui-probe ｜ — ｜ matched ｜ shell ｜ would create a shell paper (AWAITING_FILE)
```

「导入并应用」与「批量应用」的 `overwrite` 都要二次确认，属于写库动作，本次**没有点**——
留给人工作业（`apply` 的请求体形状由 `tests/test_webui.py` 覆盖）。

## 5. 测试与静态守卫

```
$ uv run pytest -p no:warnings --no-header        # webui 仓
72 passed in 1.75s

$ node --test tests/js/*.test.mjs
ℹ tests 39   ℹ pass 39   ℹ fail 0
```

其中与本次四项能力直接相关的：`/api/ui/jobs` 的分页参数与 `total` 回显、retry 的 409 透传、
一致性报告的 200-with-errors、元数据四路由的四种请求体形状、以及静态守卫
（Tab 1 的扩展过滤字段与 `paper_type` 五个取值、六个 Tab 的页面骨架、Tab 4 的十个阶段下拉与分页控件、
三个逻辑模块的加载顺序）。浏览器控制台在本轮所有点击/提交后 `window.__errs` 都是 `[]`。

## 6. 观察与未做

- **19 个 `FAILED`（INTERNAL）历史作业**：界面能重试，但重试会真的动数据，按约定留给人工。
  它们的存在也让「阶段过滤」在真机上有非空结果可看。
- **存量论文的元数据列全 NULL**：新增过滤键与卡片新字段都就位，但真机上命中 0 —— 需要先做一次
  元数据导入（应用）并跑 paperbox 的 `scripts/refresh_index_metadata.py`，索引快照才会带上新值。
  这也正是 Tab 1 上那句提示的由来：**过滤读的是索引快照，不是 PG 当前值**。
- **`chunks_pg` ≠ `documents_os`**（3892 vs 2883）不是漂移：前者是 PG 的 chunk 行数，
  后者是 OpenSearch 文档数，逐篇对账 `problems=0` 才是"一致"的定义。
- 未做：联网元数据查询（IEEE/arXiv/DOI 内容协商）按约定不在本期；批量上传的 batches/manifest/lease
  仍不暴露。
