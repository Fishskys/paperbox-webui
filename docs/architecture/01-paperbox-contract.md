# 01 · paperbox 契约基线

本文件记录 WebUI **依赖的 paperbox 契约**：基线版本、当时的事实读出、以及自上个基线以来 paperbox 变了什么、对 WebUI 意味着什么。
每次升级基线时更新本文件，并在 `docs/progress/project.md` 记一笔。

## 1. 当前基线

| 项 | 值 | 核对方式 |
|---|---|---|
| paperbox 版本 | **0.4.1**（commit `6442a83`，tag `v0.4.1`，GitHub release 标 Latest） | paperbox 仓库 `git describe --tags` / `CHANGELOG.md` |
| 服务地址 | `http://127.0.0.1:8077`（单 worker；导入流水线在进程内） | `GET /health` → 200 |
| 索引 | 物理 `paper_chunks_v3`，读写走别名 `paper_chunks_current` | `GET /api/consistency` → `index` / `index_exists` |
| 检索后端 | `SEARCH_BACKEND=native`（引擎侧 RRF + 按论文聚合） | 检索响应里的 `backend` |
| 精排 | int8 档 `temsa/mmarco-mMiniLMv2-L12-H384-v1-onnx-cpu-qint8`，`RERANK_MAX_BATCH=4`；**REST 请求的 `rerank` 默认 `false`（需显式开）** | 响应里的 `rerank` 块 |
| 鉴权 | `AUTH_ENABLED=true`：REST 与 `/mcp` 都要求 Bearer；缺凭证 401、不匹配 403、档位不足 403 `insufficient role` | `UserManual.md`、`docs/architecture/07-api.md` §2.2 |
| 语料（本机） | **30 live / 2302 chunks**，embedding 模型普查 2302 + 2302 同为 `intfloat/multilingual-e5-large`；`problems=0` | `GET /api/consistency` |
| 上个基线 | 2026-09-23（见 `docs/examine/acceptance-2026-09-23.md`；当时 68 live / 2883 docs） | 该快照 |

## 2. 自 2026-09-23 以来 paperbox 的变更面

按对 WebUI 的影响排序；「落地」列给出 paperbox 的版本与提交，便于回溯。

| # | 变化 | 落地 | 对 WebUI 的影响 |
|---|---|---|---|
| A | **鉴权 v1**：`AUTH_ENABLED` 总开关、`api_keys` 表（只存 sha256）、三档 `read < write < admin`；401（无凭证）/ 403（不匹配）/ 403 `insufficient role`；日志只记 key 前缀 | 0.4.0（`3730be4`/`dda913e`/`4cafa6c`，10-05） | 不破坏现有代理（BFF 一直带 Bearer），但 401/403 需要可读文案；WebUI 的 key 必须**重新申请**（见 §3） |
| B | REST 检索 `rerank` 默认 `false`；响应新增 `candidates`（候选数，`total` 为论文数真值）、`backend` | 0.2.0（`8067e10`，10-01） | 检索 Tab 加**精排开关（默认关）**，显示 `candidates` / `backend` / `rerank.model` / `rerank.took_ms` |
| C | native hybrid 定档为默认、长池逐论文精排、精排换 int8 档、`facets=true` 回显过滤键取值 | 0.2.0（`51c08e1`/`33a65c7`/`e111f37`/`9a67ff6`） | 可选：检索里加 `backend` 覆盖、接 `facets` |
| D | `/api/consistency` 新增 embedding 模型普查 `embedding_models.{chunks,documents}`、每篇 `embedding_models: list[str]`；新问题码 `embedding_model_mismatch`（更早还有 `parser_stamp_mismatch`） | 0.4.1（`4825cbc`，10-08） | 一致性 Tab 显示普查；问题码中文映射从 7 个补到 9 个 |
| E | 签名下载 `GET /api/downloads/{paper_id}?exp=&sig=`（免 Bearer，签名即凭据，过期/篡改 → 403） | 0.3.0 | 可选：浏览器可直接下载 PDF（现走 BFF 的 `/api/papers/{id}/file` 亦可） |
| F | 请求体上限：JSON 8 MB / 其它 256 MB（声明长度即拒）→ 413；JSON 体按上限缓冲后回放，**chunked 也绕不过**；`/files` 超 `INGEST_MAX_REQUEST_MB`(200) → 413、文件数 >20 → 422；`/compressed` 非 zip → 415 | 0.4.0（P1-16 `08609b6`） | 413 / 415 需要可读文案（原先只有 429 有专门处理） |
| G | 审查修复的行为面：staging GC 年龄保护、孤儿原件 24 h 清理、过滤器归一化、**CJK 感知 token 计数**、非 UUID 预检 404、docling 连接级超时、`docling_rejected` 账本码 | 0.4.0（`499e8ac`…`1fc3b06`） | `token_count` 口径变化（**存量块未重嵌**）；删除/清理语义更严 |
| H | 新增端点：`GET /api/papers/{id}/degradations`、`GET /api/search-logs`、`GET/PATCH /api/papers/{id}/metadata`、`POST …/metadata/rollback`、`POST /api/papers/ingest/dir`、`POST /api/papers/ingest/compressed` | 09-30 起 | 按需接入（降级账本 / 检索日志 / 元数据编辑回滚 / 目录与压缩包导入） |
| I | MCP 面（`/mcp`，10 个工具） | 0.3.0 | **与 WebUI 无关**，不接 |
| J | 启动期维度三方对账（容器实测维度 ↔ `EMBEDDING_DIMENSION` ↔ 索引 mapping，实测不符**拒绝启动**） | 0.4.1（`4825cbc`） | WebUI 无感知；paperbox 起不来时 WebUI 只会看到 502 → 排障指路 paperbox `docs/architecture/04-embedding.md` §5b/§9 |

## 3. WebUI 用的 key 与角色

- WebUI 的 BFF 需要 **`admin`** 档位（它暴露了 `DELETE /api/papers/{id}`）；写操作（导入 / 重建索引 / 元数据应用）需 `write`。
- 2026-10-08 起 WebUI 用**自己的一把 key**：`scripts/manage_keys.py create --name paperbox-webui --prefix webui --role admin`，
  只写在 WebUI 的 `.env`（`PAPERBOX_API_KEY`，`.gitignore` 第 1 行，任何情况下不入 git）；`.env.example` 只留占位值。
- 换 key：create 新前缀 → 改 `.env` → 重启 WebUI → `revoke` 旧前缀。paperbox 侧不要删 `PAPER_API_KEY`（它仍是签名下载与恢复路径的回落）。

端点组 → 最低档位（paperbox `docs/architecture/07-api.md` §2.2）：

| 端点组 | 最低档位 |
|---|---|
| `/api/papers/ingest*` | write |
| `POST /api/jobs/{id}/retry` | write |
| `/api/metadata/{import,apply,sources/{id}/attach}` | write |
| `PATCH /api/papers/{id}/metadata`、`POST …/metadata/rollback`、`POST /{id}/reindex` | write |
| `DELETE /api/papers/{id}` | admin |
| 读端点（search / papers 读 / jobs 读 / consistency / search-logs） | read |

## 4. 复核本基线的命令

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8077/health         # 200
curl -s http://127.0.0.1:8077/api/consistency -H "authorization: Bearer $KEY" | python -m json.tool | head -30
#   期望：index=paper_chunks_v3（别名 paper_chunks_current）、totals.papers_live=30、
#         embedding_models.chunks/documents 各含 intfloat/multilingual-e5-large、problems=[]
```
