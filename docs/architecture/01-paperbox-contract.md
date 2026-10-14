# 01 · paperbox 契约基线

本文件记录 WebUI **依赖的 paperbox 契约**：基线版本、当时的事实读出、以及自上个基线以来 paperbox 变了什么、对 WebUI 意味着什么。
每次升级基线时更新本文件，并在 `docs/progress/project.md` 记一笔。

## 1. 当前基线

| 项 | 值 | 核对方式 |
|---|---|---|
| paperbox 版本 | **0.6.0**（commit `f429761`，tag `v0.6.0`，GitHub release 标 Latest） | paperbox 仓库 `git describe --tags` / `CHANGELOG.md` |
| 服务地址 | `http://127.0.0.1:8077`（单 worker；导入流水线在进程内） | `GET /health` → 200 |
| 依赖健康面 | `GET /health` → `services` **六项**（`postgres` / `opensearch` / `minio` / `embedding` / `rerank` / `docling`，取值只有 `ok` / `error` / `disabled` / `unknown`）、`degraded`（**必需**依赖就绪）、`dependencies.<name>`（`reason` / `latency_ms` / `checked_at` / `cached`）。探测**只按需**（启动一次 + 有人调用），结论按 TTL 复用（默认 5 分钟） | `GET /health`（见 第 2 节 O 行） |
| 索引 | 物理 `paper_chunks_v3`，读写走别名 `paper_chunks_current` | `GET /api/consistency` → `index` / `index_exists` |
| 检索后端 | `SEARCH_BACKEND=native`（引擎侧 RRF + 按论文聚合） | 检索响应里的 `backend` |
| 精排 | int8 档 `temsa/mmarco-mMiniLMv2-L12-H384-v1-onnx-cpu-qint8`，`RERANK_MAX_BATCH=4`；**REST 请求的 `rerank` 默认 `false`（需显式开）** | 响应里的 `rerank` 块 |
| 鉴权 | 四档 `public` < `read` < `write` < `admin`（`AUTH_ENABLED=true`）；读门 `AUTH_READ_ACCESS=public`（默认）时读端点不校验凭证，有门时缺凭证 401、不匹配 403、档位不足 403 `insufficient role`；**删除已并入 `write`，`admin` 只剩 `POST /api/papers/reindex`**（0.5.2/0.5.3 起） | `UserManual.md`、paperbox `docs/architecture/07-api.md` 第 2.2 节 |
| 语料（本机） | **30 live / 2302 chunks**，embedding 模型普查 2302 + 2302 同为 `intfloat/multilingual-e5-large`；`problems=0` | `GET /api/consistency` |
| 上一个基线 | 2026-09-23（见 `docs/examine/acceptance-2026-09-23.md`；当时 68 live / 2883 docs）。0.4.1 的验收快照见 `docs/examine/acceptance-2026-10-08.md`、0.5.0 / 0.5.1 见 `docs/examine/acceptance-2026-10-10.md` | 各快照 |

## 2. 自 2026-09-23 以来 paperbox 的变更面

> 表按 paperbox 版本顺序，字母按登记顺序：A–J 是 2026-09-23 之后陆续登记、且至今仍然有效的契约面，
> K–O 是 2026-10-14 这次补登记（0.5.0 → 0.6.0）。

按对 WebUI 的影响排序；「落地」列给出 paperbox 的版本与提交，便于回溯。

