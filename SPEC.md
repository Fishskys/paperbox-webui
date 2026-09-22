# paperbox-webui — 实现规范

给 **paperbox**（论文知识服务 REST API）做一个**简易 WebUI**，用途是手工测试 paperbox 的
全部功能：导入、检索、浏览论文、查看证据片段、重建索引、删除。

paperbox 后端服务（FastAPI，端口 **8077**）另行维护，本仓库不含其代码；
其 API 一览与调用示例见该仓库的 `docs/hermes-integration.md` 与 `README.md` 的等价文档。

## 0. 技术栈与硬约束

- Python 3.12，**统一用 uv 管理**（`uv sync` / `uv add` / `uv run`），不写 pip/venv 命令。
- 后端：FastAPI + httpx（**代理 paperbox**），pydantic-settings 读配置。
- 前端：**无构建步骤**的原生 HTML/CSS/JS（`webui/static/`），不引入 React/Vue/npm/CDN，
  离线可用；中文界面优先。
- 端口 **8088**，`uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088`。
- **API Key 只在服务端**：浏览器只访问本服务的 `/api/ui/*`，由后端带 Bearer 转发到 paperbox。
  不引入 CORS（同源）。

## 1. 目录结构

```
pyproject.toml  uv.lock  .python-version
.env  .env.example  .gitignore  README.md  SPEC.md
webui/
  __init__.py
  main.py            FastAPI app：静态文件 + 挂载 /api/ui 路由
  config.py          pydantic-settings（读 .env）
  client.py          PaperboxClient（httpx.AsyncClient 封装 paperbox REST）
  routers/
    __init__.py
    system.py        GET /api/ui/health        健康 + 统计
    config.py        GET /api/ui/config        上传队列调参（并发 / 退避 / 文件上限）
    papers.py        GET  /api/ui/papers, /api/ui/papers/{id},
                          /api/ui/papers/{id}/chunks, /api/ui/papers/{id}/file
    jobs.py          GET  /api/ui/jobs, /api/ui/jobs/queue, /api/ui/jobs/{id},
                          POST /api/ui/jobs/{id}/retry
                          （/jobs/queue 必须声明在 /jobs/{job_id} 之前，否则被路径参数吞掉）
    ingest.py        POST /api/ui/ingest (JSON url), POST /api/ui/ingest/file,
                          POST /api/ui/ingest/files (multipart，字段 files 可重复)
    search.py        POST /api/ui/search
    actions.py       POST /api/ui/papers/{id}/reindex, DELETE /api/ui/papers/{id}
    consistency.py   GET  /api/ui/consistency（三端对账：只读、永不抛）
    metadata.py      POST /api/ui/metadata/import（multipart file 或 JSON 体）,
                          GET  /api/ui/metadata/review,
                          POST /api/ui/metadata/sources/{source_id}/attach,
                          POST /api/ui/metadata/apply
  static/
    index.html  app.js  search-logic.js  jobs-logic.js  queue-logic.js  style.css
tests/
  __init__.py  test_webui.py  js/queue_logic.test.mjs  js/search_logic.test.mjs
                                                js/jobs_logic.test.mjs
```

## 2. 配置（.env，已存在真实值）

```
PAPERBOX_API_BASE=http://127.0.0.1:8077
PAPERBOX_API_KEY=<真实 key，已在 .env>
WEBUI_HOST=0.0.0.0
WEBUI_PORT=8088
REQUEST_TIMEOUT=30
```

上传队列的调参（全部由 `GET /api/ui/config` 下发给浏览器，前端不硬编码）：

```
WEBUI_UPLOAD_CONCURRENCY=2        # 同时在上传的请求数；不要超过 paperbox 的 INGEST_UPLOAD_CONCURRENCY
WEBUI_UPLOAD_MAX_ATTEMPTS=6       # 429 重试上限，超过判该项失败
WEBUI_RETRY_BASE_MS=2000          # 没有 Retry-After 时的指数退避基数
WEBUI_RETRY_CAP_MS=60000          # 退避上限（Retry-After 也受它约束）
WEBUI_FILE_MAX_MB=100             # 与 paperbox 的 INGEST_MAX_FILE_MB 对齐，前端就地拦下
WEBUI_BATCH_HINT_THRESHOLD=20     # 队列达到这个长度就提示改用 /ingest/dir
```

