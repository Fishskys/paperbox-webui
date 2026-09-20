# paperbox-webui

给 **paperbox**（论文知识服务 REST API，其后端仓库另行维护）做的**简易 WebUI**，用来人工测试它的全部功能：
导入论文、混合检索、浏览论文库、查看证据片段、重建索引、软删除。

- 前端：原生 HTML/CSS/JS（**无构建步骤、无 CDN、离线可用**），单页 + 四个 Tab
- 后端：FastAPI + httpx，只做**代理**——浏览器只访问本服务的 `/api/ui/*`，
  由后端带 `Authorization: *** 转发给 paperbox，**API Key 不出服务端**（也就不用配 CORS）
- 依赖与环境：**uv** 管理（`pyproject.toml` + `uv.lock` + `.python-version`）

```
浏览器 ──► paperbox-webui :8088 ──►(Bearer)──► paperbox API :8077
```

## 1. 前置条件

paperbox 必须先在 **8077** 端口运行（它的依赖服务 PostgreSQL / OpenSearch / MinIO / Embedding
由 paperbox 一侧自行启动，本仓库不含这些组件），且版本不早于 2026-09-19
（本 WebUI 依赖 `/api/papers/ingest/files`、`429 + Retry-After`、`/api/jobs/queue` 与 `QUEUED` 阶段）：

```powershell
cd <paperbox 后端目录>
uv run uvicorn app.main:app --host 127.0.0.1 --port 8077 --workers 1
```

（paperbox 的导入流水线在进程内，**单 worker**；WebUI 本身无此限制。）

## 2. 安装与启动

```powershell
cd <本仓库目录>
uv sync                                  # 按 uv.lock 建 .venv 并装依赖
copy .env.example .env                   # 首次：填 PAPERBOX_API_BASE / PAPERBOX_API_KEY
uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088
```

浏览器打开 **http://127.0.0.1:8088/**。

`.env` 项：

| 变量 | 说明 |
|------|------|
| `PAPERBOX_API_BASE` | paperbox 地址，默认 `http://127.0.0.1:8077` |
| `PAPERBOX_API_KEY` | 与 paperbox `.env` 里的 `PAPER_API_KEY` 一致 |
| `WEBUI_HOST` / `WEBUI_PORT` | 本服务监听地址与端口（默认 `0.0.0.0:8088`） |
| `REQUEST_TIMEOUT` | 普通请求超时秒数（默认 30；导入用 60） |
| `WEBUI_UPLOAD_CONCURRENCY` | 上传队列的同时在途请求数（默认 **2**）。**保持 ≤ paperbox 的 `INGEST_UPLOAD_CONCURRENCY`**（默认也是 2），调大只会吃到 429 |
| `WEBUI_UPLOAD_MAX_ATTEMPTS` | 429 重试上限（默认 6），超过判该项失败 |
| `WEBUI_RETRY_BASE_MS` / `WEBUI_RETRY_CAP_MS` | 无 `Retry-After` 时的指数退避基数与上限（默认 2000 / 60000 ms） |
| `WEBUI_FILE_MAX_MB` | 前端就地拒绝的文件上限（默认 100，与 paperbox 的 `INGEST_MAX_FILE_MB` 对齐） |
| `WEBUI_BATCH_HINT_THRESHOLD` | 队列达到该长度就提示改用 `/ingest/dir`（默认 20） |

这些键都由 `GET /api/ui/config` 下发给浏览器，前端不硬编码；接口拿不到时前端退回同样的内置默认，
不会因此拒绝上传。

## 3. 界面

单页 + 四个 Tab，顶部一条常驻状态条。下面按 Tab 说明用途（界面截图未随仓库发布，
本机起来后打开 <http://127.0.0.1:8088/> 即可看到）：

顶部状态条：paperbox 四个依赖（postgres/opensearch/minio/embedding）的健康徽标、
论文总数、任务总数、paperbox 版本，每 15 秒自动刷新（也可点「刷新」）。

**① 检索** — 查询框 + 模式（hybrid / keyword / semantic）+ top_k + 年份范围，
以及作者 / 期刊 / DOI / arXiv / 标签过滤。结果卡片给出标题、作者、年份、
score（按本次查询归一化的 0~1）与 relevance 徽标（high/medium/low），
并列出 evidence 片段（页码 + 章节 + 文本，可展开），顶部显示命中论文数与耗时。

**② 论文库** — 表格列出全部论文（标题 / 年份 / 状态 / 作者数 / 创建时间），
支持状态过滤与标题搜索、20 条一页的分页；每行可「详情 / 下载原文 / 重建索引 / 删除」
（删除需二次确认，是软删除）。

**③ 导入** — URL 输入框，或**多选本地 PDF 组成上传队列**（也可直接把文件 / 整个文件夹拖进投放区）。
队列里每一项独立显示状态：待上传 → 上传中 x% → 已提交 → paperbox 阶段
（`RECEIVED → QUEUED → DOWNLOADING → STORED → PARSING → CHUNKING → EMBEDDING → INDEXING → COMPLETED`）→
已完成 / 重复论文 / 失败（失败给出 `error_message`）；URL 与本地上传共用同一条队列。

- **受控并发**：最多 `WEBUI_UPLOAD_CONCURRENCY`（默认 2）个上传请求同时在路上（一个文件一个请求，
  走 `POST /api/ui/ingest/files`）；一个上传拿到 `job_id` 就立刻补位下一个。提交后的作业轮询不占并发位。
