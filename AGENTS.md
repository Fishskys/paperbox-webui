最终修改日期：2026-10-14

本文件定义了针对本仓库的核心协作准则与工程标准。所有参与本项目的 AI Agent 在执行开发、重构、审查或维护任务时，均须无条件遵守以下规范。

## 0. 使用与维护规则

- 权威边界：本文件约束 AI Agent 的执行行为；其它工程规范文档不得与此冲突，冲突时以本文件为准。

- 体量预算：≤200 行或 ≤12,000 字符；超限先删通用条目，再把细则下沉到 `docs/`。

- 项目简介和架构发生变化时，可修改"#1-项目简介与架构地图"，其余内容非必要不修改。

## 1. 项目简介与架构地图 (Project Map)

### 1.1 项目定位与核心技术栈

- **项目名称**：`paperbox-webui`
- **核心定位**：`给 paperbox（论文知识服务 REST API，后端仓库另行维护）做的简易 WebUI，用途是人工测试它的全部功能 —— 导入 / 混合检索 / 论文库浏览 / 证据片段 / 重建索引 / 软删除 / 元数据复核 / 三端一致性对账。形态是 BFF 代理 + 无构建静态单页：浏览器只访问本服务的 /api/ui/*，由服务端持 admin key 带 Bearer 转发给 paperbox，密钥不出服务端（因此不需要 CORS，也没有浏览器侧凭据）。`
- **核心技术栈**：
  - **语言与运行时**：`Python 3.12（依赖与虚拟环境一律走 uv，以 uv.lock 为准）；uvicorn 单进程`
  - **核心框架**：`FastAPI 0.141 + Pydantic 2.13 + pydantic-settings（读 .env）、httpx 0.28（唯一访问 paperbox 的客户端）`
  - **前端与测试**：`原生 HTML/CSS/JS —— 无构建步骤、无 CDN、无框架、离线可用；可测纯逻辑抽到 *-logic.js 由 node:test 真跑；后端用例用 pytest + httpx.MockTransport 造假 paperbox`

### 1.2 目录结构与权责边界

```plaintext
paperbox-webui/
├── webui/                  # 应用代码（FastAPI BFF + 静态单页）
│   ├── main.py             # 装配：静态文件挂载 + /api/ui 路由；lifespan 建/关共享客户端
│   ├── config.py           # pydantic-settings：读 .env、导入期设定时区、上传队列调参
│   ├── client.py           # PaperboxClient：访问 paperbox 的唯一出口（Bearer / 超时 / 不可达归一）
│   ├── routers/            # 表现层：system · config · papers · jobs · ingest · search · actions · consistency · metadata · deps
│   └── static/             # index.html · app.js · 七个 *-logic.js · style.css（无构建）
├── tests/                  # 后端代理层单测（MockTransport）+ js/ 的 node:test 纯逻辑用例
├── docs/                   # 活文档：architecture（00-overview / 01-paperbox-contract / MVP-SPEC）· progress · examine · old · screenshots
├── .hermes/                # 本地 agent 工作目录：plans · acceptance（gitignore）
├── pyproject.toml / uv.lock / .python-version
└── README.md / AGENTS.md
```

**目录要点清单：**

- `webui/routers/`：只做协议层 —— 参数透传、错误原样透传（状态码 + `detail`）、已知失败模式补一条中文 `hint`；业务判断不在这层，paperbox 才是唯一真实源。
- `webui/client.py`：**唯一**的 paperbox 出口；路由不得自己建 httpx 调用、另拼 URL 或复制 paperbox 的路径常量。
- `webui/routers/deps.py`：共享依赖与错误契约（`get_client` / `passthrough` / `error_hint`）；失败文案只在这里写一处，零散到 JS 里改一处忘一处不会被发现。
- `webui/static/`：**没有构建步骤**，改完刷新即生效；`app.js` 只做 DOM 与网络接线，会算错的纯逻辑一律下沉 `*-logic.js`。
- `tests/`：后端用例一律用 `httpx.MockTransport` 造假 paperbox，不连真实服务、不用真 key；纯前端逻辑放 `tests/js/`。
- `docs/architecture/01-paperbox-contract.md`：与 paperbox 的**契约基线**（依赖版本、端点与角色、语料事实）——单一真实源，README 与代码里的契约说法都要指向它。
- `docs/`：非 plan 文档进 `docs/{architecture,progress,examine,old}/`；计划进 `.hermes/plans/`。
- 本仓库不含 paperbox 的代码与依赖服务；开发默认 paperbox 在 `127.0.0.1:8077`、WebUI 在 `0.0.0.0:8088`。