## 3. 后端要求

- `PaperboxClient`：`AsyncClient`，默认带 paperbox 的鉴权请求头（key 取自 `.env` 的 `PAPERBOX_API_KEY`，代码与文档都不写真实值）；方法：
  `health()`、`list_papers(limit, offset, status, q)`、`get_paper(id)`、
  `get_paper_file(id) -> (bytes, headers)`（流式）、`get_chunks(id, limit, offset)`、
  `list_jobs(limit, offset, stage, paper_id)`、`get_job(id)`、`retry_job(id)`、`job_queue()`、
  `ingest_url(url)`、
  `ingest_file(filename, content, content_type)`、`ingest_files([(filename, fileobj, ctype)])`、
  `search(payload)`、`reindex(id)`、`delete_paper(id)`、
  `consistency(limit)`、`import_metadata(...)`、`metadata_review(status, limit)`、
  `attach_source(source_id, paper_id)`、`apply_metadata(entries, mode)`。
- **错误透传**：paperbox 返回非 2xx 时，把其状态码与 `{"detail": ...}` 原样返回给前端
  （不要吞成 500）；paperbox 不可达时返回 HTTP 502 + `{"detail": "paperbox unreachable: ..."}`。
- **`Retry-After` 透传**：paperbox 用 `429 + Retry-After: <秒>` 表达"在途上传太多了，慢一点"。
  `deps.forward_headers()` 是唯一转发响应头的地方（`passthrough()` 与各 router 的 `_json()` 都走它）；
  丢掉这个头，前端就只能把 429 当普通失败。
- `ingest_files` 直接把 Starlette 的 `UploadFile.file`（可 seek 的 `SpooledTemporaryFile`）交给 httpx
  流式转发，**不要** `await file.read()`：并发 × `INGEST_MAX_FILE_MB` 会把 BFF 的内存打满。
- `GET /api/ui/config` 返回上传队列调参（§2 的 6 个键）；`GET /api/ui/jobs/queue` 代理 paperbox 的
  队列深度（`started/concurrency/running/queued/queued_high/queued_low/...`），用来解释"作业为什么还没开始"。
- 超时：普通 30s，ingest 60s；文件下载用 `StreamingResponse` 转发（附
  `Content-Disposition` 与 `Content-Type`）。
- `GET /api/ui/health` 返回：
  `{"paperbox": {...paperbox /health 的 services...}, "version": "...", "papers": N, "jobs": N}`
  （统计用 paperbox 的 `GET /api/papers` 与 `GET /api/jobs` 的 `total`；任一失败不要让整个接口 500）。
- `GET /` 返回 `webui/static/index.html`；静态目录挂到 `/static`。
- **搜索选项透传**（2026-09-22 paperbox 新增）：`POST /api/ui/search` 的 `filters` 原样转发，
  新增键 `venue_year` / `paper_type`（可多选→数组）/ `identifier`（`scheme:value`）/
  `ieee_terms` / `author_terms` / `dynamic_index_terms` / `source_tags`。
  **BFF 不做过滤键的白名单校验**：paperbox 的 `SearchFilters` 才是权威（未知 scheme → 422），
  前端的就地校验只是为了少打一次无效请求。
- `GET /api/ui/jobs` 必须透传 `limit`（1..200）/ `offset` / `stage` / `paper_id`，
  并把后端的 `total` / `limit` / `offset` / `stage` 原样回给前端 —— 前端页码靠 `total` 算，
  不自己数行。任务分页是**服务端**行为（paperbox 侧没有全量拉取的"一次给我 1000 条"用法）。
