# 真机验收记录：并发上传 + 429 退避 + 两阶段进度

日期：2026-09-20 ｜ 仓库：`paperbox-webui`（WebUI 改动 commit `5fe2bfc` 起，含验收期修复 `5764244`）

paperbox 侧版本：`C:\Users\xuanj\Desktop\hermes\paperbox`（2026-09-19 契约：`/api/papers/ingest/files`、
`429 + Retry-After`、`/api/jobs/queue`、`QUEUED`）。**paperbox 一个字节都没改。**

跑法：paperbox `uv run uvicorn app.main:app --host 127.0.0.1 --port 8077 --workers 1`（按每项验收需要
临时改 `INGEST_*` 环境变量），WebUI `uv run uvicorn webui.main:app --host 0.0.0.0 --port 8088`（默认配置，
`WEBUI_UPLOAD_CONCURRENCY=2`）。

探针文件由 `.hermes/acceptance/make_probe_pdfs.py` 生成（纯标准库造 PDF，正文一整行、无逗号/and，
避免 paperbox 的启发式作者识别把句子碎片当作者名——第一版探针踩过，见文末"观察"）。

---

## 1. BFF 契约

```
$ curl -s http://127.0.0.1:8088/api/ui/config
{"upload_concurrency":2,"upload_max_attempts":6,"retry_base_ms":2000,"retry_cap_ms":60000,
 "file_max_mb":100,"batch_hint_threshold":20}

$ curl -s http://127.0.0.1:8088/api/ui/jobs/queue          # 不是 404，也没被 /jobs/{job_id} 吞掉
{"started":true,"concurrency":1,"running":1,"queued":2,"queued_high":1,"queued_low":1,
 "running_job_ids":["44ec5870-…"],"queued_job_ids":["77118c19-…","005c6a73-…"]}
```

`queued_high=1 / queued_low=1` 正好印证契约：单文件请求（WebUI 的上传）是交互优先级、会插到批作业前面。

## 2. 多文件代理

```
$ curl -s -i -F files=@curl-7.pdf -F files=@curl-8.pdf -F files=@curl-9.pdf \
       http://127.0.0.1:8088/api/ui/ingest/files
HTTP/1.1 202 Accepted
{"request_id":"645aebc34e2c4656","accepted":3,"duplicate":0,"rejected":0,
 "results":[{"filename":"curl-7.pdf","status":"accepted","job_id":"38124ff8-…","size_bytes":1679}, …]}
```

逐文件结果、`size_bytes` 都原样透出（说明 BFF 是把 spooled 临时文件流式转发的，没有整块读进内存）。

## 3. 429 + `Retry-After`（关键项）

**(a) 并发闸门**：paperbox 用 `INGEST_UPLOAD_CONCURRENCY=1` 起，同时发 3 个 60MB 单文件上传：

```
busyhuge-160.pdf  status=202 retry-after=-  body={"request_id":"c38bfa41…","accepted":1,…}
busyhuge-161.pdf  status=429 retry-after=2  body={"detail":"server busy: upload concurrency: 1 request(s) already in flight; retry after 2s"}
busyhuge-162.pdf  status=429 retry-after=2  body={"detail":"server busy: upload concurrency: 1 request(s) already in flight; retry after 2s"}
summary: 202×1, 429×2
```

`Retry-After: 2` 穿过 BFF 到达客户端——这正是改造前丢失、导致前端只能把 429 当失败的那个头。

**(b) 浏览器里的退避**：同一配置下在页面里上传 6 个 4MB PDF，页面内 20ms 采样器记录到：

```
maxUploading = 2
sawBackoff   = true
backoffTexts = ["排队退避 2s", "排队退避 1s", "排队退避 0s"]     # 徽标倒计时
最终 6 项全部「已完成」，没有一项因为 429 变成失败
```

## 4. 并发生效

同上两次运行（6×4MB 与 5×4MB），页面内采样器统计"同时处于 `上传中` 的项数"：

```
maxUploading = 2      # 两次运行都是 2，等于 WEBUI_UPLOAD_CONCURRENCY 默认值
```

`uploadSlots()` 一次把 2 个空位填满，上传结束立刻补位；作业轮询不占并发位。

## 5. 两阶段进度

一次 6 文件上传里 `#queue-summary` 的连续取值（去重、按时间顺序）：

