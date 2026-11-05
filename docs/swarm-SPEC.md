# Swarm 插件（v2，2026-10-25 重写）

多会话编排：planner 拆任务 → dev 做 → test 独立验 → 不过回 dev → 3 次自动熔断。
用户只需敲 **tag**，不用写长提示词。

## 1. 分层结构

```
.opencode/
├─ lib/
│  ├─ swarm-store.js    原子队列：tmp+fsync+rename / 目录锁 / CAS / mtime 缓存
│  ├─ swarm-exec.js     verify_cmd 沙箱：无 shell / 白名单 / 异步 / 硬超时 / 输出截断
│  ├─ swarm-filebus.js   通道：本地 events.jsonl，幂等 eid / tail 补捞（无 outbox）
│  ├─ swarm-events.js   旧通道薄适配（委托 FileBus，兼容保留）
│  ├─ swarm-gate.js     门禁：命令真跑 + verdict.allPassed + reviewedCommit==HEAD
│  ├─ swarm-roles.js    角色表 + tag 展开（加角色只加一行）
│  └─ swarm-sessions.js 模型校验（候选建议）/ 需求命名 / 轮次台账 round.json
├─ plugins/
│  └─ swarm.js          薄插件：命令 + 工具 + prompt/title hook + sweep
└─ agents/
   ├─ swarm-plan.md     planner 角色（write/edit deny）
   ├─ swarm-dev.md      dev 角色
   └─ swarm-test.md     tester 角色（write/edit deny）
```

## 2. 用户怎么用（tag 唤起）

在任意会话里：

```
#plan 拆解 docs/xxx.md 的需求        → 注入 planner 契约
#dev W3-T1                          → 注入 dev 契约 + 任务标题/验收/verify_cmd
#test W3-T1                         → 注入 tester 契约 + 任务详情
```

tag 由插件的 `session.prompt` hook 展开：角色契约 + 任务详情 + 你的补充要求（补充要求已内嵌为展开体 `## 补充要求` 节，不再复读原话全文）。
审计走 timeline/通道事件，不走 prompt token。非 tag 输入完全不改写。

也可以直接把会话切成对应 agent（agent 文件已带完整 system prompt，Tab 切换即可）。

## 3. 命令

| 命令 | 作用 |
|---|---|
| `/swarm-up [--dev-model c/d --dev-backend-model b/b --tester-model e/f] [--name 需求名] [--new] [--dry-run]` | 开轮只建空轮（模型可在 start 时再给）；带模型 flag 则先校验再按需建 dev 常驻会话并按需求命名；同名非空轮默认问复用还是新开（`--new` 强制派生） |
| `/swarm-start [--dev-backend-model b/b#high --dev-frontend-model f/f --tester-model e/f --reviewer-model r/r] [--name 需求名] [--no-wake]` | 按需模型门禁（缺啥硬拦；模型值可选带 `#variant` 思考强度，错强度拒收并列可用项）→ 派发第一个 queued 任务 + 唤醒 dev 会话 |
| `/swarm-status` | 轮次名 + 会话表（role/session/title/model/手上任务）+ 队列 + 通道尾 + 卡住的任务 |
| `/swarm-models [--provider p] [--search q]` | 列可用模型，用于挑 `provider/model` |
| `/swarm-halt --task X [--reason …]` | 人工熔断 |
| `/swarm-retry --task X` | 重试熔断任务（retries 归零，并唤醒 dev） |

## 3.1 模型校验与命名（2026-10-29 修）

**为什么必须校验**：OpenCode 的 `session.switchModel` 对不存在的 provider/model 返回 204（静默成功），
错误要等该会话真正跑一步才以 `ModelUnavailableError` 冒出来。用户看到的现象就是
「swarm-up 成功了，但三个会话全废、任务不知道有没有派下去」。

现在的链路：

1. `swarm-up` 先读 `ctx.model.list()` 建索引（**兼容 `Model.Info[]` 与 `{location,data}` 两种返回**）；
2. 每个 `provider/model` 逐个校验：provider 不存在 → 用归一化比较给候选；模型名大小写不一致 → 给确切写法；
   同 ID 在别的 provider 下存在 → 直接给「你是不是想用」（覆盖 `OpenCode`→`opencode-go`、`Opencodel` 这类拼错）；