- **429 退避**：paperbox 忙时回 `429 + Retry-After`，该项自动退避重试（徽标显示「排队退避 Ns」倒计时），
  **不会**被当成失败；重试超过上限才判失败。
- **两阶段进度**：摘要形如 `共 6 项 · 上传 6/6 · 处理 3/6`（上传 = 文件，处理 = 作业）；
  有在途作业时每 2 秒刷新 paperbox 的队列深度，摘要会追加 `· 服务端排队 q`。
- 队列超过 20 项时提示：上千个文件请改用 paperbox 的 `/ingest/dir`（同机零传输，不必经过浏览器）。
- 「加入后自动开始」默认勾选；**「停止」中止所有在途上传并清掉所有轮询**，
  但 paperbox 没有取消接口，**已提交的作业仍会在后端跑完**；「取消」只中止单项。
- 非 PDF 与超过 `WEBUI_FILE_MAX_MB`（默认 100MB）的文件在前端就地拒绝。

**④ 任务** — 最近任务表格（阶段 / 进度 / 是否重复 / 错误 / 时间），可手动刷新。

**论文详情抽屉** — 从任意页面打开：元数据（作者、年份、DOI、arXiv、状态、指纹、时间）、
文件列表、chunks 分页列表（chunk 序号、页码范围、章节、文本），并提供下载原文 / 重建索引 / 删除。
按 `Esc`、点遮罩或点「关闭」都能收起。

## 4. 后端 API（全部在 `/api/ui` 下）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ui/health` | paperbox 四个依赖状态 + 论文/任务计数 |
| GET | `/api/ui/config` | 上传队列调参（并发 / 重试 / 上限），前端启动时读取 |
| GET | `/api/ui/papers` | 论文列表：`limit` `offset` `status` `q` |
| GET | `/api/ui/papers/{id}` | 论文元数据 |
| GET | `/api/ui/papers/{id}/chunks` | 论文 chunks：`limit` `offset` |
| GET | `/api/ui/papers/{id}/file` | 原文 PDF（流式转发） |
| POST | `/api/ui/papers/{id}/reindex` | 重建该论文索引，返回 `job_id` |
| DELETE | `/api/ui/papers/{id}` | 软删除 |
| GET | `/api/ui/jobs` | 最近任务：`limit` `paper_id` |
| GET | `/api/ui/jobs/queue` | paperbox 队列深度（`running` / `queued` / 优先级分布） |
| GET | `/api/ui/jobs/{id}` | 单个任务状态 |
| POST | `/api/ui/ingest` | URL 导入：`{"source_type":"url","source":"..."}`（也接受 `{"url":"..."}`） |
| POST | `/api/ui/ingest/file` | 本地上传（旧端点）：multipart 字段 `file` |
| POST | `/api/ui/ingest/files` | 本地上传（新端点）：multipart 字段 `files`，可重复，逐文件结果 |
| POST | `/api/ui/search` | 检索：`{"query","mode","top_k","filters":{...}}` |

错误约定：paperbox 返回的 4xx/5xx 会**原样透传**（状态码 + `{"detail": ...}`），
**包括 429 的 `Retry-After` 响应头**（上传队列的退避全靠它）；
paperbox 不可达时返回 `502` + `{"detail": "paperbox unreachable: ..."}`；
`/api/ui/health` 在 paperbox 挂掉时仍返回 200，但把错误放在 `paperbox.error` 里，
这样页面上的状态条能显示「不可用」而不是整个页面报错。

## 5. 测试

```powershell
uv run pytest                      # 后端 + 静态守卫 + 调起 node 测试
node --test tests/js/*.test.mjs    # 纯前端逻辑（pytest 里也会跑一遍）
```

`uv run pytest` 目前 39 个用例，全部用 `httpx.MockTransport` 造假 paperbox，**不需要真实服务**：
健康聚合与降级、参数透传（分页/状态/标题搜索/chunks/任务）、错误透传与 502、检索请求体逐字转发、
导入 URL 的两种请求体与非法输入、multipart 上传、`/ingest/files` 多文件代理与逐文件结果、
`Retry-After` 透传（有/无）、`/api/ui/config`、`/api/ui/jobs/queue` 的路由顺序、
原文流式下载、首页 HTML，以及静态资源守卫（多选上传队列的 DOM 结构、`app.js` 里的队列实现与
新端点、`queue-logic.js` 的加载顺序与导出）。

`tests/js/queue_logic.test.mjs` 是 13 个 `node:test` 用例，覆盖 `parseRetryAfter`、
`retryDelayMs`（Retry-After 优先 / 指数增长 / 抖动范围 / 上限）、`summarizeProgress`、
`uploadSlots`、`shouldSuggestServerSide`。

## 6. 目录

```
webui/
  main.py            FastAPI app：静态文件 + /api/ui 路由挂载
  config.py          pydantic-settings（读 .env，含上传队列调参）
  client.py          PaperboxClient（httpx.AsyncClient 封装，携带 Bearer）
  routers/           system / config / papers / jobs / ingest / search / actions / deps
  static/            index.html  app.js  queue-logic.js  style.css（无构建）
tests/               后端代理层单测（MockTransport）+ tests/js 的 node:test
SPEC.md              本项目的实现规范
```

## 7. 许可

MIT，见 `LICENSE`。