```
（共 6 项 · 上传 3/6 · 处理 2/3）
（共 6 项 · 上传 5/6 · 处理 2/5）
（共 6 项 · 上传 5/6 · 处理 2/5 · 服务端排队 1）     # 来自 /api/ui/jobs/queue
（共 6 项 · 上传 6/6 · 处理 3/6 · 服务端排队 1）
（共 6 项 · 上传 6/6 · 处理 5/6）
（共 6 项 · 上传 6/6 · 处理 6/6）
```

上传阶段结束后保留 `上传 6/6`、`处理 a/6` 继续走动，最后 6 个作业全部 `COMPLETED`：

```
$ curl -s "http://127.0.0.1:8077/api/jobs?limit=10"
4a71ae25 COMPLETED 100.0 dup=False
85b4ab2e COMPLETED 100.0 dup=False
…（6 个 COMPLETED）
```

## 6. `QUEUED` 可见

paperbox 用 `INGEST_CONCURRENCY=1` 起（流水线单并发），上传 4 个 25 页 PDF，页面里读到：

```
排队中（2/9）          ← 不是 QUEUED（1/8）
同一次运行里出现过的阶段文案：
  排队中（2/9） / 下载中（3/9） / 向量化中（7/9）/ 建立索引中（8/9）/ 已完成
摘要：共 4 项 · 上传 4/4 · 处理 0/4 · 服务端排队 3   →  上传 4/4 · 处理 4/4
```

（`STAGES` 现在 9 个阶段，`QUEUED` 按决策 #8 插在 `RECEIVED` 之后，所以是 `2/9` 而不是计划文里举例的 `1/9`。）

## 7. 停止语义

**7.1 中止在途上传**：上传 5 个 4MB PDF，等两个同时在途时点「停止」：

```
uploadingAtStop = 2      # 两个 XHR 正在上传
afterStop       = 0      # 点击后立刻归零：两个都被 abort（不只一个）
两项变为「已取消」，其余 3 项保持「待上传」；「停止」按钮隐藏、「开始上传」重新可用
```

**7.2 摘要冻结**：`处理 a/b` 与逐项 stage 文案不再变化（停止后 +15s、+35s 两次读取完全一致），
`· 服务端排队 q` 也不再出现——停止即停止跟踪。

**7.3 已提交的作业仍跑完**：3 项已提交（`排队中（2/9）`/`下载中（3/9）`）时点停止，
随后 paperbox 侧查询：

```
Probe Upload Paper 180 INDEXED
Probe Upload Paper 181 INDEXED
Probe Upload Paper 182 INDEXED      ← 停止前已提交的作业全部跑完
```

被 abort 的那一项（`上传中 0%`）同样变成了 INDEXED：请求体已经到达 BFF 时，前端 abort 只能终止
本页的跟踪，paperbox 没有取消接口——这正是 UI 文案里写明的那件事。

## 8. 收尾

删除 30 篇探针论文（`DELETE /api/papers/{id}`，204）后回到导入前的基线：

```
before: papers=68 docs=2883 objects=68
after : papers=68 docs=2883 objects=68      # 完全一致
authors: 460（0 个重名、0 个孤儿）、队列 running=0 queued=0
```

---

## 验收期发现并修掉的两个 WebUI 问题（commit `5764244`）

1. **`上传 x/y` 会倒挂**：真机里出现过 `上传 7/4`——已提交的项随后被取消时，它被算进 `uploaded`
   却从 `toUpload` 里消失。改为"取消前已提交的文件仍计入需上传"，并加 node 用例锁住 `uploaded ≤ toUpload`。
2. **停止后仍在轮询服务端队列**：`· 服务端排队 q` 会在停止后继续变化。`queueHasLiveJobs()` 现在
   在 `halt` 时直接返回 false，停止即彻底停止跟踪。

## paperbox 侧的观察（未修改，仅记录）

- `POST /api/papers/ingest/files` 的 `size_bytes`、逐文件 `rejected`、优先级插队都符合契约。
- 一次性导入中有一项作业以 `INTERNAL: MultipleResultsFound` 失败（`paper_service.get_or_create_author`
  用 `scalar_one_or_none` 查 `normalized_name`，而该列没有唯一约束）。触发条件是同一批文件被启发式
  元数据抽取器认出了**相同的"作者"碎片**（第一版探针 PDF 的正文含逗号与 "and"，被切成了 2~5 词的
  "作者名"）。失败后**留下了 `status=FAILED` 的存活论文行与它的 MinIO 对象**，需要手工 `DELETE` 清理。
  换掉探针正文写法后不再复现；paperbox 是否要加唯一约束/失败回滚不在本次范围内。