## 2. 架构设计与代码规范 (Architecture & Code Standards)

### 2.1 层次化思维与依赖单向性

- **单向依赖规则**：依赖只能自上而下流动（`static 浏览器 -> routers 协议 -> client 传输 -> paperbox REST`）。

- **禁止跨层调用**：路由不得直连 httpx 或自己拼 paperbox 的 URL（越过 client）；前端不得直连 8077（密钥只在服务端）；本服务不得替 paperbox 做业务决定（例如替它决定 `dry_run`、自己算分页 `total`）。

- **依赖反转 (DIP)** ：上层只依赖 client 暴露的方法（`health` / `list_papers` / …），不依赖它的传输细节；换传输、加超时只改 client。

### 2.2 模块化与解耦标准

- **单一职责与高内聚**：一个 router 一个业务面；`app.js` 不得膨胀成上帝脚本 —— 新增逻辑进 `*-logic.js` 并配用例。

- **接口隔离**：只向浏览器暴露它真正需要的字段；代理响应形状保持稳定，不因 paperbox 多返回一个字段就漏给前端。

- **可插拔与扩展性 (OCP)** ：新增一个 paperbox 端点 = 加一条路由 + 一个 client 方法 + 用例，不得改动既有路由的既有行为。

### 2.3 编码约束

- **禁止循环依赖**：文件与模块之间不得存在任何直接或间接的循环引用。

- **最小暴露面**：函数、类和方法默认设为私有/内部可见，仅在确有跨模块调用需求时才公开暴露。

- **前端零依赖**：不得引入框架、打包器或 CDN 资源（离线可用是硬约束）；不得为"顺手"而引入构建步骤。

- **避免过度防御性编程**：只做常见且有重大影响的异常处理；严禁编造非常见漏洞和异常。

## 3. 文档规范 (Documentation Standards)

### 3.1 同步更新法则 (Atomic Sync)

- **代码与文档同频**：代码逻辑的任何改动必须与对应文档的更新打包在同一个提交/变更集内。未更新文档的代码视为未完成交付。

- **接口变更即刻同步**：任何 `/api/ui/*` 路径、入参、出参或错误码变更，必须同步刷新 README 的端点表与该路由的测试。

### 3.2 文档编写准则

- **状态即文档 (Living Document)** ：架构与设计文档**仅记录当前有效状态**。

  - **禁止事项**：不要在正文中记录历史演进过程、修改流水账或废弃的设计草案（历史追溯统一由 Git 历史和专用的 ADR 处理）。

- **准确胜于堆砌**：

  - 严禁无意义的代码复制粘贴和模糊黑话堆砌。

  - 用清晰的拓扑图、状态机图、时序图（推荐 Mermaid 语法）替代大段含糊文字。

  - 重点阐述设计动机、约束条件和边界情况，而非逐行复述代码。

### 3.3 文档引用与路径规范

- **持久化与确定性引用**：

  - 文档中引用历史上下文或架构变更时，**仅允许引用持久化且语义清晰的客观实体**（如具体的 Commit Hash、发布标签 Tag、已合并的 PR 编号或架构决策记录 ADR 编号）。引用md文档时，采用可跳转的markdown链接，例如'[文档引用与路径规范](#33-文档引用与路径规范)'

  - **严禁使用模糊的临时态术语**：严禁出现如"Phase-1 遗留"、"阶段-2 完成"、"进度-1 状态"、"待当前迭代结束后"、"文档-行号"等随时间推移即失去确切含义或失效的描述。

  - **禁止行号引用**：引用代码位置时一律使用**稳定标识符**（函数名、类名、模块路径、配置键名），禁止任何形式的行号（形如「路径:行号」「:行号」「L行号」「（N 行）」）——行号在每次编辑后都会失效。

  - **重要论断可溯源**：只有重要论断需要给出出处，不必每个论断都引用具体代码；出处优先给稳定标识符或 Commit / Tag / PR / ADR。

- **优先使用项目内相对路径**：

  - 所有文档内互相链接、配置说明、测试脚本及架构引用，必须统一使用**项目根目录相对路径**（如 `docs/architecture/00-overview.md`）或**当前文档所在目录的相对路径**（如 `./01-paperbox-contract.md`）。

  - 严禁出现开发者本地绝对路径（如 `/Users/xxx/...` 或 `C:\Projects\...`）。

### 3.4 文档冲突修正规则

- **代码与事实优先原则**：当文档与实际运行代码发生冲突时，以经过测试闭环验证的代码实际行为为事实标准，但在修订前须确认该差异是否为未修复的代码 Bug。