3. **任何一个不合法 → 一个会话都不建**，输出里逐条列出角色/原因/建议；
4. 合法才 `session.create({ title, agent, model })`，然后 `session.get` **回读核对**模型与 agent；
5. 台账落 `.swarm/runs/<runId>/round.json`（`name` + 三角色 sessionID + `members` 动态成员）。
   默认 **plan = 发起 `/swarm-up` 的主会话**（`sessions.plan`/`members[host]` 都指向它，不另建 plan 会话）；
   `--plan-session new` 恢复「另建 plan 会话」。

**命名**：`--name` 或 `#plan <需求>` 触发 `nameRound()`：主会话用纯需求名，
其余角色 `需求名 · dev` / `需求名 · test`；`title` hook 拦掉 OpenCode 的自动标题，避免被改成猜出来的短句。

**派发可见性**：`dispatchNext()` / `swarm_done` / `swarm_test(fail)` 之后直接向对应角色会话
`session.prompt(#role <task>)` 唤醒它（`autoWake` 默认开，`--no-wake` 关）。唤醒结果如实回显：
`已唤醒 <sid>` / `未自动唤醒：<原因>` / `⚠️ 唤醒失败：<err>`，不再静默吞掉。

## 4. 工具（agent 调用）

| 工具 | 谁用 | 动作 |
|---|---|---|
| `swarm_read_queue` | 全部 | 读队列（可按 status 筛） |
| `swarm_plan` | planner | 批量入队（必填 id/wave/title/acceptance/verify_cmd/testing/**stack** 三选一 backend/frontend/integration、查重；可选 `review/reviewDepth`；可选 `prd` 记 PRD 路径、`name` 命名） |
| `/swarm-freeze --run <id> [--reason]` | 人工 | 冻结本轮：`swarm_plan` 拒收一切新任务（hotfix:true 例外）；meta+timeline 留痕；幂等 |
| `/swarm-unfreeze --run <id>` | 人工 | 解冻：恢复入队；未冻结轮直接回无需解冻 |
| `swarm_claim` | dev | queued → dev_doing（CAS，不双花） |
| `swarm_next` | dev | 取当前 dev_doing 任务详情 |
| `swarm_done` | dev | **过门禁**后 → test_doing，发 `[TASK-DONE]` |
| `swarm_test` | test | pass → passed（review=true 则→reviewing 待审）+ 派下一单；fail → dev；≥3 次 → halted |
| `swarm_review` | reviewer | reviewing→passed（approve）/→dev_doing（request-changes，reviewRounds+1；≥2→halted）；finding 关闭须 fixed/wontfix+reason |

## 5. 状态机

```
queued ──claim──> dev_doing ──done(gate ok)──> test_doing ──gate_check──> test_doing
test_doing ──pass(review=false)──> passed ──auto──> 下一个 queued → dev_doing
test_doing ──pass(review=true)──> reviewing ──approve──> passed
reviewing ──request-changes──> dev_doing (reviewRounds+1；≥2 → halted，复用 R6 HALT 文案)
test_doing ──fail(<3)──> dev_doing (retries+1)
test_doing ──fail(>=3)──> halted → 人工 /swarm-retry
queued/dev_doing/gate_check/test_doing/reviewing/passed ──/swarm-halt──> halted
```

## 5.1 Reviewer-N1（单 reviewer、subagent 原生、finding 可视化）

- **finding 契约**：`findings: [{id, severity: Important|Nit|Pre-existing, file, line, rule, evidence, suggestion, status: open|fixed|wontfix, reason?}]`（存 queue patch 全量 + timeline `kind='review'` 行本轮快照 + `round` 号；`reviewRounds` 计数器默认 0）。
  关闭语义平移 `swarm_test` disposition：只有 `fixed` 或 `wontfix+reason` 能关闭，否则 `swarm_review` 拒收。
- **reviewer agent**：`.opencode/agents/swarm-reviewer.md`（`mode: subagent`，write/edit deny，bash 仅读 + `git diff/show/log`，contract：只审不改；输出 findings JSON；`Nit` 不拦、`Important` 必答）。生下来就是 subagent，不经过 session 过渡态（`/swarm-up` 仍拒绝 reviewer，与占位测试一致）。
- **REVIEW.md 约定**：`.opencode/review/<路径>.md`（就近祖先优先，无则通用口径）。`resolveReviewDoc(cwd, task)` 按 `task.paths` 逐个向上找（`src/a/b.ts.md → src/a/b.md → src/a.md → src.md`，最深优先），reviewer prompt 自动拼接命中文件，无文件返回 null。
- **深度档**：`review / quick | standard`（task 字段，默认 `quick`）：`quick` = 单遍全文件；`standard` = `quick` + 逐文件第二遍（同一 reviewer 调两次，diff 排除集不同）。Deep 档（多 reviewer 扇出）留 N2。
- **往返**：`swarm_test pass` 且 `task.review` → `test_doing→reviewing`（`by=test, reason=test-pass待审`，附 `excluded=[finding ids]` + REVIEW.md 命中提示）→ 编排会话派 `subagent(agent=swarm-reviewer, prompt=任务JSON + git show <commit> diff截断 + REVIEW.md + excluded)` → `swarm_review`（verdict 校验 + approve/request-changes 两路 + findings 存 patch/timeline `kind='review'`）。`request-changes` 沿用 test fail 回注格式（`failed_ids=Finding ids, detail=首条 Important 摘要`，dev 侧零适配）。
- **去重（N1 投票替代）**：同 `file+line+rule` 合并（`mergeFindings`，新状态覆盖旧，确定性代码），冲突（同 file+line 不同 rule）留两条；N2 再做 LLM judge。
- **Board**：`readRunSnapshot` 加 `findingsByTask`（queue findings 为底 + timeline review 行合并，timeline 为准），Board L2 加 findings 区（chip：Important 红/Nit 灰/Pre-existing 斜体 + open/关闭态 + must-answer 计数 = open Important 数），`--task` 打印 findings 全量，纯读。

所有迁移都走 `transitionTask`（FSM 表校验 + 写 timeline + 原子写）：锁内 fresh 读 + 校验期望状态 + 状态表校验 + 原子写。
`casTransition` 保留为无 timeline 无表校验的旧入口（仅旧单测兼容）。
并发 claim 只有 1 个赢家（已实测 10 并发）。

## 6. 稳定性设计（对比旧版与 peers）

| 问题 | 旧实现 | 现在 |
|---|---|---|
| 队列并发写 | read→改→write，双 dev 双花 | 目录锁 + CAS，实测 10 并发 1 赢 |
| 崩溃丢数据 | 直接 writeFile | tmp + fsync + rename 原子替换 |
| 读放大 | 每次全量解析 | mtime 缓存，写后失效 |
| 阻塞 | execFileSync 等外部二进制，卡 30s | 全异步 spawn，不阻塞事件循环 |
| verify 安全 | `sh -c` 任意执行 | 无 shell + argv 白名单 + 拒 `; | & $()` |
| 长跑/刷屏 | 无上限 | 硬超时 SIGKILL + 输出 64KB 截断 |
| 事件重复 | 无 | 确定性 `eid` 去重（同 commit 不同 detail 不得吞） |
| 发送失败 | 静默吞掉 | 通道只是本地审计（FileBus append-only）：通知可丢失，门禁不可绕过 |
| 门禁 | 可选 | 强制：真跑命令 + verdict + commit 三校验 |

## 7. 配置（opencode.json 可选）

```jsonc
{
  "plugins": [["./.opencode/plugins/swarm.js", {
    "queue": ".trellis/swarm-queue.jsonl",
    "channel": "swarm",
    "maxRetries": 3,
    "verifyTimeoutMs": 300000,
    "sweepMs": 60000,
    "allowlist": ["task"]        // 追加到默认白名单
  }]]
}
```

## 8. 已知边界（如实）

- 编排器**不再全靠人肉交接**：`autoWake`（默认开）会在派发/交接时唤醒对应角色会话，
  但「唤醒」只是发一条指令 —— 那个会话里的模型不可用、额度用尽、权限被拒，仍会停在半路，
  所以 `/swarm-status` 的会话表（model + 手上任务）要会看。
- `#tag` 依赖 `session.prompt` hook；hook 不可用的旧版本会退化为普通文本（不报错）。
- 命名只对 `round.json` 里登记过的会话生效；手动开的会话不会被改名，也不会被自动唤醒（会明确提示）。
- 通道是本地 FileBus（`.swarm/runs/<runId>/events.jsonl` append-only，无外部二进制、无 outbox）；
  sweep 的 `flushOutbox` 恒返 0（保留空实现兼容）。
- test 会话不做真机/视觉验收，只管 `verify_cmd` 能覆盖的部分。

## 9. 回归

```bash
node --test .opencode/lib/swarm.test.mjs .opencode/plugins/swarm.e2e.test.mjs
# 以实测为准（单元 + 端到端，随功能增长）
# 另：node --test .opencode/lib/swarm-board-data.test.mjs（以实测为准，含 findings 面板）
bun build .opencode/tui/swarm-board.tsx --external @opencode/plugin --external @opencode/plugin/tui --external solid-js --external '@opentui/*' --outfile /tmp/swarm-board-test.js
# tsx 有改动必跑 build（`as` 断言在 tsx 下直接挂，见 10-30-swarm-board-buildfix；'@opentui/*' 为本机缺 darwin-arm64 原生包时的补充 external）
```

- 单元：并发认领唯一赢家、沙箱拒绝 `; | & $()`、超时 SIGKILL、门禁 commit 绑定、tag 展开、事件幂等、
  **R1 testing/summary 必填**、**R2 gates 白名单开关**、**R3 baseHEAD**、**R4 revert 回放**、**R5+R6 disposition 与指标**、
  **Reviewer-N1**（FSM 三边 + enqueue 校验 + finding 关闭语义 + verdict 校验 + 去重 + 排除集 + REVIEW.md 就近 + rebuild 兼容）。
- 端到端：入队→拒发→修好→放行→fail→pass→多次失败 halt→tag 注入→FileBus 耐久，
  **模型校验**（错 provider / 错模型名 / 大小写 / 缺 provider 都不建会话）、
  **需求命名**（`#plan` / `--name` / title hook）、**派发可见性**（start 唤醒 dev、done 唤醒 test、
  无台账时如实提示）、**R1 必填**、**R2 开关**、**R3 base 竞态**、**R4 revert**、
  **R5+R6 disposition 与 HALT 摘要**、**R7 nightly 只读重跑**、
  **Reviewer-N1 全闭环**（review=false 零变直通 + approve 直过 + verdict/关闭校验拒收 + request-changes 修后过 + reviewRounds 上限 HALT）、
  **并行两轮隔离 / start 闸门 / 空入队不改名**（P0/P1，见 §10）。

## 10. 并行多轮隔离与派发授权（2026-11-02）

> 事故：同时开两个需求（两个主会话），第二个 `/swarm-up` 把全局 `.swarm/current` 指到新轮，
> 第一个主会话随后的 `#plan` / `swarm_plan` / `swarm_claim` 全落到新轮 —— 串队列、串改名、
> 空的入队调用还把新轮需求名写到了旧轮（sidebar 两轮同名）；主会话绕过 planner 自行猜需求，
> 未 `/swarm-start` 就派子代理开工；footer 永远停在 current（主会话/子代理不在 round.sessions 里）。

**不变量：**

1. **run 解析优先级**（`resolveRun`，唯一入口）：
   显式 `run` > `cfg.runId` > **任务归属（带 task_id 时）** > **会话绑定** > `.swarm/current` > `default`。
   - 会话绑定来源：`round.json` 的 `sessions`（角色会话）+ `members`（主会话 host / 子代理 / 任意调过工具的会话）。
   - `.swarm/current` 只是兜底：并行多轮时不得作为唯一依据。
2. **主会话即 planner（默认）**：`/swarm-up` 把调用者 sid 登记为 `sessions.plan` + `members[host]`，
   不再另建 plan 会话；`--plan-session new` 保留旧行为。同一会话开新轮时自动从旧轮摘除（一个会话只属一轮）。
3. **派发授权**：`/swarm-up` 写 `meta.pendingStart=true`（从未 start 过的轮）；`/swarm-start` 写
   `startedAt` 并清 `pendingStart`。`swarm_claim` / `swarm_next` 在 `pendingStart=true` 时拒收（逃生口 `force:true`）；
   已 start 的轮重跑 up 不重新上锁。
4. **命名一致性**：`round.name` 与 `meta.name` 由 `writeRoundFor` 同步双写；`swarm_plan` 只在
   **至少一条任务真的入队成功**后才改名（空入队不再污染轮名）。sidebar 以 `meta.name` 为规范名。
5. **跟随**：`sessionRunIndex` 读 `sessions` + `members`，footer / sidebar 高亮按会话命中，未命中才回退 current。

**回归锁：** `tests/swarm.test.mjs`（resolveRun 优先级、writeRound members）、
`tests/swarm.e2e.test.mjs`（「P0/P1 编排闸门」5 例：并行两轮、members 登记、start 闸门、空入队不改名、会话换轮）、
`tests/swarm-board-data.test.mjs`（members 索引、meta 名字优先）。

