---
name: swarm-orchestrate
description: "主会话自然语言编排 swarm 轮次：人话开工，全程代跑，只在拍板/出事时找人。用当用户在主会话用自然语言提需求/bug/复测/进度/叫停，且上下文是 swarm 轮次时。"
---

# Swarm 自然语言编排

主会话说人话即可开工：意图路由 + 全程代跑 + 只在要拍板/出事时找人。
命令（`/swarm-halt` 等）是应急通道，日常走本 skill 的 tool 循环。

## 1. 何时加载

用户在主会话用自然语言提需求 / 报 bug / 要复测 / 问进度 / 喊停，
且上下文是 swarm 轮次（有 run、队列、`.swarm/runs/<id>/`）时加载。
本轮无需历史数据时，不调 `swarm_read_queue` 之外的历史命令，
直接按 §2 意图表路由。

## 2. 意图表

| 用户人话 | 意图 | 动作 |
|---|---|---|
| "这个 bug 修一下 / 挂了，再看看" | bugfix | `swarm_read_queue` 找命中任务则复用，否则 `swarm_plan` 建单任务 → 派 dev 会话直接开工（wake 已投递）→ 修完走 `subagent(test)` → 验收通过主会话调 `/swarm-clean` 归档（人不敲命令） |
| "加个功能 / 改一版 / 来个新需求…" | 新需求 | 小活直接拆成任务，大活开 planner 会议再拆 → `swarm_plan` 批量 → 按 wave 派 → 每个任务 test pass 后立刻加载 `swarm-quality` 走一遍（先于 reviewer；有 High 回 dev，无问题进 reviewer/drained） |
| "再测一遍 / 验证下 W1-T1" | 复测 | 派 `subagent(test)`，带 `verify_cmd` + 边界 |
| "现在啥情况 / 到哪了" | 进度 | 读队列 + timeline，回一句话（做了什么/卡在哪/谁在跑） |
| "别跑了 / 停 / 回滚重来" | 叫停 | `swarm_halt` 熔断；要重做再 `swarm_revert` |
| "放行 / 批准这单 / 高风险过了可以跑" | 高风险放行 | 调 `swarm_approve`（仅 high-risk 有效；批后派发自动解锁，不改状态） |

模糊（对不上五类）只追问一句，用 question 工具问清：
"你这是 bugfix / 新需求 / 复测 / 进度 / 叫停哪一种？顺带给任务号或一句话需求。"
拿到答案再路由，不猜着开工。

## 3. 循环 recipe（伪代码级）

```
swarm_read_queue 看现状 → 按 §2 分类意图 →
  bugfix: swarm_read_queue 找命中则复用 else swarm_plan 建单任务 → dev会话直接开工（wake已投递，prompt=验收+verify_cmd+上次失败史）→ 修完派 subagent(test, model=roleModels.test, prompt=verify_cmd+边界) → test pass 后主会话加载 swarm-quality 走一遍（只建议不拦截；有 High 回 dev，无问题照常往下）→ 再执行 /swarm-clean 归档（人不敲命令，整轮搬运可审计）
  新需求: 小活直接拆 / 大活开 planner 会议 → swarm_plan 批量 → 按 wave 派 dev/test → 每个任务 test pass 后立刻加载 swarm-quality 巡检（先于 reviewer；有 High 回 dev，无问题进 reviewer/drained）
  复测: subagent(test, model=roleModels.test, prompt=verify_cmd+边界)
  进度: 读队列+timeline 报一句话
  叫停: swarm_halt / swarm_revert（tool 版，与命令同逻辑）
轮询 swarm_read_queue 直到 drained 或 HALT → test pass 后主会话执行 /swarm-clean 归档（人不敲命令，归档可审计）→
汇报（做了什么 / 验证证据 verify_cmd 输出 / 要人看什么：验收勾选或 retry/revert 二选一）
```

- dev（会话 wake 为主）prompt = 任务 JSON + 验收标准 + `verify_cmd` + 上次 fail 的 `detail/failed_ids`（时间线现成，直接复用；自然语言 bug 全程不让人碰 dev 会话，主会话代跑唤醒）。
- test 子代理 prompt = 任务 JSON + `verify_cmd` + 边界要求。
- reviewer（review=true 任务 test pass 后）prompt = 任务 JSON + `git show <commit>` diff（截断 50KB）+ REVIEW.md 命中 + `excluded=[finding ids]`。
- 判活口径与 `/swarm-drained` 同调：queued 空 + 无 `dev_doing/test_doing/reviewing` 即结束。
- high-risk 任务派 subagent 前先查 approve 行（`swarm_read_queue` 看 timeline 或 status 待批行），无批不派（`swarm_claim` 语义不动，仍可绕过，靠审计威慑）。
- 确认门（大活先公示再派）：`swarm_plan` 拆完后，若任务数>3 或含 high-risk（阈值写死，不做配置项），先输出任务映射表（任务 id/标题/risk/verify_cmd 一览），等人回"可以派"再派 subagent；≤3 且无 high-risk 可直接派。

## 4. 模型映射

- 派发前调 `swarm_config` 读 `{executor, roleModels, currentRun, runId}`。
- dev 会话唤醒沿用建会话时写入的 `roleModels.dev`（不另传参），test 用 `roleModels.test`，reviewer 用 `roleModels.reviewer`。
- 缺失只问一次（用 question 工具），问到后重跑带模型的 `/swarm-start` 落盘，后续不再问。
- subagent 无模型传参则继承父会话模型（官方语义），不写死任何模型名。

## 5. 三铁律 + 异常升级

1. **接管宣告**：开工先说一句"我来编排本轮（run=<id>），全程代跑，有事叫你"，再调工具。
2. **派发必带验收标准 + verify_cmd**：每个 subagent prompt 必须含任务的 `acceptance` 与 `verify_cmd`（+ 失败史），缺一律不派。
3. **叫停即 halt 重排**：用户喊停先 `swarm_halt` 熔断，再问是 retry 还是 revert，不硬修。

异常升级：HALT 已有推送（requester 会收到"⛔ HALT 通知 … 恢复：/swarm-retry --task X"），
收到即停轮询、原话转述给用户，等拍板；高风险任务（`risk=high` 或命中 `sensitivePaths`）
把"⚠️ 高风险：建议两人复核"原文转述，不自己放行。