| # | 变化 | 落地 | 对 WebUI 的影响 |
|---|---|---|---|
| A | **鉴权 v1**：`AUTH_ENABLED` 总开关、`api_keys` 表（只存 sha256）、三档 `read < write < admin`；401（无凭证）/ 403（不匹配）/ 403 `insufficient role`；日志只记 key 前缀 | 0.4.0（`3730be4`/`dda913e`/`4cafa6c`，10-05） | 不破坏现有代理（BFF 一直带 Bearer），但 401/403 需要可读文案；WebUI 的 key 必须**重新申请**（见 第 3 节） |
| B | REST 检索 `rerank` 默认 `false`；响应新增 `candidates`（候选数，`total` 为论文数真值）、`backend` | 0.2.0（`8067e10`，10-01） | 检索 Tab 加**精排开关（默认关）**，显示 `candidates` / `backend` / `rerank.model` / `rerank.took_ms` |
| C | native hybrid 定档为默认、长池逐论文精排、精排换 int8 档、`facets=true` 回显过滤键取值 | 0.2.0（`51c08e1`/`33a65c7`/`e111f37`/`9a67ff6`） | 可选：检索里加 `backend` 覆盖、接 `facets` |
| D | `/api/consistency` 新增 embedding 模型普查 `embedding_models.{chunks,documents}`、每篇 `embedding_models: list[str]`；新问题码 `embedding_model_mismatch`（更早还有 `parser_stamp_mismatch`） | 0.4.1（`4825cbc`，10-08） | 一致性 Tab 显示普查；问题码中文映射从 7 个补到 9 个 |
| E | 签名下载 `GET /api/downloads/{paper_id}?exp=&sig=`（免 Bearer，签名即凭据，过期/篡改 → 403） | 0.3.0 | 可选：浏览器可直接下载 PDF（现走 BFF 的 `/api/papers/{id}/file` 亦可） |
| F | 请求体上限：JSON 8 MB / 其它 256 MB（声明长度即拒）→ 413；JSON 体按上限缓冲后回放，**chunked 也绕不过**；`/files` 超 `INGEST_MAX_REQUEST_MB`(200) → 413、文件数 >20 → 422；`/compressed` 非 zip → 415 | 0.4.0（P1-16 `08609b6`） | 413 / 415 需要可读文案（原先只有 429 有专门处理） |
| G | 审查修复的行为面：staging GC 年龄保护、孤儿原件 24 h 清理、过滤器归一化、**CJK 感知 token 计数**、非 UUID 预检 404、docling 连接级超时、`docling_rejected` 账本码 | 0.4.0（`499e8ac`…`1fc3b06`） | `token_count` 口径变化（**存量块未重嵌**）；删除/清理语义更严 |
| H | 新增端点：`GET /api/papers/{id}/degradations`、`GET /api/search-logs`、`GET/PATCH /api/papers/{id}/metadata`、`POST …/metadata/rollback`、`POST /api/papers/ingest/dir`、`POST /api/papers/ingest/compressed` | 09-30 起 | 按需接入（降级账本 / 检索日志 / 元数据编辑回滚 / 目录与压缩包导入） |
| I | MCP 面（`/mcp`，10 个工具） | 0.3.0 | **与 WebUI 无关**，不接 |
| J | 启动期维度三方对账（容器实测维度 ↔ `EMBEDDING_DIMENSION` ↔ 索引 mapping，实测不符**拒绝启动**） | 0.4.1（`4825cbc`） | WebUI 无感知；paperbox 起不来时 WebUI 只会看到 502 → 排障指路 paperbox `docs/architecture/04-embedding.md` 第 5b/9 节 |
| K | **整库重建索引有了端点**：`POST /api/papers/reindex`（先解释"为什么要重建"，默认 `dry_run=true` 只报告）；**字段冲突有了人工出口**：`POST …/metadata/conflicts/dismiss`（保留现值）与 `POST …/metadata/rollback`（采纳被拒值），条目带 `provenance_id`；`/health` 增**第五项 `docling`**（只跑 pypdf 的部署报 `disabled`，不算故障） | 0.5.0（`f916213`，10-10） | 论文库 Tab 加「重建全库索引」卡片（只发 `include_all`，`job_ids` 逐个返回）；元数据 Tab 的库内冲突表加「操作」列两个动词；状态条加 docling 一格 |
| L | **`paper_field_provenance.decision_at`**（迁移 `a41f7c2d9b30`，可空不回填）：记录人类**裁决**这一行的时刻；**全栈时区统一 `Asia/Shanghai`**（此前四个容器与 compose 都没设） | 0.5.1（`226bafa`，10-10） | WebUI 与 paperbox 同口径设时区（`webui/config.py` 导入期设定，`tests/test_timezone.py` 守卫）；`decision_at` 本仓库**暂不渲染** —— 复核清单只列未决分歧，那些恒无裁决时间 |
| M | **读接口免鉴权**（13 个读端点不再挂档位依赖）、`/mcp` 传输层不再拒绝请求；**退役签名下载路由** `GET /api/downloads/{paper_id}`（`paper_get_file` 改写公开的文件端点） | 0.5.2（`6dc0864`，10-12） | 读端点在读门放开后不带凭证也是 200（WebUI 照旧带 Bearer，行为不变）；WebUI 一直走 BFF 的 `/api/papers/{id}/file`，不受影响 |
| N | **读门策略化 + 四档档位**：新增 `AUTH_READ_ACCESS`（`public` \| `key`，默认 `public`），权限定为 `public < read < write < admin`，**删除并入 `write`**、`admin` 只剩批量重建；**密钥模型收口**：删 `api_keys.name`（迁移 `9c1d4b7a2e01`）、`prefix` 上限 16→32、重发同前缀即替换、`revoke` 改硬删（迁移 `8b4f0c2d6a17`） | 0.5.3（`51f924a`，10-12） | 见 第 3 节：WebUI 的 key 现在**只需要 `write` + 为了整库重建的 `admin`**（删除不再是 admin）；换 key 流程变为「同前缀重发即替换」，`prefix` 同时是日志归因与审计标签 |
| O | **依赖健康面重做**：`/health` 从五项变**六项**（新增可选的 `rerank`）；`services` 取值固定为 `ok` / `error` / `disabled` / `unknown`；顶层新增 `degraded`（必需依赖是否就绪）；新增 `dependencies.<name>`（`reason` / `latency_ms` / `checked_at` / `cached`）；探针超时统一（10s，`HEALTH_TIMEOUT_OVERRIDES` 可按依赖覆盖）；**探测只按需**（启动一次 + 每次调用，没有定时器），结论按 `HEALTH_PROBE_CACHE_TTL` 复用（默认 5 分钟）；应用容器不再声明 compose healthcheck | 0.6.0（`f429761`，10-14；探针注册表 `cdf9f41`…`403fee1`） | 状态条：六格徽标、四状态各一色、悬停显示失败原因与结论时刻、`degraded` 提示、依赖右侧「刷新状态」按需按钮，**去掉 15s 定时探测** |

