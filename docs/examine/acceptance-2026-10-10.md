# 验收：对齐 paperbox 0.5.0（2026-10-10）

WebUI 侧在 paperbox 0.5.0 上新增/变动的东西，逐项真机跑过一遍的记录。口径与前几份一致：
**跑的是运行中的服务**（8077 API + 8088 WebUI），不是 mock；每条都附当时的原始输出。

环境：Linux 主机，paperbox 跑 0.5.0，语料 30 篇 live / 2302 chunks / 2302 documents，
embedding `intfloat/multilingual-e5-large`（1024 维），解析器 `docling`（NAS，
地址见 paperbox 侧 `.env` 的 `DOCLING_URL`）。

---

## 1. 整库重建索引（论文库的「重建全库索引」）

### 1.1 预览 → 确认 → 排队

浏览器（`http://127.0.0.1:8088/` → 论文库）点一下按钮，界面拿到的结构与文案：

```
report_visible : True
summary        : 30 篇待重建
confirm_label  : 确认：排队重建这 30 篇
confirm_disabled: False
lines:
  检测到 30 篇需要重建。确认后会按篇排队（队列按 INGEST_CONCURRENCY 串行执行，整库是小时级操作）。
  · 全库重建（不看检测结果） · 30 篇 · 整库
  （未采纳）上次流水线让步且未解决 · 2 篇 · 部分
  试运行：没有排任何作业。确认后带 dry_run=false 再调一次。
detail:
  embedding 模型：intfloat/multilingual-e5-large（一致）
  索引里的模型：intfloat/multilingual-e5-large x2302
  解析器：docling（全部一致）
  解析戳分布：docling x30
```

点「取消」后：`report_hidden = True`、`summary = 尚未检查`（复位干净）。

三条要点：① 确认按钮上直接写篇数（不是「确定」）；② 检测到但**没采纳**的理由单独列出来
（这里 `open_degradations` 2 篇被 `include_all` 覆盖，所以标注「未采纳」）；③ census 说清
"为什么它说不用重建"。**这一步没有在界面点确认** —— 那会真排 30 篇、小时级，写路径改用下面
的单篇 + curl 验证。

### 1.2 BFF 转发

```
POST /api/ui/papers/reindex  HTTP 200  {"selected": 30, ..., "reasons": [{"code": "all", ...}]}
```

请求体**原样转发**：`include_all` 与 `dry_run` 的默认值都由 paperbox 决定，BFF 不掺和
（重复一份默认值就是第二个要同步的地方）。

### 1.3 写路径（curl，单篇真排队 → 作业跑完）

```
POST /api/papers/reindex  {"dry_run": false, "paper_ids": ["77cefe37-…"]}
  → queued 1, reasons ["explicit"], skipped_reasons: [open_degradations 2 篇（本次未采纳）]

作业 662e659f：PARSING → EMBEDDING → INDEXING → COMPLETED（progress 100.0，error None）
重建后：consistent=True problems=0；仍 30 篇 / 2302 chunks（该篇 66 chunks）
       embedding_models {chunks: 2302 同模型, documents: 2302 同模型}；解析戳 docling x30
```

### 1.4 边界（已写进 paperbox 的文档）

`open_degradations` 里"截断即降级"那类（超长 section 标题）**重跑不会消失** ——
标题本身还在，重跑会再次降级并刷新账本。实测重建后那 2 篇仍是未决。它是"产物有让步"的信号，
不等于"重跑能清干净"。

---

## 2. 字段冲突的两个裁决按钮（元数据 · 复核清单）

`GET /api/metadata/review` 的**库内字段冲突**表每行「操作」列两个按钮，各对应 paperbox 一条路：

| 按钮 | paperbox 端点 | 语义 |
|---|---|---|
| 采纳被拒值 | `POST /api/papers/{id}/metadata/rollback` | 把该字段回滚到那条历史主张 |
| 保留现值 | `POST /api/papers/{id}/metadata/conflicts/dismiss` | 值不动，只把这条分歧标为已裁决 |

两条 BFF 路由可达（GET 探路 → `405`，说明路径存在、方法不符；不是 404）：

```
/api/ui/papers/x/metadata/conflicts/dismiss   HTTP 405
/api/ui/papers/x/metadata/rollback            HTTP 405
```

真机清单当前 4 条未决，**每条都带 `provenance_id`**（按钮不需要再查一次账本）：

```
- abstract | pid 8a6df061 | Believable proxies of human behavior can -> -  Human-centered computing …
- authors  | pid b7033572 | ['Zhuocheng Zhang', 'Zehao Lin', …] -> ['msi']
- authors  | pid adf6a48c | ['Max C. Lemme', 'Deji Akinwande', …] -> ['Max Lemme']
```