- **冲突就地清除**：一旦发现多份文档对同一模块/协议的定义存在矛盾，必须遵循"单一真实源（Single Source of Truth）"原则，即刻更新权威文档，并删除或合并陈旧冲突文件，禁止保留带有"待核实"、"旧版参考"等并存的过期副本。

- **溯源修正**：发现文档冲突时，应通过 `git log -S` 追溯造成分歧的具体提交点，明确变更背景后统一校正为当前最新状态，并在提交说明中明确标注文档对齐范围。

## 4. 验证与测试闭环规范 (Testing & Verification Loop)

任何代码修改必须走完完整的测试闭环。**无法通过闭环验证的代码必须立即回滚或推倒重写**，禁止携带"待修复"标记合并。

### 4.1 闭环验证流程

```Plaintext
[代码修改] ──> [单元测试] ──> [服务冷启动] ──> [集成/端到端验证]
```

1. **静态检查与构建**：

   - 本项目**没有** lint / 打包工具链（前端无构建、Python 侧未配 linter）："构建"指 `uv sync` 后能冷启动并正常服务静态资源；不得声称跑过并不存在的检查。

   - 新增或变更依赖须同步更新 `pyproject.toml` 与 `uv.lock`。

2. **自动化测试**：

   - `uv run pytest`（后端代理层 + 静态资源守卫 + 调起 node 用例）与 `node --test tests/js/*.test.mjs`（前端纯逻辑）必须全绿；新增或修改的行为必须有对应用例覆盖。

   - 用例不依赖网络与真实 paperbox / 依赖服务，也不写入真实数据源；造假一律用 `httpx.MockTransport`。

   - 修复缺陷时先写出能复现该失败的用例，修好后转为回归用例保留。

3. **本地运行与启动校验**：

   - `uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088` 必须能成功冷启动，读取 `.env` 无错误。

   - `GET /api/ui/health` 必须返回 200：paperbox 挂掉时它仍 200，错误放进 `paperbox.error`，状态条显示"不可用"而不是整页报错。

4. **功能闭环验证**：

   - 端到端跑对应业务场景（paperbox 8077 与 WebUI 8088 同时起着），验证输入、落库与输出三者一致；实测输出写进 `docs/examine/acceptance-*.md`（快照，只增不改）。

## 5. 关键协同约定 (Operational Conventions)

### 5.1 配置与凭证安全

- **零明文密码**：git跟踪代码库中严禁出现任何 API Key、数据库密码、私钥等机密数据。

- **`PAPERBOX_API_KEY` 的档位**：必须是 paperbox 签发的 **admin** 档 key（本服务代理了删除等写操作）；密钥只写 `.env`（`.gitignore` 第一行），`.env.example` 只放占位值。换 key：create 新前缀 → 改 `.env` → 重启 WebUI → revoke 旧前缀。

- **配置外置**：所有可变参数通过环境变量加载，必须在 `.env.example` 中维护最新键名与注释说明；上传队列调参由 `GET /api/ui/config` 下发给浏览器，前端不得硬编码。

### 5.2 统一日志与错误处理

- **结构化日志**：使用标准的 JSON 或上下文关联日志工具，严禁在生产路径中使用原始 `console.log` 或 `print`；本服务只打访问日志。

- **错误契约**：paperbox 的 4xx/5xx **原样透传**（状态码 + `detail`，含 429 的 `Retry-After` 响应头），已知失败模式额外补一条可照做的中文 `hint`，认不出的状态码不加 hint；paperbox 不可达时返回 `502` + hint。不得吞掉状态码、不得改写它的文案。

### 5.3 与 paperbox 的契约同步

- 被本仓库依赖的 paperbox 契约（路径、入参、出参、错误码、依赖版本基线）发生变更时，必须同步 `docs/architecture/01-paperbox-contract.md`、README 的契约清单与相关用例；三处不一致即视为未完成交付。

## 6. AI Agent 执行守则 (Agent Instructions)

AI Agent 在承接任务时必须按以下顺序行动：

1. **前置探查与历史参考**：

   - 首先阅读相关模块目录结构与既有抽象接口，确认依赖路径。

   - 若涉及编写或补充 Changelog，主动检查历史日志排版风格并查阅相关规则。

2. **最小侵入**：优先复用既有组件与工具库，严禁无故引入外部重量级依赖包（前端尤其：见 §2.3 零依赖约束）。

3. **自闭环验证**：修改完成后，主动执行单测（`uv run pytest`，含 node 用例）与冷启动校验。若报错，优先自我修正直至全绿；如逻辑存在冲突，主动报告阻碍点，不得伪造通过状态。