- `POST /api/ui/jobs/{id}/retry` 透传；paperbox 对该作业不是 `FAILED` 时回 `409`，原文必须显示出来。
- `GET /api/ui/consistency`（`limit` 转发给 `?limit=`）：**只读且永不抛**。
  paperbox 的语义是"某个 store 不可达也要给另外两端结论"，所以：上游 200 就整份返回
  （哪怕 `errors` 非空、`consistent=false`），上游 4xx/5xx 才按通用错误透传规则处理。
  增加 `limit` 参数门（默认 200，1..1000），别让一次检查把问题清单拉爆。
- 元数据四路由一对一代理 paperbox 的 `/api/metadata/*`：
  `import` 要同时接受 multipart（字段名 `file`）与 JSON 体（`application/json`），
  并把 `dry_run`（**默认 true**）/ `apply` / `source_type` / `limit` 作为查询参数转发；
  `attach` 的 `source_id` 出现在**路径**里（不是查询参数），转发时不能用错；
  `apply` 转发的 body 是 `{entries, mode}`，BFF 不改写内容。

## 4. 前端要求（单页，中文界面）

顶部状态条：paperbox 健康徽标（postgres/opensearch/minio/embedding 四项 ok/error）+ 论文数 + 任务数，
每 15s 自动刷新。

**Tab 1「检索」**：查询框、模式（hybrid/keyword/semantic，默认 hybrid）、top_k（默认 10）、
年份 from/to、作者/期刊/DOI/arXiv/标签过滤 → 结果卡片：标题（可点开详情）、作者、年份、
score（0~1）与 relevance 徽标（high/medium/low 用不同颜色）、evidence 列表（页码 + 章节 + 文本，默认折叠）；
显示耗时与命中论文数。

2026-09-22 paperbox 的检索面扩了一档，Tab 1 必须跟上（**「更多过滤」折叠区**，默认收起，
展开后是 `venue_year` / `paper_type` 多选 / `identifier` / `ieee_terms` / `author_terms` /
`dynamic_index_terms` / `source_tags`）：

- **空值不发**：没填的键不出现在请求体里（不是发 `null`/`""`）—— 这是过滤体的唯一构造入口
  （`search-logic.js` 的 `buildFilters`），别在 `app.js` 里另拼一份。
- **`identifier` 必须 `scheme:value`**：非法项**就地丢弃并提示**，不把整次检索拖成 422；
  合法的 scheme 集合写死在 `search-logic.js`，与 paperbox 的 `IDENTIFIER_SCHEMES` 对齐。
- 结果卡片回显后端**新给的字段**：`venue` + `venue_year`、`paper_type`、`volume/issue/pages`、
  `publication_date`、`identifiers`（有则列 `scheme:value`）。
- 界面必须写清：**这组过滤读的是索引快照**，改完元数据要跑 paperbox 的
  `scripts/refresh_index_metadata.py` 或对该论文 reindex 才生效；`GET /api/ui/papers` 那套
  （Tab 2 的过滤）读的是 PostgreSQL 当前值。两条路径不要混为一谈。

**Tab 2「论文库」**：表格（标题 / 年份 / 状态 / 作者数 / 创建时间），支持状态过滤 + 标题搜索 + 分页
（20/页）；每行操作按钮：详情、下载原文、重建索引、删除（二次确认）。

**Tab 3「导入」**：URL 输入框 + **多选文件队列**。文件 input 必须带 `multiple`
（并可接受拖拽投放，含文件夹）；选中后进入队列列表，每项独立展示
（文件名 / 大小 / 状态徽标 / 进度条 / 取消按钮），ITEM 状态机：
待上传 → 上传中(上传字节百分比) → 已提交 → 排队中/解析中(stage，n/9 + 百分比) → 已完成 | 重复论文 | 失败 | 已取消。
实现要点：

