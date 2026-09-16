# paperbox-webui

给 **paperbox**（论文知识服务 REST API，其后端仓库另行维护）做的**简易 WebUI**，用来人工测试它的全部功能：
导入论文、混合检索、浏览论文库、查看证据片段、重建索引、软删除。

- 前端：原生 HTML/CSS/JS（**无构建步骤、无 CDN、离线可用**），单页 + 四个 Tab
- 后端：FastAPI + httpx，只做**代理**——浏览器只访问本服务的 `/api/ui/*`，
  由后端带 `Authorization: Bearer` 转发给 paperbox，**API Key 不出服务端**（也就不用配 CORS）
- 依赖与环境：**uv** 管理（`pyproject.toml` + `uv.lock` + `.python-version`）

```
浏览器 ──► paperbox-webui :8088 ──►(Bearer)──► paperbox API :8077
```

## 1. 前置条件

paperbox 必须先在 **8077** 端口运行（它的依赖服务 PostgreSQL / OpenSearch / MinIO / Embedding
由 paperbox 一侧自行启动，本仓库不含这些组件）：

```powershell
cd <paperbox 后端目录>
uv run uvicorn app.main:app --host 0.0.0.0 --port 8077
```

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

**③ 导入** — URL 导入或选择本地 PDF 上传；提交后显示 job_id 与进度条，
每 2 秒轮询任务阶段：`RECEIVED → DOWNLOADING → STORED → PARSING → CHUNKING →
EMBEDDING → INDEXING → COMPLETED`（失败显示错误信息）。重复论文会提示 duplicate
并直接给出已有论文。

**④ 任务** — 最近任务表格（阶段 / 进度 / 是否重复 / 错误 / 时间），可手动刷新。

**论文详情抽屉** — 从任意页面打开：元数据（作者、年份、DOI、arXiv、状态、指纹、时间）、
文件列表、chunks 分页列表（chunk 序号、页码范围、章节、文本），并提供下载原文 / 重建索引 / 删除。
按 `Esc`、点遮罩或点「关闭」都能收起。

## 4. 后端 API（全部在 `/api/ui` 下）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ui/health` | paperbox 四个依赖状态 + 论文/任务计数 |
| GET | `/api/ui/papers` | 论文列表：`limit` `offset` `status` `q` |
| GET | `/api/ui/papers/{id}` | 论文元数据 |
| GET | `/api/ui/papers/{id}/chunks` | 论文 chunks：`limit` `offset` |
| GET | `/api/ui/papers/{id}/file` | 原文 PDF（流式转发） |
| POST | `/api/ui/papers/{id}/reindex` | 重建该论文索引，返回 `job_id` |
| DELETE | `/api/ui/papers/{id}` | 软删除 |
| GET | `/api/ui/jobs` | 最近任务：`limit` `paper_id` |
| GET | `/api/ui/jobs/{id}` | 单个任务状态 |
| POST | `/api/ui/ingest` | URL 导入：`{"source_type":"url","source":"..."}`（也接受 `{"url":"..."}`） |
| POST | `/api/ui/ingest/file` | 本地上传：multipart 字段 `file` |
| POST | `/api/ui/search` | 检索：`{"query","mode","top_k","filters":{...}}` |

错误约定：paperbox 返回的 4xx/5xx 会**原样透传**（状态码 + `{"detail": ...}`）；
paperbox 不可达时返回 `502` + `{"detail": "paperbox unreachable: ..."}`；
`/api/ui/health` 在 paperbox 挂掉时仍返回 200，但把错误放在 `paperbox.error` 里，
这样页面上的状态条能显示「不可用」而不是整个页面报错。

## 5. 测试

```powershell
uv run pytest
```

22 个测试，全部用 `httpx.MockTransport` 造假 paperbox，**不需要真实服务**：健康聚合与降级、
参数透传（分页/状态/标题搜索/chunks/任务）、错误透传与 502、检索请求体逐字转发、
导入 URL 的两种请求体与非法输入、multipart 上传、原文流式下载、首页 HTML。

## 6. 目录

```
webui/
  main.py            FastAPI app：静态文件 + /api/ui 路由挂载
  config.py          pydantic-settings（读 .env）
  client.py          PaperboxClient（httpx.AsyncClient 封装，携带 Bearer）
  routers/           system / papers / jobs / ingest / search / actions / deps
  static/            index.html  app.js  style.css（无构建）
tests/               后端代理层单测（MockTransport）
SPEC.md              本项目的实现规范
```

## 7. 许可

MIT，见 `LICENSE`。
