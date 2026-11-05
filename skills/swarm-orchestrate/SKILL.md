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
直接按 §2 意图表路由（但先过 §1.5 两道确认门）。

## 1.5 两道确认门（缺一不可，不代跑）

- **门一（开轮 → planner）**：轮子刚建好（空轮/新轮、队列为空）时，先输出 round 名 + 已知信息摘要，然后问用户：「是否开始 planner？（#plan 输入具体需求/探索，分解成任务）」——得到确认才 `#plan`/拆解；**不要自行开始分析需求**。
- **门二（入队 → start）**：`swarm_plan` 入队后，一律输出任务映射表（任务 id/标题/risk/verify_cmd 一览），然后问用户：「是否 /swarm-start 派发？」——得到确认才执行 `/swarm-start`；大小活一视同仁，原来“≤3 直接派”作废。

## 1.6 冻结线（收尾不发散，人拍板才冻）

- **冻法**：PRD 验收全绿后，问用户「是否冻结本轮？」——确认才执行 `/swarm-freeze --run <id> --reason <一句话>`；冻后 `swarm_plan` 拒收一切新任务（hotfix:true 单任务例外，照常审计）。
- **收尾轮纪律**：只收 Nit，不开新任务（没有 wN-T5）；够 Important 的当场二选一——独立 hotfix（人批）或 debt backlog（wontfix+reason）；out-of-scope findings 只登记不 block。
- **停信号**（两个都绿才收，不绿就继续是错的）：① PRD 验收全绿；② 新发现仍在原始模块内。出模块的发现只登记，由人批量拍板开不开新任务。
- **解冻**：冻错/漏 hotfix 时 `/swarm-unfreeze --run <id>`（timeline 留痕，可审计）。

## 2. 意图表

| 用户人话 | 意图 | 动作 |
|---|---|---|
| "这个 bug 修一下 / 挂了，再看看" | bugfix | `swarm_read_queue` 找命中任务则复用，否则 `swarm_plan` 建单任务（带 stack）→ 问用户「是否 /swarm-start 派发？」（门二）→ 确认后派 dev 会话/子代理开工 → 修完走 `subagent(test)` → 验收通过主会话调 `/swarm-clean` 归档（人不敲命令） |
| "加个功能 / 改一版 / 来个新需求…" | 新需求 | 先问用户「是否开始 planner？」（门一）→ 确认后先落 PRD，小活直接拆、大活开 planner 会议再拆 → `swarm_plan` 批量（每项带 stack：backend/frontend/integration，pin prd） → 问用户「是否 /swarm-start 派发？」（门二）→ 确认后按 wave 派 → 每个任务 test pass 后立刻加载 `swarm-quality` 走一遍（先于 reviewer；有 High 回 dev，无问题进 reviewer/drained） |
| "再测一遍 / 验证下 W1-T1" | 复测 | 派 `subagent(test)`，带 `verify_cmd` + 边界 |
| "现在啥情况 / 到哪了" | 进度 | 读队列 + timeline，回一句话（做了什么/卡在哪/谁在跑） |
| "别跑了 / 停 / 回滚重来" | 叫停 | `swarm_halt` 熔断；要重做再 `swarm_revert` |
| "放行 / 批准这单 / 高风险过了可以跑" | 高风险放行 | 调 `swarm_approve`（仅 high-risk 有效；多单批量用 `task_ids` 数组，原子语义；批后派发自动解锁，不改状态） |

模糊（对不上五类）只追问一句，用 question 工具问清：
"你这是 bugfix / 新需求 / 复测 / 进度 / 叫停哪一种？顺带给任务号或一句话需求。"
拿到答案再路由，不猜着开工。

## 3. 循环 recipe（伪代码级）

```
swarm_read_queue 看现状 → 按 §2 分类意图 →
  bugfix: swarm_read_queue 找命中则复用 else swarm_plan 建单任务（带 stack）→ 问用户「是否 /swarm-start 派发？」（门二，确认后执行；未 start 前认领会被闸门拒）→ dev 会话/子代理开工（prompt=验收+verify_cmd+上次失败史）→ 修完派 subagent(test, model=roleModels.test, prompt=verify_cmd+边界) → test pass 后主会话加载 swarm-quality 走一遍（只建议不拦截；有 High 回 dev，无问题照常往下）→ 再执行 /swarm-clean 归档（人不敲命令，整轮搬运可审计）
  新需求: 先问用户「是否开始 planner？」（门一）→ 确认后先落 PRD，小活直接拆 / 大活开 planner 会议 → swarm_plan 批量（带 stack，pin prd） → 问用户「是否 /swarm-start 派发？」（门二）→ 确认后按 wave 派 dev/test → 每个任务 test pass 后立刻加载 swarm-quality 巡检（先于 reviewer；有 High 回 dev，无问题进 reviewer/drained）
  复测: subagent(test, model=roleModels.test, prompt=verify_cmd+边界)
  进度: 读队列+timeline 报一句话
  叫停: swarm_halt / swarm_revert（tool 版，与命令同逻辑）
轮询 swarm_read_queue 直到 drained 或 HALT → test pass 后主会话执行 /swarm-clean 归档（人不敲命令，归档可审计）→
汇报（做了什么 / 验证证据 verify_cmd 输出 / 要人看什么：验收勾选或 retry/revert 二选一）
```

