# paperbox WebUI × paperbox 0.4.1 验收（2026-10-08）

本文件是 2026-10-08 那次「WebUI 对齐 paperbox 0.4.1」的**验收快照**：所有读数是当天在这台机器上跑出来的原始输出，不是转述。基线从 2026-09-23 的 68 live 改为**当前语料**（30 live / 2302 chunks）。

- 被验对象：`paperbox-webui` main（本文件所在仓库）
- 后端：paperbox **0.4.1**（`6442a83`，tag `v0.4.1`），`http://127.0.0.1:8077`
- WebUI：`http://127.0.0.1:8088`（`uv run uvicorn webui.main:app`）
- 后端开关：`AUTH_ENABLED=true`、`MCP_ENABLED=true`、`SEARCH_BACKEND=native`

---

## §1 基线读数（当前语料）

`GET /api/ui/health`：

```json
{"paperbox": {"postgres": "ok", "opensearch": "ok", "minio": "ok", "embedding": "ok"},
 "version": "0.4.1", "papers": 30, "jobs": 44}
```

`GET /api/ui/consistency?limit=50`：

```
consistent= True  problems= 0
totals: {"papers":30,"papers_live":30,"papers_deleted":0,"files_pg":30,"objects_minio":120,
         "chunks_pg":2302,"documents_os":2302,"staging_objects":0,"problems":0,
         "orphan_objects":0,"orphan_documents":0,"cache_objects":90}
embedding_models: {"chunks":{"intfloat/multilingual-e5-large":2302},
                   "documents":{"intfloat/multilingual-e5-large":2302}}
parser_backends: {"papers":{"docling":30},"documents":{"docling":2302},"paper_ids":{},"paper_ids_truncated":false}
```

口径说明：`cache_objects=90` 是 parse cache，不是漂移；`staging_objects=0` 表示没有上传残留（下面压测 429 之后仍是 0）。

---

## §2 鉴权（0.4.0 起）

WebUI 用**自己**的 `admin` key（前缀 `webui`，`manage_keys.py create --name paperbox-webui --prefix webui --role admin`）。真实结果：

| 场景 | 结果 |
|---|---|
| 带 key 读端点 | `200` |
| 不带凭证 | `401` + hint「paperbox 没收到凭证：…检查 .env 里的 PAPERBOX_API_KEY」 |
| 错 key | `403` + hint「paperbox 拒绝了这把 key：可能已吊销或写错…」 |
| 档位判定：`DELETE /api/papers/{不存在的 UUID}` | **`404`（而不是 403）** = 确实拿到 `admin` |

密钥只存在于 `paperbox-webui/.env`（`.gitignore` 第 1 行）；`git grep` 在被跟踪文件里搜不到；`.env.example` 只有占位值。

---

## §3 检索：精排开关（默认关）+ 新回显

`POST /api/ui/search`，`mode=hybrid`、`top_k=10`：

| | `rerank` | `total` | `candidates` | `backend` | `rerank.model` | `rerank.took_ms` | 首条 |
|---|---|---|---|---|---|---|---|
| 默认（不勾） | `false` | 29 | 34 | `native` | `null` | `null` | Attention Is All You Need |
| 勾上 | `true` | 29 | 40 | `native` | `temsa/mmarco-mMiniLMv2-L12-H384-v1-onnx-cpu-qint8` | **5936** | Attention Is All You Need |

界面摘要按这三种状态分别显示：没勾 = **精排 关**；勾了但 `model` 为空 = **精排 未生效**（服务端静默降级）；跑了 = **精排 <模型> <耗时>**。`rerank.enabled` 只表示服务端配置了精排，不能当「跑过了」的证据。

---

## §4 一致性 Tab：embedding 普查与两个新问题码

真浏览器（Chromium，页面 8088）切到一致性 Tab 后读 DOM：

```json
{"census_hidden": false,
 "census_rows": [["chunks","intfloat/multilingual-e5-large","2302"],
                 ["documents","intfloat/multilingual-e5-large","2302"]],
 "note_shown": false,
 "table_heads": ["论文","状态","向量模型","文件 PG ↔ MinIO","chunks PG ↔ OS","问题","缺失对象","孤儿对象"]}
```

- 普查表来自 0.4.1 的顶层 `embedding_models`，两个 scope 各 2302、同一模型 → 无告警。
- 问题码从 7 个扩到 **9 个**（补 `parser_stamp_mismatch`、`embedding_model_mismatch`），未识别码原样显示而不是消失。
- 逐篇行新增「向量模型」列，单篇跨两个模型时标红。当前语料 `problems=0`，所以**没有真实行可看**——该列的文字规则由 `tests/js/consistency_logic.test.mjs` 真跑覆盖，字段名对的是 paperbox `app/schemas/consistency.py`（`embedding_models: list[str]`）。

---

## §5 导入通道与失败文案（0.4.x 的五条）

全部经 WebUI（8088）打，各条都是纸面原始输出。目录导入一律 `dry_run`，对语料零改动。