- 上传用 `XMLHttpRequest`（`xhr.upload.onprogress`）拿上传进度；提交后每 2s 轮询
  `GET /api/ui/jobs/{id}`，把 stage 映射成可读步骤
  （RECEIVED→QUEUED→DOWNLOADING→STORED→PARSING→CHUNKING→EMBEDDING→INDEXING→COMPLETED，
  FAILED 显示 error_message）。**QUEUED 是常态**：paperbox 的作业会先停在队列里等流水线空位。
- **受控并发**（默认 2，取自 `GET /api/ui/config` 的 `upload_concurrency`，前端不硬编码；
  配置拿不到就用内置默认，绝不因此拒绝上传）。一个文件一个请求，走
  `POST /api/ui/ingest/files`（字段 `files`）；并发位只算**在途上传**，提交后的作业轮询不占位。
- **429 退避**：收到 `429` 时读 `Retry-After`（秒）把该项放回 pending 并标记 `retryAt`，
  徽标显示「排队退避 Ns」倒计时，到点自动重新进池（重试要重建 XHR）；没有该头则
  指数退避 + 抖动（base 2s，上限 60s）。重试超过 `upload_max_attempts`（默认 6）才判失败，
  **不能**把 429 当普通失败，也不能无限重试。
- **两阶段进度**：摘要为 `共 N 项 · 上传 x/y · 处理 a/b · 失败 f`（x/y = 已提交的文件 / 需上传的文件，
  a/b = 终态作业 / 已提交作业）；上传阶段结束后保留 `上传 y/y`，`处理 a/b` 继续走动。
  有在途作业时每 2s 轮询 `GET /api/ui/jobs/queue`，`queued > 0` 时摘要追加 `· 服务端排队 q`。
- 队列长度 ≥ `batch_hint_threshold`（默认 20）时在队列上方提示改用 `/ingest/dir`（同机零传输）；
  **不**自动改成多文件请求——那会让逐文件进度条失效。
- 「开始上传 / 停止 / 清空已完成」+「加入后自动开始」（默认勾选）；**停止**中止**所有**在途上传、
  清掉全部轮询 timer 与退避定时器，重新开始后退避计数归零。paperbox 没有取消接口，
  已提交的作业会自己跑完（文案必须写清）。
- 前端就地拒绝非 PDF 与超过 `file_max_mb`（默认 100MB）的文件。
- 完成 / 重复项给出论文链接（可跳到详情抽屉），结束后刷新顶部状态条的论文 / 任务计数。

**Tab 4「任务」**：任务表格，**服务端分页**（`limit` + `offset`，每页 10/20/50/100/200），
过滤 stage（十个阶段）+ `paper_id`；行内含 job_id（可复制）、阶段徽标、进度条、duplicate、
`error_code` + `error_message`、论文（可开详情 / 可复制）、创建/更新/完成时间与**耗时**；
`FAILED` 行提供「重试」（二次确认 → `POST /api/ui/jobs/{id}/retry`，409 原文显示）。
页码/总数直接取后端的 `total`：**页数换算（`ceil(total/limit)`、`offset` 越界夹到最后一页、
上一页/下一页可用性）与耗时文案必须放在 `jobs-logic.js`**，由 `tests/js/jobs_logic.test.mjs` 真跑；
`app.js` 只负责把结果画进 DOM。可勾选「每 5 秒自动刷新」，自动刷新**保持当前页**。

**Tab 5「一致性」**：`GET /api/ui/consistency` 的只读视图 —— 问题条目上限（1..1000，默认 200）+
「开始检查」+「每 30 秒自动检查」；结论区给 `一致 / 有漂移` 徽标、检查时间、耗时、索引名与存在性，
以及总数格子（论文含已删/存活/已删、文件行、对象、chunk 行、文档、staging 残留、不一致论文、孤儿对象、孤儿文档）；
下表逐篇列漂移（文件 PG↔MinIO、chunk PG↔OS、问题徽标、缺失对象、孤儿对象），store 级孤儿单列一卡。
`errors` 非空时**照常渲染结论**，只在横条里点名不可达的 store（paperbox 的语义就是"两端也能给结论"）。