## 3. WebUI 用的 key 与角色

- WebUI 的 BFF 调 paperbox 的四档端点，**最低需要 `write`**（导入 / 重建单篇 / 元数据应用 / **删除** —— 删除自 0.5.3 起并入 `write`）；
  它另外还需要 **`admin`**，只因为「重建全库索引」调的是 `POST /api/papers/reindex`，那是 `admin` 唯一的端点。
  当前这把 key 是 `admin`（高于所需），继续可用。
- 2026-10-08 起 WebUI 用**自己的一把 key**：`scripts/manage_keys.py create --prefix webui --role admin`，
  只写在 WebUI 的 `.env`（`PAPERBOX_API_KEY`，`.gitignore` 第 1 行，任何情况下不入 git）；`.env.example` 只留占位值。
- 换 key（0.5.3 起的语义）：对已存在的 `prefix` 再跑 `create`，先展示库里那一行并询问，确认后**同一事务内替换**
  （旧密钥立即失效）；改 `.env` → 重启 WebUI。`revoke` 是硬删，同一个 `prefix` 之后仍可重发。
  paperbox 侧不要删 `PAPER_API_KEY`（它仍是恢复路径的回落）。

端点组 → 最低档位（paperbox `docs/architecture/07-api.md` 第 2.2 节）：

| 端点组 | 最低档位 |
|---|---|
| `/api/papers/ingest*` | write |
| `POST /api/jobs/{id}/retry` | write |
| `/api/metadata/{import,apply,sources/{id}/attach}` | write |
| `PATCH /api/papers/{id}/metadata`、`POST …/metadata/rollback`、`POST /{id}/reindex` | write |
| `DELETE /api/papers/{id}` | **write**（0.5.3 起并入 write，此前是 admin） |
| `POST /api/papers/reindex`（整库 / 批量） | **admin**（唯一需要 admin 的端点） |
| 读端点（search / papers 读 / jobs 读 / consistency / search-logs） | read（读门 `public` 时不校验凭证） |

## 4. 复核本基线的命令

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8077/health         # 200
curl -s http://127.0.0.1:8077/health | python -m json.tool | head -40
#   期望：version=0.6.0、services 六项全 "ok"（rerank 未启用时为 "disabled"）、degraded=false、
#         dependencies.<name> 带 latency_ms / checked_at（cached=true 表示复用了 TTL 内的结论）
curl -s http://127.0.0.1:8077/api/consistency -H "authorization: Bearer $KEY" | python -m json.tool | head -30
#   期望：index=paper_chunks_v3（别名 paper_chunks_current）、totals.papers_live=30、
#         embedding_models.chunks/documents 各含 intfloat/multilingual-e5-large、problems=[]
```