- **默认主会话即 planner**：`/swarm-up` 不再另建 plan 会话（`plan = 当前会话`），直接在窗口里 `#plan 拆解 <需求>`；要旧行为加 `--plan-session new`。
- **`/swarm-start` 是唯一派发授权**：`/swarm-up` 只开轮不派发；未 start 前 `swarm_claim/swarm_next` 会被闸门拒收（逃生口 `force:true`）。planner 入队后必须等人确认（门二）再执行 `/swarm-start`；主会话只负责把问题问出来，不代跑派发。
- **并行多轮**：run 解析优先级 = 显式 `run` > 任务归属（带 task_id 时）> 会话绑定（`round.json` 的 sessions/members）> 全局 `.swarm/current`。同一会话开新轮会被自动从旧轮摘走；不同窗口并行互不抢指针。
- dev（会话 wake 为主）prompt = 任务 JSON + 验收标准 + `verify_cmd` + 上次 fail 的 `detail/failed_ids`（时间线现成，直接复用；自然语言 bug 全程不让人碰 dev 会话，主会话代跑唤醒）。
  - **prompt 首行写 `run=<runId>`**，并让子代理在工具调用里带上 `run`；插件也会按 `task_id` 兜底反查，但显式带上更稳。
- test 子代理 prompt = 任务 JSON + `verify_cmd` + 边界要求。
- reviewer（review=true 任务 test pass 后）prompt = 任务 JSON + `git show <commit>` diff（截断 50KB）+ REVIEW.md 命中 + `excluded=[finding ids]`。
- 判活口径与 `/swarm-drained` 同调：queued 空 + 无 `dev_doing/test_doing/reviewing` 即结束。
- high-risk 任务派 subagent 前先查 approve 行（`swarm_read_queue` 看 timeline 或 status 待批行），无批不派（`swarm_claim` 无批拒收，`force:true` 可绕过但审计可见）。
- 确认门见 §1.5（两道门：开轮问 planner，入队问 start；原来“≤3 直接派”作废）。

## 4. 模型映射（start 时人工按需分配，门禁硬拦）

- 开轮（`/swarm-up`）不定模型；planner 拆任务时每项必带 `stack`（backend/frontend/integration）。
- 派发前调 `swarm_config` 读 `{executor, roleModels, currentRun, runId, stacks, missingModels}`：
  `stacks` = 本轮实际出现的 stack，`missingModels` = 缺的模型键（纯 legacy 轮两者皆空）。
- 分栈取模型：backend 任务的 dev 用 `roleModels.dev_backend`，frontend 用 `roleModels.dev_frontend`
  （legacy `roleModels.dev` 通配前后端）；test 一律 `roleModels.test`，reviewer 用 `roleModels.reviewer`。
- dev 会话唤醒沿用建会话时写入的模型（不另传参）；subagent 派发时 `model=` 按上条分栈填写。
- 缺啥问人要（用 question 工具），问到后重跑带模型的 `/swarm-start` 落盘：
  `--dev-backend-model p/m --dev-frontend-model p/m --tester-model p/m --reviewer-model p/m` 按需只给要的；
  未配齐时 `/swarm-start` 直接拒收（门禁硬拦，不用主会话盘点）。
- subagent 无模型传参则继承父会话模型（官方语义），不写死任何模型名。

## 5. 六铁律 + 异常升级

1. **接管宣告**：开工先说一句"我来编排本轮（run=<id>），全程代跑，有事叫你"，再调工具。
2. **派发必带验收标准 + verify_cmd**：每个 subagent prompt 必须含任务的 `acceptance` 与 `verify_cmd`（+ 失败史），缺一律不派。
3. **叫停即 halt 重排**：用户喊停先 `swarm_halt` 熔断，再问是 retry 还是 revert，不硬修。
4. **两道门都必须等人回话**：开轮后问 planner（门一），入队后问 start（门二）；不代跑、不脑补、不跳过。
5. **只有持轮会话派单**：claim/done/test/review 回执首行带 `run=`，派之前先对轮——别在 A 轮的会话里派 B 轮的活（串轮事故就是这么来的）。

6. **三笔账规避（返工税）**：planner 拆任务时 acceptance 必须枚举对称路径（读写删三端、通过/驳回两分支——“只修一半”死在这）；reviewer 出结论前先 grep 全仓同类实现（有现成 helper 而新写一套→Important 打回——“两处各写一套”死在这）；dev 动手前先找后写。口径没写就是流程的债，不记模型的账。

异常升级：HALT 已有推送（requester 会收到"⛔ HALT 通知 … 恢复：/swarm-retry --task X"），
收到即停轮询、原话转述给用户，等拍板；高风险任务（`risk=high` 或命中 `sensitivePaths`）
把"⚠️ 高风险：建议两人复核"原文转述，不自己放行。