**Tab 6「元数据」**：元数据导入闭环，按 导入 → 复核 → 批量应用 三段：
1. 导入：来源类型（`import_file` 默认 / `ieee_api` / `crossref` / `arxiv_api` / `manual`）、
   选文件或粘贴 JSON、可选条数上限；**试运行（`dry_run`）是默认动作**，写库要显式二次确认；
   报告区展示 total / matched / created_shell / ambiguous / unmatched / unchanged、格式、是否写库，
   以及来源明细（`source_ref` / 匹配状态 / 匹配方式 / 论文）与冲突表（保留值 vs 被拒值）。
2. 复核：`GET /api/ui/metadata/review` 的清单（可只看 `ambiguous`），逐行填 `paper_id` → 「挂载」；
   成功后显示合并了哪些字段并刷新。
3. 批量应用：`POST /api/ui/metadata/apply`，entries 可由上次报告的 `source_ref` 一键预填；
   `overwrite` 模式必须二次确认（它会覆盖已有值）。

**论文详情面板**（从任意 Tab 打开）：标题、作者、年份、DOI/arXiv、状态、指纹、文件列表；
chunks 分页列表（显示 chunk_index、页码范围、章节、文本前若干行，可展开全文）；「下载原文」「重建索引」「删除」。

样式：纯 CSS、深浅色舒适可读、无外部字体/CDN；不要引入构建工具。

**纯逻辑与 DOM 的分界**（三条都已落地）：`queue-logic.js`（上传队列）、`search-logic.js`
（检索过滤体）、`jobs-logic.js`（任务分页与耗时）都是 UMD：浏览器挂 `window.PaperboxQueue` /
`window.PaperboxSearch` / `window.PaperboxJobs`，node 走 `module.exports`。
"会算错"的规则一律放这里并配 `node:test`；`app.js` 只做接线与渲染。
三个模块都必须**先于 `app.js`** 加载（index.html 的 `<script>` 顺序是硬约束，静态守卫会断言）。

## 5. 测试要求（tests/）

- 用 `httpx.MockTransport` 造假 paperbox 响应，**不连真实服务**。
- 至少覆盖：`/api/ui/health` 汇总；`/api/ui/papers` 参数透传（limit/offset/status/q）；
  paperbox 4xx/5xx 的错误透传；paperbox 不可达 → 502；`/api/ui/search` 请求体透传；
  `POST /api/ui/ingest` 与文件上传的参数传递。
- 上传相关的额外覆盖：`Retry-After` 透传（有 / 无）、`POST /api/ui/ingest/files` 的多 part 转发、
  429 原样透出、逐文件结果体、502；`GET /api/ui/config`（默认值 + `Settings` 覆盖）；
  `GET /api/ui/jobs/queue` **不被** `/jobs/{job_id}` 吞掉（断言上游 path）；
  `/ingest/files` 转发的是文件句柄而不是整块读进内存。
- **纯前端逻辑走 node 真测**：`webui/static/queue-logic.js`（UMD，无构建工具）里的
  `parseRetryAfter` / `retryDelayMs` / `summarizeProgress` / `uploadSlots` /
  `shouldSuggestServerSide` 由 `tests/js/queue_logic.test.mjs`（`node:test`）覆盖，
  并由 pytest 调起（node 缺失时 `skip`，字符串守卫仍然兜底）。
- 2026-09-23 四项新能力的覆盖：
  - `/api/ui/jobs` 的 `limit`/`offset`/`stage`/`paper_id` 透传与 `total` 回显；
    `/api/ui/jobs/{id}/retry` 的 409 原文透传（路径不能被 `/jobs/queue` 抢走）。
  - `/api/ui/consistency`：`limit` 透传；上游 200 且 `errors` 非空时**仍返回 200 与整份报告**；
    上游 4xx/5xx 才走通用错误透传。
  - `/api/ui/metadata/*`：import 的 multipart 与 JSON 两条路径、`dry_run` 默认值、
    review 的 `status`/`limit`、attach 的 **source_id 在路径上**、apply 的 `{entries, mode}`。
  - 静态守卫：Tab 1 的扩展过滤字段（含 `paper_type` 的五个合法值）、六个 Tab 的页面骨架、
    Tab 4 的十个阶段下拉与分页控件、三个逻辑模块的加载顺序。
