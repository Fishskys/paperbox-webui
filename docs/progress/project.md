# paperbox-webui · 项目进度

记「已发生的事实」：批次做了什么、提交号、当时的验收结论、以及未决项。**计划不写在这里**（计划在 `.hermes/plans/`，不入 git）。

## 批次表

| 批次 | 日期 | 内容 | 提交 | 结论 |
|---|---|---|---|---|
| 1 | 2026-09-11 → 09-16 | 初版：单页六 Tab + FastAPI BFF 代理（导入 / 检索 / 论文库 / 详情 / 作业 / 一致性），密钥不出服务端 | `da091d0` 等 | 可用；实现规范见 `docs/old/SPEC-20261008.md` |
| 2 | 2026-09-19 → 09-20 | 并发上传（每文件一请求、part 串行）+ 429 退避（`Retry-After` 优先）+ 两阶段进度 | 见 `docs/examine/acceptance-upload.md` | 真机验收通过 |
| 3 | 2026-09-23 | 检索过滤选项、一致性 Tab、元数据导入/复核、任务分页与详情/重试 | `8891f58`/`20f5660`/`9fa08df`/`7c1078c`/`b410d3f` | 真机验收通过（`docs/examine/acceptance-2026-09-23.md`） |
| 4 | 2026-09-23 | 去掉多余的 `static/.gitkeep`、忽略系统垃圾文件 | `ca6499a` | — |
| 5 | 2026-10-08 | **升级到 paperbox 0.4.1**：docs 改四类目录（architecture/examine/progress/old）、专用 admin key（本地专用）、检索加精排开关（默认关）与候选数/后端回显、一致性接 embedding 模型普查与两个新问题码、补 `dir`/`compressed` 两个导入入口、0.4.x 失败路径可读文案 | `60a6b7d` / `e795618` / `bd967d3` / `6bd1cf6` / `68d5081` | **真机验收通过**（`docs/examine/acceptance-2026-10-08.md`） |
| 8 | 2026-10-14 | **契约基线补登记到 paperbox 0.6.0**：`01-paperbox-contract.md` 的基线行 / 鉴权行改写，补 K–O 五行（0.5.0 整库重建与两条冲突裁决、0.5.1 `decision_at` 与时区、0.5.2 读接口免鉴权与签名下载退役、0.5.3 读门与四档 / 密钥模型、0.6.0 依赖健康面），§3 改成「最低 `write` + 整库重建的 `admin`」，§4 复核命令加上版本期望 | `1cb4fc1` | 见下「批次 8 的核对」 |
| 7 | 2026-10-14 | **版本号收口**：`uv.lock` 刷新（锁格式 revision 3→5、项目版本 0.1.0→0.5.1 对齐 pyproject）；版本源从 `main.py` 里写死的 `"0.1.0"` 收进 `webui/__init__.py` 的 `__version__`（照 paperbox 的 `app/__init__.py` 形状）；AGENTS.md §4.1 补规则：改版本号时 `pyproject.toml` / `webui/__init__.py` / `uv.lock` 同一提交改齐 | `8f35d43`（锁）+ `d065115`（版本源） | `uv lock --check` OK；`/openapi.json` 报 0.5.1；pytest 111 / node 89 全绿 |
| 6 | 2026-10-14 | **状态条改按需**：对齐 paperbox 当日重做的 `/health` 依赖面 —— 六格徽标（含可选 `rerank`）、四种状态各一色、悬停看失败原因与结论时刻、`degraded` 提示、依赖右侧「刷新状态」按钮；**去掉 15s 定时探测**（第三方 embedding 探针按次计费）；新增纯逻辑模块 `health-logic.js` 与 `tests/js/health_logic.test.mjs` | `b18d1d1` | 见「批次 6 的验收读数」 |

## 基线读数

| 日期 | paperbox 版本 | 语料 | 出处 |
|---|---|---|---|
| 2026-09-23 | ≥ 2026-09-23 契约 | 68 live / 139 已删 / 68 MinIO 对象 / 2883 索引文档 | `docs/examine/acceptance-2026-09-23.md` |
| 2026-10-08 | **0.4.1**（`6442a83`） | **30 live / 2302 chunks**，`problems=0` | `docs/examine/acceptance-2026-10-08.md`、`docs/architecture/01-paperbox-contract.md` |

> 旧快照的读数（68 篇 / 2883 docs）是**历史事实**，不要在新文档里当现行值引用。

### 批次 6 的验收读数（2026-10-14，实测）

| 项 | 读数 |
|---|---|
| 单测 | `uv run pytest` 111 passed；`node --test tests/js/*.test.mjs` 89 passed |
| 接口 | `GET http://127.0.0.1:8088/api/ui/health` → 六项全 `ok`、`degraded=false`、`dependencies` 逐项带 `latency_ms` / `checked_at`；版本 0.5.3、30 篇、61 个作业 |
| 不自动探测 | 打开页面后静置 40 秒，`webui.log` 里 `GET /api/ui/health` 只多 1 行（打开页面那一次） |
| 四种状态与悬停 | 浏览器实测计算样式：`ok` 绿 / `error` 红 / `disabled` 灰 / `unknown` 蓝；`error` 与 `unknown` 的 `title` 带原因、耗时、`checked_at`（缓存命中写明），`ok` / `disabled` 无 `title` |

### 批次 8 的核对（2026-10-14）

新增的五条逐项取自 paperbox 仓库的 `CHANGELOG.md`（`[0.5.0]`–`[0.6.0]` 段）与 tag→commit 对照：
`v0.5.0` = `f916213`、`v0.5.1` = `226bafa`、`v0.5.2` = `6dc0864`、`v0.5.3` = `51f924a`、`v0.6.0` = `f429761`；
权限与端点档位对着 paperbox 的 `docs/architecture/07-api.md` 第 2.2 节核。运行中的 paperbox 报 0.6.0，
`/health` 六项全 `ok` + `degraded=false` + `dependencies` 逐项带 `latency_ms` / `checked_at`，
`/api/consistency` `problems=0`（30 篇 / 2302 chunks）。

## 未决项

| # | 事项 | 状态 |
|---|---|---|
| 1 | 降级账本（`/api/papers/{id}/degradations`）、检索日志（`/api/search-logs`）、元数据编辑/回滚（`PATCH …/metadata`、`rollback`）未接入 | 待排（属能力补齐，非兼容性修复） |
| 2 | ~~目录导入与压缩包导入未接入~~ → 批次 5 已接入（`68d5081`）。注意 `dir` 有部署前置：`INGEST_LOCAL_ROOTS` 为空时端点不存在（404），本轮实测该变量**已指向** `<本机 paperbox-data>\datasets\corpus30` | 已做 |
| 3 | `facets=true`（过滤键取值回显）未接；检索 `backend` 覆盖**已接**（`bd967d3`，空值 = 交给 `SEARCH_BACKEND`） | 部分待排 |
| 5 | 429 的另一来源（批请求撞 backlog 水位）未在真机复现：水位默认 0 = 关闭，只有单测覆盖 | 说明性 |
| 6 | ~~`docs/architecture/01-paperbox-contract.md` 的"当前基线"行仍写 0.4.1，而本机跑的是 0.5.3：0.5.0 / 0.5.1 的变更面只在验收快照里~~ → 批次 8 已补登记（`1cb4fc1`）：基线升到 0.6.0，0.5.0–0.6.0 逐版登记 | 已做 |
| 4 | CJK 分词口径变化后**存量块未重嵌**；界面若展示 `token_count` 需注明口径 | 说明性 |
