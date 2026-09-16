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
    papers.py        GET  /api/ui/papers, /api/ui/papers/{id},
                          /api/ui/papers/{id}/chunks, /api/ui/papers/{id}/file
    jobs.py          GET  /api/ui/jobs, /api/ui/jobs/{id}
    ingest.py        POST /api/ui/ingest (JSON url), POST /api/ui/ingest/file (multipart)
    search.py        POST /api/ui/search
    actions.py       POST /api/ui/papers/{id}/reindex, DELETE /api/ui/papers/{id}
  static/
    index.html  app.js  style.css
tests/
  __init__.py  test_client.py  test_routes.py
```

## 2. 配置（.env，已存在真实值）

```
PAPERBOX_API_BASE=http://127.0.0.1:8077
PAPERBOX_API_KEY=<真实 key，已在 .env>
WEBUI_HOST=0.0.0.0
WEBUI_PORT=8088
REQUEST_TIMEOUT=30
```

## 3. 后端要求

- `PaperboxClient`：`AsyncClient`，默认带 `Authorization: Bearer <key>`；方法：
  `health()`、`list_papers(limit, offset, status, q)`、`get_paper(id)`、
  `get_paper_file(id) -> (bytes, headers)`（流式）、`get_chunks(id, limit, offset)`、
  `list_jobs(limit, paper_id)`、`get_job(id)`、`ingest_url(url)`、`ingest_file(filename, content, content_type)`、
  `search(payload)`、`reindex(id)`、`delete_paper(id)`。
- **错误透传**：paperbox 返回非 2xx 时，把其状态码与 `{"detail": ...}` 原样返回给前端
  （不要吞成 500）；paperbox 不可达时返回 HTTP 502 + `{"detail": "paperbox unreachable: ..."}`。
- 超时：普通 30s，ingest 60s；文件下载用 `StreamingResponse` 转发（附
  `Content-Disposition` 与 `Content-Type`）。
- `GET /api/ui/health` 返回：
  `{"paperbox": {...paperbox /health 的 services...}, "version": "...", "papers": N, "jobs": N}`
  （统计用 paperbox 的 `GET /api/papers` 与 `GET /api/jobs` 的 `total`；任一失败不要让整个接口 500）。
- `GET /` 返回 `webui/static/index.html`；静态目录挂到 `/static`。

## 4. 前端要求（单页，中文界面）

顶部状态条：paperbox 健康徽标（postgres/opensearch/minio/embedding 四项 ok/error）+ 论文数 + 任务数，
每 15s 自动刷新。

**Tab 1「检索」**：查询框、模式（hybrid/keyword/semantic，默认 hybrid）、top_k（默认 10）、
年份 from/to、作者/期刊/DOI/arXiv/标签过滤 → 结果卡片：标题（可点开详情）、作者、年份、
score（0~1）与 relevance 徽标（high/medium/low 用不同颜色）、evidence 列表（页码 + 章节 + 文本，默认折叠）；
显示耗时与命中论文数。

**Tab 2「论文库」**：表格（标题 / 年份 / 状态 / 作者数 / 创建时间），支持状态过滤 + 标题搜索 + 分页
（20/页）；每行操作按钮：详情、下载原文、重建索引、删除（二次确认）。

**Tab 3「导入」**：URL 输入框 + 文件选择（multipart），提交后显示 job_id 与进度条；
每 2s 轮询 `GET /api/ui/jobs/{id}`，把 stage 映射成可读步骤
（RECEIVED→DOWNLOADING→STORED→PARSING→CHUNKING→EMBEDDING→INDEXING→COMPLETED，FAILED 显示 error_message）；
完成/重复时给出论文链接（可跳到详情）。

**Tab 4「任务」**：最近任务表格（stage / progress / duplicate / error_message / 时间），可手动刷新。

**论文详情面板**（从任意 Tab 打开）：标题、作者、年份、DOI/arXiv、状态、指纹、文件列表；
chunks 分页列表（显示 chunk_index、页码范围、章节、文本前若干行，可展开全文）；「下载原文」「重建索引」「删除」。

样式：纯 CSS、深浅色舒适可读、无外部字体/CDN；不要引入构建工具。

## 5. 测试要求（tests/）

- 用 `httpx.MockTransport` 造假 paperbox 响应，**不连真实服务**。
- 至少覆盖：`/api/ui/health` 汇总；`/api/ui/papers` 参数透传（limit/offset/status/q）；
  paperbox 4xx/5xx 的错误透传；paperbox 不可达 → 502；`/api/ui/search` 请求体透传；
  `POST /api/ui/ingest` 与文件上传的参数传递。
- `uv run pytest` 必须全绿。

## 6. 验证要求（必须真跑，把真实输出写进最终回复）

1. `uv run pytest` 全绿。
2. 后台起 `uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088`，然后：
   - `curl -s http://127.0.0.1:8088/api/ui/health` → 四个依赖 ok + papers/jobs 统计
   - `curl -s "http://127.0.0.1:8088/api/ui/papers?limit=5"` → 4 篇论文
   - `curl -s -X POST http://127.0.0.1:8088/api/ui/search -H 'Content-Type: application/json' -d "{\"query\":\"attention\",\"mode\":\"hybrid\",\"top_k\":3}"` → 带 evidence 的结果
   - `curl -s http://127.0.0.1:8088/ | head -c 200` → HTML
   （paperbox 已在 8077 运行；如未运行，先提示，不要改它的代码。）

## 7. 执行纪律

- 分阶段 commit（Conventional Commits）：先后端+测试，再前端+README。
- `README.md` 写清：前置条件（paperbox 需在 8077 运行）、`uv sync`、启动命令、端口、每个页面的用途、测试命令。
- 新增依赖一律 `uv add`（fastapi、uvicorn[standard]、httpx、pydantic-settings、python-multipart、pytest），
  提交 `uv.lock`。
- 不要提交 `.env`、`.venv`、`*.log`。