### 5.1 目录导入 · 白名单内 · `dry_run`

```
HTTP 202
counts: {"matched":30,"accepted":0,"duplicate":30,"rejected":0,"skipped":0}
```

`matched=30 / duplicate=30 / accepted=0`：`INGEST_LOCAL_ROOTS` 指向的目录里就是语料原文件，按 content hash 全部判定为重复 —— **零新增**，同时也独立印证了「30 live」这个基线。

### 5.2 `403` · root 越界

```
detail: root is outside the whitelist (INGEST_LOCAL_ROOTS): C:\Windows
hint  : 目录导入只收 INGEST_LOCAL_ROOTS 白名单内的路径（.. 逃逸与软链目录同样被拒）：
        把 root 换成白名单里的目录，或让 paperbox 的 .env 加上这个目录再重启
```

与「key 档位不足」分开说：一个是目录授权，一个是密钥档位，改法完全不同。

### 5.3 `404` · root 不是目录

```
detail: root is not a directory: …\paperbox-data\datasets\no-such-dir-f8ed02
hint  : root 不存在或不是目录：路径是 **paperbox 所在机器**上的绝对路径（不是浏览器里的目录），且必须是目录而非文件
```

端点关闭（`INGEST_LOCAL_ROOTS` 为空）走的是另一条文案（detail 里含 `disabled`），两者不混。

### 5.4 `415` · 非 zip

```
detail: only zip archives are supported; 7z/rar/tar are not (repack the folder as a .zip)
hint  : 只认 zip：7z / rar / tar 都不收（paperbox 先看魔数）。把文件夹重新压成 .zip 再传；单篇论文直接用普通上传，不必打包
```

### 5.5 `413` · JSON 体超 8 MB

```
detail: request body too large
hint  : 请求体超 paperbox 的 8 MB JSON 上限：这是单次请求的参数体过大，不是文件太大
```

另一条 413（单请求总字节超 `INGEST_MAX_REQUEST_MB=200`）的文案按 `bytes exceeds` 片段区分，单测覆盖。

### 5.6 `429` · 并发上传席位满

用**已在库的同一 PDF** 并发提交（去重 → 零新增）：

```
直连 paperbox 8077: 状态 {429: 6, 202: 2}   429 的 Retry-After = ['2']
经 WebUI    8088: 状态 {429: 6, 202: 2}   429 的 Retry-After = ['2']
detail: server busy: upload concurrency: 2 request(s) already in flight; retry after 2s
hint  : paperbox 在途上传或队列水位到顶：按 Retry-After 等一会儿再传，别立刻重试（Retry-After: 2 s）
```

两条链路的 `Retry-After` 完全一致 → 上传队列的退避有东西可依。压测后 `staging_objects` 仍为 0，`papers_live` 仍为 30。

> 边界：另一处 429 来源（批请求撞 backlog 水位）在闲置机器上不会出现（水位默认 0 = 关闭），本轮**没有**在生产路径上复现，只由单测覆盖。

---

## §6 其余只读面（回归）

```
GET /api/ui/config      200 {"upload_concurrency":2,"upload_max_attempts":6,"retry_base_ms":2000,
                             "retry_cap_ms":60000,"file_max_mb":100,"batch_hint_threshold":20}
GET /api/ui/papers      200 total=30（本页 3）
GET /api/ui/papers/{id} 200 {"title":"AaLLM: …","year":2026,"status":"INDEXED"}
GET …/{id}/chunks       200 total=43（本页 2，首块 token_count=39）
GET …/{id}/file         200 content-type: application/pdf
GET /api/ui/jobs        200 total=44（首条 stage=COMPLETED）
GET /api/ui/metadata/review  200 total=0，conflicts 非空（authors 等字段有保留/被拒记录）
GET /api/ui/consistency 200 consistent=True problems=0（见 §1）
```

---

## §7 测试与静态守卫

| 命令 | 结果 |
|---|---|
| `uv run pytest -q`（后端，含内部再跑一遍 JS 套件） | **EXIT=0**，89 个用例 |
| `node --test tests/js/*.test.mjs` | **50 pass / 0 fail**（检索体 5 + 一致性 6 为本轮新增） |

两个环境坑记在这里，避免下次误判：

1. `node --test tests/js`（裸目录）在这个 Node 版本会以 `stdin is not a tty` 起不来 —— 用 README 里的 glob 写法。
2. `node` 在**后台进程**上下文里会假失败（同样报 `stdin is not a tty`），JS 套件要前台跑。

---

## §8 本轮未覆盖 / 已知边界

- **逐篇「向量模型」列**没有真实数据行可看（`problems=0`）；规则由 node 测试覆盖。
- **backlog 水位的 429** 未在真机复现（水位默认关闭），只有单测。
- **Task 7 的能力**（降级账本、检索日志、元数据编辑/回滚）本轮未做，plan 里本就标「按需」。
- `total` 在检索响应里是**命中论文数**（29），不是库存论文数（30）—— 两者不同，别混用。