- `uv run pytest` 必须全绿；`node --test tests/js/*.test.mjs` 必须全绿。

## 6. 验证要求（必须真跑，把真实输出写进最终回复）

1. `uv run pytest` 全绿。
2. 后台起 `uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088`，然后：
   - `curl -s http://127.0.0.1:8088/api/ui/health` → 四个依赖 ok + papers/jobs 统计
   - `curl -s "http://127.0.0.1:8088/api/ui/papers?limit=5"` → 4 篇论文
   - `curl -s -X POST http://127.0.0.1:8088/api/ui/search -H 'Content-Type: application/json' -d "{\"query\":\"attention\",\"mode\":\"hybrid\",\"top_k\":3}"` → 带 evidence 的结果
   - `curl -s http://127.0.0.1:8088/ | head -c 200` → HTML
   （paperbox 已在 8077 运行；如未运行，先提示，不要改它的代码。）
3. 上传链路（需要 paperbox 真跑，且不修改 paperbox 的代码）：
   - `curl -s http://127.0.0.1:8088/api/ui/config` → 6 个调参键
   - `curl -s http://127.0.0.1:8088/api/ui/jobs/queue` → 真实队列深度（不是 404 / 不被 `{job_id}` 吞掉）
   - `curl -F files=@a.pdf -F files=@b.pdf http://127.0.0.1:8088/api/ui/ingest/files` → 202 + 逐文件 `results`
   - 把 paperbox 用 `INGEST_UPLOAD_CONCURRENCY=1` 启动，同时发 3 个上传 → 期望 1 个 202 + 2 个 `429 + Retry-After`
   - 浏览器里上传 6 个 PDF：确认**同时 2 个在途**、摘要出现过 `上传 x/y · 处理 a/b`、
     最终 6 个作业 COMPLETED；随后删掉探针论文，核对论文数 / doc 数 / 对象数回到导入前的基线
4. 2026-09-23 的四项能力（paperbox 真跑，把真实输出贴进最终回复）：
   - `curl -s "http://127.0.0.1:8088/api/ui/jobs?limit=2&offset=0"` 与 `?stage=FAILED`
     → 回显 `total/limit/offset/stage`，两页不重复（`offset` 真的生效）
   - `curl -s "http://127.0.0.1:8088/api/ui/consistency?limit=50"` → 总数与漂移数
     （真机基线：68 存活 / 68 对象 / 2883 文档 / 0 漂移）
   - `curl -s -X POST "http://127.0.0.1:8088/api/ui/search" -H 'Content-Type: application/json'`
     带 `filters` 新键（如 `{"paper_type":["journal"]}`）→ 200；带非法 `identifier`
     （如 `nope:1`）→ 上游 422 原文
   - `curl -s -X POST "http://127.0.0.1:8088/api/ui/metadata/import?dry_run=true"`
     上传一份最小记录文件 → 报告 `dry_run=true`，且**库里的行数不变**
   - `curl -s "http://127.0.0.1:8088/api/ui/metadata/review?limit=5"` → 清单（可为空数组）
   - 浏览器打开四个 Tab 各点一遍：任务翻页 / 一致性检查 / 元数据试运行 + 复核清单

## 7. 执行纪律

- 分阶段 commit（Conventional Commits）：先后端+测试，再前端+README。
- `README.md` 写清：前置条件（paperbox 需在 8077 运行）、`uv sync`、启动命令、端口、每个页面的用途、测试命令。
- 新增依赖一律 `uv add`（fastapi、uvicorn[standard]、httpx、pydantic-settings、python-multipart、pytest），
  提交 `uv.lock`。
- 不要提交 `.env`、`.venv`、`*.log`。
