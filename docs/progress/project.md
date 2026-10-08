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

## 基线读数

| 日期 | paperbox 版本 | 语料 | 出处 |
|---|---|---|---|
| 2026-09-23 | ≥ 2026-09-23 契约 | 68 live / 139 已删 / 68 MinIO 对象 / 2883 索引文档 | `docs/examine/acceptance-2026-09-23.md` |
| 2026-10-08 | **0.4.1**（`6442a83`） | **30 live / 2302 chunks**，`problems=0` | `docs/examine/acceptance-2026-10-08.md`、`docs/architecture/01-paperbox-contract.md` |

> 旧快照的读数（68 篇 / 2883 docs）是**历史事实**，不要在新文档里当现行值引用。

## 未决项

| # | 事项 | 状态 |
|---|---|---|
| 1 | 降级账本（`/api/papers/{id}/degradations`）、检索日志（`/api/search-logs`）、元数据编辑/回滚（`PATCH …/metadata`、`rollback`）未接入 | 待排（属能力补齐，非兼容性修复） |
| 2 | ~~目录导入与压缩包导入未接入~~ → 批次 5 已接入（`68d5081`）。注意 `dir` 有部署前置：`INGEST_LOCAL_ROOTS` 为空时端点不存在（404），本轮实测该变量**已指向** `C:\Users\<user>\Desktop\hermes\paperbox-data\datasets\corpus30` | 已做 |
| 3 | `facets=true`（过滤键取值回显）未接；检索 `backend` 覆盖**已接**（`bd967d3`，空值 = 交给 `SEARCH_BACKEND`） | 部分待排 |
| 5 | 429 的另一来源（批请求撞 backlog 水位）未在真机复现：水位默认 0 = 关闭，只有单测覆盖 | 说明性 |
| 4 | CJK 分词口径变化后**存量块未重嵌**；界面若展示 `token_count` 需注明口径 | 说明性 |
