# paperbox-webui —— 总览与文档地图

给 **paperbox**（论文知识服务 REST API，后端仓库另行维护）做的**简易 WebUI**，用途是**人工测试 paperbox 的全部功能**：
导入、检索、浏览论文库、查看证据片段、重建索引、软删除、元数据复核、三端一致性对账。

## 1. 拓扑与边界

```
浏览器 ──► paperbox-webui :8088 ──►(Bearer key)──► paperbox API :8077
            FastAPI BFF          服务端持密钥        依赖 PG / OpenSearch / MinIO / Embedding
            静态单页（无构建）                        （由 paperbox 一侧自行启动）
```

- **前端**：原生 HTML/CSS/JS，无构建步骤、无 CDN、离线可用；单页 + 六个 Tab。
- **后端**：FastAPI + httpx，只做**代理**——浏览器只访问 `/api/ui/*`，由 BFF 带 `Authorization: Bearer` 转发；
  **密钥不离开服务端**，因此不需要配 CORS，也不存在浏览器侧凭据。
- 本仓库**不含** paperbox 的代码与依赖服务。

## 2. 文档地图

| 文档 | 性质 | 内容 |
|---|---|---|
| `docs/architecture/00-overview.md` | 活文档 | 本文：定位、拓扑、文档地图与目录约定 |
| `docs/architecture/01-paperbox-contract.md` | 活文档 | **契约基线**：依赖的 paperbox 版本、索引/语料事实、自基线以来的变更面、端点与角色对照 |
| `docs/architecture/MVP-SPEC.md` | 活文档 | 实现规范：技术栈与硬约束、目录结构、配置、后端要求、前端要求、测试与验证要求 |
| `docs/progress/project.md` | 活文档 | 项目级进度：各批次做了什么、提交号、验收结论、未决项 |
| `docs/examine/acceptance-*.md` | 快照 | 真机验收记录（当时的命令与真实输出），**只增不改** |
| `docs/old/*` | 归档 | 被取代的活文档，命名 `NAME-YYYYMMDD.md`；见 `docs/old/README.md` |
| `docs/screenshots/` | 本地 | 界面截图（已 gitignore，不随仓库发布） |
| `.hermes/plans/*.md` | 本地 | Hermes 的实施计划（已 gitignore，不随仓库发布） |
| `README.md` | 活文档 | 面向使用者的安装/启动/界面/测试说明 |
| `SPEC.md` ↔ `docs/architecture/MVP-SPEC.md` | — | 实现规范已迁入 `docs/architecture/`（2026-10-08） |

## 3. 目录约定（源自 paperbox 项目的文档布局）

- `architecture/` —— 结构与契约类**活文档**；入口是 `00-overview.md`。
- `examine/` —— **快照**：验收记录、审查报告。写下来就不再改。
- `progress/` —— 项目级进度**活文档**，记「已发生的事实」与未决项，不记计划。
- `old/` —— **被取代的活文档**。判定规则：还在被引用的现行版本 → 归 `architecture/`；整份被新版顶掉、但仍有查阅价值 → 归 `old/`。
- 计划放 `.hermes/plans/`（不入 git）；运行日志放 `logs/`（已 gitignore）。

## 4. 相关仓库

| 仓库 | 看什么 |
|---|---|
| paperbox | `docs/architecture/07-api.md`（REST 端点与错误码）、`…/11-mcp-agent-interface.md`（MCP 契约）、`…/hermes-integration.md`（集成样例）、`UserManual.md`（部署/配置/排障） |