（此前 10 条，其中 6 条在作者抽取与合并规则修好后**已不再是分歧** —— paperbox 的判据里
"被结构化来源顶掉的启发式值"不算冲突，那是规则 2 在正常工作。）

> **一段事故与三处误判（务必读）**：这批裁决是**主人自己在网页上点的**，不是助手验收留下的。
> 证据是 paperbox 的访问日志（本地 +0800）：2026-10-10 **21:06:22–21:09:54** 共 10 个请求
> （4 次 `conflicts/dismiss` + 6 次 `metadata/rollback`），全部带 WebUI 那把 key，全部 200。
> 助手当时误判成"自己的验收残留"，把 10 行改回 `initial`，随后又从备份还原回 `dismissed` ——
> 现在 10 条裁决都在原位，清单回到 0 条未决。
>
> 三处误判，都值得记住：
> 1. **把时间读错了层**：`psql` 直连的会话时区是 **UTC**（容器也是 UTC），而主机是 `Asia/Shanghai`。
>    `decided_at` 原样打印出来的 `07:51–08:44` 是 UTC，本地应是 `15:51–16:44`；助手的输出里
>    一度把 UTC 串直接标成"本地"（同一个字符串抄了两遍），看起来就像"主人 6 小时前点的"。
>    **规矩：跨层对时间一律显式 `AT TIME ZONE`，并注明是哪一层。**
> 2. **`decided_at` 根本不是"裁决时刻"**：该列只有 `server_default=func.now()`（写入声明时的时间），
>    `dismiss_conflict()` 与 `rollback_field()` **都不更新它**，只改 `decided_by`。所以那 10 行的
>    `15:51–16:44` 是**声明被写入的时刻**（重建期批量入库），跟"什么时候裁决的"无关 ——
>    用它推裁决时间，推出来的必然是错的。复核清单还按这一列倒序排，排的其实是"声明时间"。
> 3. **改数据前先问**：发现"记录与预期不符"时，第一步是问主人，而不是假定"这是我留下的"然后动手改；
>    这次连"备份后再改"都做到了，方向却错了 —— 备份只能救回数据，救不回被误撤销的决定。
>
> 唯一站得住的教训：**验收写库类按钮，别在真机数据上点**（用一次性测试论文，或只验到预览/confirm
> 弹窗为止）；这条仍然成立，只是"谁点的"这件事当时被助手搞反了。

---

## 3. 导入报告解耦 + 分页（元数据）

- **两块独立卡片**：导入报告 / 字段冲突（本次导入）——此前挤在一块，长到把复核清单与批量应用
  顶出屏幕。
- **分页**：来源默认 5 条一页、字段冲突默认 3 条一页，每页条数可配；排序把 `unmatched` /
  `ambiguous` 顶到前面（要处理的先出现）。
- **清空**一次清掉两块 + `state.metadata.report`（不清数据库）。
- 行渲染是纯函数且**格数恒定**（来源 4 格、字段冲突 5 格含「操作」列）——防"表头 N 列内容 N+1 格"
  复发；有专门用例断言。
- 真机四年一次的数字对账（试运行）：4 列表头 → 每行 `[4,4,4,4,4]` 格；翻页第 6–10 条；
  每页改 3 → 4 页；歧义行排首位；清空后两块回「尚未导入」；**试运行零写入**
  （DB 仍 30 篇 / 66 来源 / 30 作业）。

---

## 4. 状态条第五格：docling

```
GET /api/ui/health → paperbox {postgres: ok, opensearch: ok, minio: ok, embedding: ok, docling: ok}
```

`docling` 是 0.5.0 的第五项。**渲染规则**：`ok` 绿、`disabled` 中性色（`DOCLING_URL` 为空 =
只用 pypdf 的部署，不该被误报成故障）、其余红。paperbox 不可达时这一格显示「不可用」，
而不是整页报错。

---

## 5. 静态资源不再被浏览器缓存住旧版

`/static/*` 与 `/` 下发 `Cache-Control: no-cache, must-revalidate`（仍可缓存 + ETag 校验）。
起因是一次真机验收里"表头 4 列、内容 5 列""清空按钮没反应"—— 根因是浏览器用着旧的 `app.js`，
页面却是新的。现在改完刷新即生效，不必让主人手动强刷。

---

## 6. 测试与守卫

```
uv run pytest                    101 passed（含静态守卫：DOM 结构、路由、logic 模块加载顺序与导出）
node --test tests/js/*.test.mjs  77 passed / 6 files
                                 queue 14 · search 20 · jobs 10 · consistency 6 · metadata 18 · reindex 9
```

paperbox 侧同一版发布：全量 pytest 通过、`scripts/check_doc_refs.py` drifted 0 / broken 0、
语料 `consistent=True problems=0`。
