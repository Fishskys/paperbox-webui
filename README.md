# paperbox-webui

给 **paperbox**（论文知识服务 REST API，其后端仓库另行维护）做的**简易 WebUI**，用来人工测试它的全部功能：
导入论文、混合检索、浏览论文库、查看证据片段、重建索引、软删除。

- 前端：原生 HTML/CSS/JS（**无构建步骤、无 CDN、离线可用**），单页 + 六个 Tab
- 后端：FastAPI + httpx，只做**代理**——浏览器只访问本服务的 `/api/ui/*`，
  由后端带 `Authorization: *** 转发给 paperbox，**API Key 不出服务端**（也就不用配 CORS）
- 依赖与环境：**uv** 管理（`pyproject.toml` + `uv.lock` + `.python-version`）

```
浏览器 ──► paperbox-webui :8088 ──►(Bearer)──► paperbox API :8077
```

## 1. 前置条件

**时区**：与 paperbox 同口径，全栈统一 `Asia/Shanghai`（`webui/config.py` 导入期设定，`.env` 的
`TZ` 可覆盖）。WebUI 只打访问日志，但对时间一不一致的排查往往从这一侧开始 —— 两边偏移不同时，
最先被怀疑的总是"谁写的时间不对"。

paperbox 必须先在 **8077** 端口运行（它的依赖服务 PostgreSQL / OpenSearch / MinIO / Embedding
由 paperbox 一侧自行启动，本仓库不含这些组件），且版本不早于 **0.5.0**
（基线契约与逐条依据见 [`docs/architecture/01-paperbox-contract.md`](docs/architecture/01-paperbox-contract.md)）。
本 WebUI 依赖的关键契约：

- `/api/papers/ingest/{file,files}`、`429 + Retry-After`、`/api/jobs/queue` 与 `QUEUED` 阶段（2026-09-19/20 起）；
- `/api/consistency` 与 `/api/metadata/*`、`GET /api/jobs` 的 `offset`/`stage`、`POST /api/jobs/{id}/retry`（2026-09-22/23 起）；
- 检索响应的 `candidates` / `backend`、请求体 `rerank` 开关（0.2.0 起）；
- 鉴权开关 `AUTH_ENABLED` 与三档密钥（0.4.0 起）——**WebUI 需要一把 `admin` key**，见 第 2 节；
- `/api/consistency` 的 `embedding_models` 普查与 `embedding_model_mismatch` 问题码、413/415 等失败码（0.4.1 起）；
- `POST /api/papers/reindex`（整库重建，先 `dry_run=true` 报告、再 `dry_run=false` 排队）、
  `POST /api/papers/{id}/metadata/conflicts/dismiss` 与 `metadata/rollback`（两条人工裁决）、
  以及 `GET /health` 的第五项 `docling`（0.5.0 起）：

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

`PAPERBOX_API_KEY` **不是**随便填的：paperbox 开了鉴权（`AUTH_ENABLED=true`）后，本 WebUI 需要一把
**`admin` 档位**的 key（它代理了删除等写操作）。在 paperbox 目录签发，把打印出来的密钥填进本仓库的 `.env`：

```powershell
cd <paperbox 目录>
uv run python scripts/manage_keys.py create --name paperbox-webui --prefix webui --role admin
uv run python scripts/manage_keys.py list      # 复核：prefix=webui、role=admin
```

密钥**只写 `.env`**（已在 `.gitignore` 第 1 行，任何情况下不进 git；`.env.example` 只有占位值）。
换 key：create 新前缀 → 改 `.env` → 重启 WebUI → `revoke` 旧前缀。

浏览器打开 **http://127.0.0.1:8088/**。

`.env` 项：

| 变量 | 说明 |
|------|------|
| `PAPERBOX_API_BASE` | paperbox 地址，默认 `http://127.0.0.1:8077` |
| `PAPERBOX_API_KEY` | paperbox 签发的 `admin` key（见上）。**不再复用** paperbox 的 `PAPER_API_KEY` |
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

单页 + 六个 Tab，顶部一条常驻状态条。下面按 Tab 说明用途（界面截图未随仓库发布，
本机起来后打开 <http://127.0.0.1:8088/> 即可看到）：

顶部状态条：paperbox 四个依赖（postgres/opensearch/minio/embedding）的健康徽标、
论文总数、任务总数、paperbox 版本，每 15 秒自动刷新（也可点「刷新」）。

**① 检索** — 查询框 + 模式（hybrid / keyword / semantic）+ top_k + 年份范围，
以及作者 / 期刊 / DOI / arXiv / 标签过滤。展开「更多过滤」还有 2026-09-22 后端新增的
**会议/期刊届（`venue_year`）/ 论文类型（`paper_type`，多选）/ 标识符（`scheme:value`）/
四类索引词（`ieee_terms` / `author_terms` / `dynamic_index_terms` / `source_tags`）**。
结果卡片给出标题、作者、年份、venue 与那一届、卷(期)、页码、发表日期、DOI（有值才显示这一行）、
score（按本次查询归一化的 0~1）与 relevance 徽标（high/medium/low），
并列出 evidence 片段（页码 + 章节 + 文本，可展开）。

摘要行显示**后端 / 命中论文数 / 候选数 / 精排状态 / 总耗时**与生效的过滤项数：

- **精排默认关**（与 paperbox 的默认一致）。勾上才发 `"rerank": true`，并显示精排模型与它自己的耗时
  （int8 档一次池约 2–5 s）；三种状态分得很清：没勾 = 「精排 关」，勾了但服务端没跑起来 =
  「精排 未生效」，跑了 = 模型 + 毫秒。`rerank.enabled` 只代表服务端配置了精排，不是「跑过了」。
- **后端覆盖**默认「默认（SEARCH_BACKEND）」= 不发 `backend` 字段；选了 `native` / `python` 才发。

- 标识符必须是 `scheme:value`（`doi` / `arxiv` / `ieee_article_number` / `issn` / `isbn` / `pmid` /
  `openalex` / `semantic_scholar` / `url` / `sha256`）：**写错的项会就地忽略并提示**，
  不会让整次检索吃一个 422。空字段一律不发（不是发 `null`）。
- 这些过滤读的是**索引时的元数据快照**，不是 PostgreSQL 当前值：改完元数据要跑
  paperbox 的 `scripts/refresh_index_metadata.py`（秒级，不重算向量）或对论文 reindex，
  过滤才会反映新值 —— 界面上的提示是同一句话。

**② 论文库** — 表格列出全部论文（标题 / 年份 / 状态 / 作者数 / 创建时间），
支持状态过滤与标题搜索、20 条一页的分页；每行可「详情 / 下载原文 / 重建索引 / 删除」
（删除需二次确认，是软删除）。

表格下面有一张 **「重建全库索引」** 卡片（对齐 paperbox 0.5.0 的 `POST /api/papers/reindex`）：
点一下先**预览** —— 「N 篇待重建」徽标、每条检测理由（换 embedding 模型 / 换解析器 / 未决降级 /
缺 chunk）、以及当前 embedding 模型与解析戳的普查，确认按钮上直接把篇数写出来
（「确认：排队重建这 30 篇」），确认后弹出一次 `confirm` 才排队，排完跳到「任务」页。
界面刻意只放**整库**重建（请求体只有 `include_all`）—— 只重建某几篇是 paperbox 的
`scripts/reindex.py` 的事。讲人话的部分在 `webui/static/reindex-logic.js`：原因码翻译、
影响面文案、"什么都不用重建"也是一个明确答案（不是转圈）。

**③ 导入** — 三个入口：URL 输入框、**多选本地 PDF 组成上传队列**（也可直接把文件 / 整个文件夹拖进投放区），
以及两张独立的卡片：

- **目录导入**（服务端路径、零传输）：填的是 **paperbox 那台机器上的绝对路径**，不是浏览器里的文件夹。
  可设 `glob` / 递归 / 上限（≤2000），「试运行」不勾时会真的建作业。端点只在 paperbox 的
  `INGEST_LOCAL_ROOTS` 非空时存在（否则 404 + 可读文案），root 越界是 403（与 key 档位问题分开说）。
- **zip 批量导入**：上传一个 `.zip`，paperbox 逐个解包入库；**只认 zip**，7z/rar/tar 会被 415 拒掉。
  两份报告各自按 paperbox 的字段渲染（目录 = `matched/accepted/duplicate/rejected/skipped`；
  压缩包 = `entries_total/ignored/rejected` + 结果），不套用 `/files` 的结构。
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

**④ 任务** — 任务表格，**服务端分页**：每页 10 / 20 / 50 / 100 / 200 条，
「上一页 / 下一页」按 `limit` + `offset` 取数，页码与总数（`第 x / y 页 · 共 N 条`）直接来自后端的 `total`。
过滤：阶段（十个阶段任选）+ `paper_id`。每行显示 job_id（**点击复制**）、阶段徽标、进度条、
是否重复、`error_code` + `error_message`、论文（可点开详情抽屉 / 复制 paper_id）、
创建 / 更新 / 完成时间与**耗时**（没有 `finished_at` 就显示「进行中」）；
`FAILED` 的行有「重试」按钮（二次确认后 `POST /api/ui/jobs/{id}/retry`，
后端 409 表示该作业不是 FAILED，原文显示）。可勾选「每 5 秒自动刷新」，自动刷新保持当前页。

**⑤ 一致性** — 三端只读对账（PostgreSQL / MinIO / OpenSearch）：一个「开始检查」按钮 +
问题条目上限（1..1000，默认 200）+「每 30 秒自动检查」。结论区给出
`一致 / 有漂移` 徽标、检查时间、耗时、索引名与是否存在，以及一组**永远精确**的总数
（论文含已删 / 存活 / 已删 / 文件行 / 对象 / chunk 行 / 文档 / staging 残留 / 不一致论文 / 孤儿对象 / 孤儿文档）；
下表逐篇列出漂移（文件 PG↔MinIO、chunk PG↔OS、**向量模型**、问题徽标、缺失对象、孤儿对象），
论文可点开详情抽屉；store 级孤儿单列一卡。
另有一块 **embedding 模型普查**（0.4.1 的 `embedding_models`）：按 `chunks` / `documents` 两个来源分别列出
各向量模型的数量；两侧模型集合不一致或有 `unknown`（早于 `embedding_model` 字段的记录）时会给出
「换模型只换了一半」的提醒 —— 那批向量彼此不可比，得整库重嵌。**九个问题码**都有中文说明
（`parser_stamp_mismatch`、`embedding_model_mismatch` 是 0.4.x 新增的两个），认不出的码原样显示而不是消失。**某个 store 连不上时它出现在 `errors` 横条里，另外两端照常给结论** ——
这是 paperbox 的语义，界面不会因此变成错误页。

**⑥ 元数据** — 元数据导入闭环：
1. **导入**：选来源类型（`import_file` 默认 / `ieee_api` / `crossref` / `arxiv_api` / `manual`）、
   选 JSON 文件或直接粘贴 JSON、可选条数上限；「试运行（不写库）」是默认路径，
   「导入并应用」会二次确认。报告区显示 total / matched / created_shell / ambiguous / unmatched / unchanged、
   识别出的格式、是否写库；**导入报告与字段冲突是两张独立卡片**（此前挤在一块，长到把下面的
复核清单与批量应用顶出屏幕），各自**分页**展示、每页条数可配（来源默认 5、字段冲突默认 3），
排序把 `unmatched` / `ambiguous` 顶到前面；「清空」一次清掉报告与字段冲突两块
（只清界面状态，不碰数据库）。
2. **复核清单**：`GET /api/ui/metadata/review` 列出待人工决定的来源记录（可只看 `ambiguous`），
   每行填 `paper_id` 后点「挂载」即 `POST .../attach`，成功后显示合并了哪些字段并刷新清单。
   **库内字段冲突**那张表每行有「操作」列，两个裁决动词分别对应 paperbox 的两条路：
   「采纳被拒值」（`POST /api/ui/papers/{id}/metadata/rollback`）与「保留现值」
   （`POST /api/ui/papers/{id}/metadata/conflicts/dismiss`）—— 值都不动、声明都不删，
   只决定谁生效 / 这条分歧是否还开着，裁决过的那条不再出现在清单里（所以清单是能清空的）；
   试运行产生的条目没有 `provenance_id`，那一格显示「试运行未落库」而不是给个点了没用的按钮。
3. **批量应用**：把「哪份来源属于哪篇论文」的判定成批发给 `POST /api/metadata/apply`；
   可从上次报告的 `source_ref` 一键预填 entries，`overwrite` 模式会二次确认。

**论文详情抽屉** — 从任意页面打开：元数据（作者、年份、DOI、arXiv、状态、指纹、时间）、
文件列表、chunks 分页列表（chunk 序号、页码范围、章节、文本），并提供下载原文 / 重建索引 / 删除。
按 `Esc`、点遮罩或点「关闭」都能收起。

## 4. 后端 API（全部在 `/api/ui` 下）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ui/health` | paperbox 五个依赖状态（含 `docling`，可为 `disabled`）+ 论文/任务计数 |
| GET | `/api/ui/config` | 上传队列调参（并发 / 重试 / 上限），前端启动时读取 |
| GET | `/api/ui/papers` | 论文列表：`limit` `offset` `status` `q` |
| GET | `/api/ui/papers/{id}` | 论文元数据 |
| GET | `/api/ui/papers/{id}/chunks` | 论文 chunks：`limit` `offset` |
| GET | `/api/ui/papers/{id}/file` | 原文 PDF（流式转发） |
| POST | `/api/ui/papers/reindex` | **整库重建索引**：请求体原样转发给 paperbox（默认 `dry_run=true` 只报告），`job_ids` 逐个返回 |
| POST | `/api/ui/papers/{id}/reindex` | 重建该论文索引，返回 `job_id` |
| DELETE | `/api/ui/papers/{id}` | 软删除 |
| GET | `/api/ui/jobs` | 任务列表：`limit`（1..200）`offset` `stage` `paper_id`，响应回显窗口与 `total` |
| GET | `/api/ui/jobs/queue` | paperbox 队列深度（`running` / `queued` / 优先级分布） |
| GET | `/api/ui/jobs/{id}` | 单个任务状态 |
| POST | `/api/ui/jobs/{id}/retry` | 重试失败作业（后端 409 = 不是 FAILED） |
| GET | `/api/ui/consistency` | 三端对账：`limit`（问题条目上限），只读、**永不抛** |
| POST | `/api/ui/metadata/import` | 元数据导入：multipart `file` 或 JSON 体，`dry_run`（默认 true）`apply` `source_type` `limit` |
| GET | `/api/ui/metadata/review` | 待人工决定的来源记录：`status` `limit` |
| POST | `/api/ui/metadata/sources/{source_id}/attach` | 把某份来源挂到论文：`{"paper_id": "..."}` |
| POST | `/api/ui/papers/{id}/metadata/conflicts/dismiss` | 裁决「保留现值」：`{"field":"...","provenance_id":"..."}` |
| POST | `/api/ui/papers/{id}/metadata/rollback` | 裁决「采纳被拒值」：同上两个字段 |
| POST | `/api/ui/metadata/apply` | 批量应用判定：`{"entries": [...], "mode": "fill\|overwrite"}` |
| POST | `/api/ui/ingest` | URL 导入：`{"source_type":"url","source":"..."}`（也接受 `{"url":"..."}`） |
| POST | `/api/ui/ingest/file` | 本地上传（旧端点）：multipart 字段 `file` |
| POST | `/api/ui/ingest/files` | 本地上传（新端点）：multipart 字段 `files`，可重复，逐文件结果 |
| POST | `/api/ui/ingest/dir` | 目录导入（**paperbox 机器上的路径**，零传输）：`{"root","glob","recursive","limit","dry_run"}`，默认 `dry_run=false` |
| POST | `/api/ui/ingest/compressed` | zip 批量导入：multipart 字段 `file`，只认 zip（其余 415） |
| POST | `/api/ui/search` | 检索：`{"query","mode","top_k","rerank","backend","filters":{...}}`；`rerank` 默认 `false` |

错误约定：paperbox 返回的 4xx/5xx 会**原样透传**（状态码 + `{"detail": ...}`），
**包括 429 的 `Retry-After` 响应头**（上传队列的退避全靠它）；
已知的失败模式会**额外**带一条 `hint`（可照着做的中文说明）：401 / 403（分「档位不足」与
「目录越界」两种）/ 404（分「端点未开启」与「root 不是目录」）/ 413（分「总字节」与「JSON 体」）/
415 / 422 / 429（附 `Retry-After` 秒数）/ 502；**认不出的状态码不加 hint**，原文透传。
paperbox 不可达时返回 `502` + `{"detail": "paperbox unreachable: ..."}`（同样带 hint）；
`/api/ui/health` 在 paperbox 挂掉时仍返回 200，但把错误放在 `paperbox.error` 里，
这样页面上的状态条能显示「不可用」而不是整个页面报错。

## 5. 测试

```powershell
uv run pytest                      # 后端 + 静态守卫 + 调起 node 测试
node --test tests/js/*.test.mjs    # 纯前端逻辑（pytest 里也会跑一遍）
```

`uv run pytest` 目前 **101** 个用例，全部用 `httpx.MockTransport` 造假 paperbox，**不需要真实服务**：
健康聚合与降级、参数透传（分页/状态/标题搜索/chunks/任务）、错误透传与 502、检索请求体逐字转发、
导入 URL 的两种请求体与非法输入、multipart 上传、`/ingest/files` 多文件代理与逐文件结果、
`/ingest/dir` 与 `/ingest/compressed` 的代理与默认值一致性、`Retry-After` 透传（有/无）、
鉴权三态（401 / 403 不匹配 / 403 `insufficient role`）与 0.4.x 失败文案（413 两处、415、403-root、
404 两种、422、429、502）、`/api/ui/config`、`/api/ui/jobs/queue` 的路由顺序、
任务分页参数与 `total` 透传、失败作业重试的 409 原文透传、
一致性报告（含 `errors` 时仍 200）、元数据 import/review/attach/apply 的四种请求体、
整库重建的转发（`/api/ui/papers/reindex`，含"请求体原样透传、不替 paperbox 决定 `dry_run`"）与
两条冲突裁决路由的转发，
原文流式下载、首页 HTML，以及静态资源守卫（多选上传队列的 DOM 结构、`app.js` 里的队列实现与
新端点、检索过滤字段与六个 Tab 的页面骨架、六个 `*-logic.js` 的加载顺序与导出，
「重建全库索引」的 DOM 与只发 `include_all`、冲突行渲染恒 5 格）。

`tests/js/` 下是 **77** 个 `node:test` 用例，纯逻辑真跑：
`queue_logic.test.mjs`（14）覆盖 `parseRetryAfter`、`retryDelayMs`（Retry-After 优先 / 指数增长 /
抖动范围 / 上限）、`summarizeProgress`、`uploadSlots`、`shouldSuggestServerSide`；
`search_logic.test.mjs` 覆盖过滤体构造（空值不发、`scheme:value` 校验、年份解析、多选标签）、
检索请求体（`rerank` 默认关且恒为布尔、`backend` 只在选了覆盖值才发）与命中摘要（候选数、
精排三态）；
`jobs_logic.test.mjs` 覆盖分页换算（`ceil(total/limit)`、`offset` 越界夹到最后一页、上一页/下一页可用性）
与耗时文案（无 `finished_at` 即「进行中」）；
`consistency_logic.test.mjs` 覆盖九个问题码的中文映射、普查摊平与「换模型只换一半」告警；
`metadata_logic.test.mjs`（18）覆盖分页换算、排序（`unmatched` → `ambiguous` → 其余）、
导入报告与字段冲突两份行渲染的格数（冲突行恒 5 格：含「操作」列）与摘要去重；
`reindex_logic.test.mjs`（9）覆盖原因码翻译、影响面文案（确认按钮上直接写篇数）、
普查文案，以及两条容易做错的：**认不出的原因码要原样显示**，**"无需重建"要是个正常答案**
而不是转圈。

真机验收（并发在途数、429 退避、两阶段进度、`QUEUED`、停止语义、收尾基线）的实测输出见
[`docs/examine/acceptance-upload.md`](docs/examine/acceptance-upload.md)；2026-09-23 四项新能力
（搜索选项 / 一致性 / 元数据导入 / 任务分页）的实测输出见
[`docs/examine/acceptance-2026-09-23.md`](docs/examine/acceptance-2026-09-23.md)；
**对齐 paperbox 0.4.1 的验收（2026-10-08，含精排开关、embedding 普查、五条失败文案、
真机 429）见 [`docs/examine/acceptance-2026-10-08.md`](docs/examine/acceptance-2026-10-08.md)**；
**对齐 paperbox 0.5.0 的验收（2026-10-10，含整库重建按钮、冲突操作列、导入报告解耦分页、
docling 一格、静态资源 no-cache）见
[`docs/examine/acceptance-2026-10-10.md`](docs/examine/acceptance-2026-10-10.md)**。

## 6. 目录

```
webui/
  main.py            FastAPI app：静态文件 + /api/ui 路由挂载
  config.py          pydantic-settings（读 .env，含上传队列调参）
  client.py          PaperboxClient（httpx.AsyncClient 封装，携带 Bearer）
  routers/           system / config / papers / jobs / ingest / search / actions /
                     consistency / metadata / deps
  static/            index.html  app.js  search-logic.js  jobs-logic.js
                     queue-logic.js  consistency-logic.js  style.css（无构建）
tests/               后端代理层单测（MockTransport）+ tests/js 的 node:test
docs/architecture/   活文档：00-overview（入口/文档地图）、01-paperbox-contract（契约基线）、
                     MVP-SPEC（实现规范）
docs/examine/        真机验收与审查快照（只增不改）
docs/progress/       项目级进度（批次、提交、基线读数、未决项）
docs/old/            被取代的活文档（NAME-YYYYMMDD.md）
README.md            本文件
```

前端只加载**静态文件**，没有构建步骤：`search-logic.js`、`jobs-logic.js`、`queue-logic.js`、`consistency-logic.js`
是"会算错"的纯逻辑（浏览器挂 `window.Paperbox*`，node 走 `module.exports`，由 `tests/js/` 真跑），
`app.js` 只做 DOM 接线，`style.css` 是全部样式。

## 7. 许可

MIT，见 `LICENSE`。
