# Swarm 使用手册

> 三个 AI 会话（planner / dev / tester）在同一仓库里接力干活：
> planner 拆任务 → dev 实现 → tester 独立验收 → 不过打回 dev → 3 次自动熔断。
> 人只需要：**开三个会话、敲一个 tag、看进度、必要时熔断**。

---

## 0. 一页速查

| 你会用到的 | 怎么用 |
|---|---|
| 唤起 planner | `#plan 拆解 <需求>` |
| 唤起 dev | `#dev W1-T1` |
| 唤起 tester | `#test W1-T1` |
| 语义评审（review 开的任务；medium/high 默认进，low 显式开） | test pass 后自动进 `reviewing`，编排会话派 `subagent(agent=swarm-reviewer)`，reviewer 调 `swarm_review`（approve→passed / request-changes→dev_doing） |
| 一键开三个会话 | `/swarm-up --planner-model a/b --dev-model c/d --tester-model e/f --name 需求名` |
| 查可用模型 | `/swarm-models --search deepseek` |
| 看进度 | `/swarm-status`（含会话+模型+谁在跑+质量两行；`--all` 含 reviewing 列） |
| 单任务时间线 | `/swarm-status --task W1-T1`（testing/summary/disposition/failed_ids/detail + findings 全量） |
| 卡住了 | `/swarm-halt --task W1-T1` / `/swarm-retry --task W1-T1` |
| 看执行器/recipe | `/swarm-mode`（只读；切执行器走 `/swarm-start --executor sessions\|subagents\|hybrid`，默认 hybrid） |
| 判活（只读） | `/swarm-drained --run <id>`（drained/有活+任务列表，不改状态；口径与 dispatchNext 同调） |
| 导出审计（含批准） | `/swarm-eval [--run R] [--month YYYY-MM]`（只读导出 HALT/fail 打回/review/revert/**approve** 行到 `.swarm/eval/`，幂等；不改状态） |
| 说人话开工（主入口） | 直接在主会话说需求/bug/复测/进度/叫停，skill 全程代跑（§0.5）；命令是应急通道 |
| 回门禁前重做 | `/swarm-revert --task W1-T1`（仅 halted/passed，commit 回退+verdict 清空） |
 | 夜间只读重跑 | `/swarm-nightly --run R --limit 20`（顺序重跑 passed 的 verify_cmd，不改状态） |
| 清理归档 | `/swarm-clean [--run <id>] [--all-done]`（搬到 `.swarm/archive/<id>-<日期>/`，保留全部文件；current 自动善后） |
| 跑回归 | `node --test .opencode/lib/swarm.test.mjs .opencode/plugins/swarm.e2e.test.mjs` |

**核心心智模型：** 你不需要写长提示词。`#dev W1-T1` 会自动把「dev 角色契约 + 这个任务的标题/验收标准/验证命令/失败次数」注入进去。你只补一句具体要求即可。

---

## 0.5 说人话开工（主入口）

> 日常走这里，不走命令。命令（`/swarm-halt`、`/swarm-retry`、`/swarm-revert` 等）
> 是**应急通道**：skill 不在场、手动救火时才用。

在主会话直接说人话，`swarm-orchestrate` skill 全程代跑，
只在要拍板 / 出事时找你：

- "登录页背景换成深蓝渐变" → 新需求：skill 拆任务 → `swarm_plan` 批量 → **`/swarm-start`** 派发 → 按 wave 派 subagent。
- "W1-T1 挂了，再修一下" → bugfix：`swarm_read_queue` 找命中则复用，否则建单任务 → **`/swarm-start`** 派发 → dev 会话开工（带验收 + `verify_cmd` + 上次失败史）→ 修完走 `subagent(test)` → 验收通过主会话调 `/swarm-clean` 归档（人不敲命令）。
- "W1-T1 再测一遍" → 复测：派 `subagent(test)`（带 `verify_cmd` + 边界）。
- "现在啥情况" → 进度：读队列 + timeline，回一句话。
- "别跑了 / 回滚重来" → 叫停：`swarm_halt` 熔断，要重做再 `swarm_revert`。

循环 recipe（伪代码级）：

```
swarm_read_queue 看现状 → 分类意图 → plan → /swarm-start 派发 → dev会话或subagent → 轮询直到 drained 或 HALT → 验收通过主会话调 /swarm-clean 归档（人不敲命令）→ 汇报
```

完整 recipe（含 prompt 模板、模型映射、四铁律）见 skill
`.opencode/skills/swarm-orchestrate/SKILL.md`；
执行器细节与判活 fence 见 §9（附录，编排循环 recipe 原文仍在那里，
与 `/swarm-mode` 输出逐字一致，改文案先改 `swarm.js` 的 `DRAINED_RECIPE`）；
模型映射走 `swarm_config` 只读工具（`{executor, roleModels, currentRun, runId}`，
无副作用，不写队列/timeline）。
bugfix 全程不让人碰 dev 会话：复用/建单 → dev 会话 → test 子代理 → 验收通过主会话调 `/swarm-clean` 归档（整轮搬运可审计）；确认门与高风险查批口径不变（见 §9）。
test pass 后主会话加载 `swarm-quality` skill 走一遍轻量质量巡检（重复块/超长函数/魔法数/调试残留/TODO，只报 High/Med/Low 建议不拦截；有 High 回 dev 修，无问题照常往下）。

三句话记住：**接管先宣告 → 派发必带验收 + verify_cmd → 叫停即 halt 重排**。
模糊意图只追问一句（bugfix / 新需求 / 复测 / 进度 / 叫停选一），不猜着开工。

---

## 1. 准备（一次性）

### 1.1 确认插件已加载

```bash
cd /Users/apple/project/smarterlab
opencode            # 或 opencode service restart
```

在新会话里输入 `/swarm`，能补全出 `swarm-up / swarm-start / swarm-status / swarm-models / swarm-halt / swarm-retry / swarm-revert / swarm-nightly / swarm-rebuild / swarm-drained / swarm-clean` 即就绪。

### 1.2 先跑一遍回归，确认地基没坏

```bash
node --test .opencode/lib/swarm.test.mjs .opencode/plugins/swarm.e2e.test.mjs
# 期望：全绿即过（单元 + 端到端，随功能增长；数字以实测为准，不在此锁定）
```

200 项覆盖：并发认领只有一个赢家、沙箱拒绝 `; | & $()`、超时 SIGKILL、门禁 commit 绑定、tag 展开、
事件幂等、完整闭环、**模型校验（错 provider / 错模型名 / 大小写 / 缺 provider 一律在建会话前拦住）**、
**需求命名（会话标题跟着需求走）**、**派发可见性（start 会真的唤醒 dev）**、
**R1 testing/summary 必填**、**R2 gates 白名单开关**、**R3 baseHEAD 竞态**、**R4 revert 回门禁前**、
**R5 disposition 定性**、**R6 rounds-to-pass 与 HALT 摘要**、**R7 nightly 只读重跑**。

### 1.3 开三个会话并指定模型

```bash
/swarm-up \
  --planner-model opencode-go/deepseek-v4-pro \
  --dev-model       opencode-go/deepseek-v4-flash \
  --tester-model    opencode-go/qwen3.6-flash \
  --name            待办角标刷新
```

三个模型会**先校验再建会话**。默认口径是 **plan = 主会话**（`/swarm-up` 只看 dev/test 的模型，
plan 用发起命令的这个会话），所以正常只建 dev（hybrid）或 dev+test（sessions）。写错时一个会话都不会建，
并直接告诉你错在哪、正确写法是什么：

```
❌ /swarm-up 未创建任何会话 —— 模型不可用
- **dev**：provider "OpenCode" 下没有模型 "muse-spark-1.3-contributor"
  你是不是想用：`opencode-go/muse-spark-1.3-contributor`
```

> 为什么必须拦：OpenCode 的 `switchModel` 对不存在的模型会**静默成功**，
> 错误要等那个会话真正跑一步才以 `ModelUnavailableError` 冒出来 —— 看起来就是
> 「swarm-up 成功了，但没人干活」。

不知道有哪些模型就先查：

```bash
/swarm-models --search deepseek        # 按关键词过滤
/swarm-models --provider opencode-go   # 只列某个 provider
```

`--name` 之后，主会话标题就是 `需求名`，另建的 dev/test 是 `需求名 · dev` / `需求名 · test`；
不写 `--name` 也行 —— 在 planner 里敲 `#plan <需求>` 时会自动按需求改名
（多开几轮 swarm 也能一眼分清）。

不带 `--run` 时，本轮 runId 由 `--name` 派生（只留中文/英文/数字/`_`/`-`，截 40 字；
派不出名字回退 `run-MMDD-HHmm`；与已存在的非空轮重名自动加 `-2`/`-3` 后缀），
旧轮目录原封不动；新轮落盘成功后自动成为当前轮（后续不带 `--run` 的命令都看它）。

显式 `--run` 指向还有任务的旧轮会被拒收（防新会话挂到旧队列上串味），按提示
`/swarm-clean --run <旧轮>` 归档后再开，或换轮名；确认混用加 `--force` 放行。
空轮/同轮复用行为不变。

> 为什么分模型：planner 要强推理（拆得准），dev 要能写代码且便宜，tester 要严格执行、不需要创造力。

### 1.4 无参 /swarm-up：先问三件事再开轮

裸 `/swarm-up`（无 `--name`、无 `--run`）不建会话、不写盘、不读队列，只回一张开场卡。
单 `--name`（无任何模型/执行器 flag）仍回开场卡并回显已预填的需求名，但会先建空轮
（由 `--name` 派生 runId，落盘 queue 空文件 + round/meta + current 指针；零会话；
sidebar 与 footer 立刻可见，零任务态非报错，不显示红 STALE）。
显式 `--run`（无实质 flag）同理建空轮复用；指到非空旧轮时沿用现有拒收与 `--force` 口径。
`--force` 复用非空轮 / 复用已有会话登记的轮时，开场卡首行改为"轮已复用"并注明保留项（不谎报空轮）；任何复用路径都不截断已有队列与会话登记。
主会话用 question 工具问清三项（括号里是默认值，不答就按默认走）：

1. 模型：planner / dev / tester 各用什么？（默认：planner 强推理、dev 便宜量大、tester 严格；查：`/swarm-models --search <关键词>`）
2. 需求：本轮需求名（一句话）＋ 需求正文去处（prd 路径，或直接口述）。
3. 执行器：sessions | subagents | hybrid（默认 hybrid：dev常驻会话，test/reviewer走子代理；recipe 见 `/swarm-mode`）。

开场卡禁令（逐字）：本轮无需历史数据，不要调 swarm_read_queue /swarm-status /swarm-drained，直接用 question 工具问完上面三项。

拿到答案后重跑带参 `/swarm-up --run <空轮runId> --planner-model <p> --dev-model <d> --tester-model <t> --name <需求名>`
（复用本空轮，不会再派生新轮；开场卡内已给出可复制的一条），
然后回到**当前会话**（默认它就是 planner）`#plan 拆解 <需求>`；要另建 plan 会话加 `--plan-session new`。仅模型 flag（`--planner-model` / `--dev-model` / `--tester-model` / `--reviewer-model`，裸写 `<modelKey>` 亦算）或 `--executor` 算实质 flag，有任一即走老行为直接建会话；单 `--name`（无任何模型/执行器 flag）不跳卡，仍回开场卡并回显已预填的需求名（空轮已建，见上一段）。

---

## 2. 真实案例：瓶子开瓶信息补录

> 取自本仓已完成任务 `.trellis/tasks/archive/2026-10/10-20-bottle-open-info-edit/`。
> 需求：库管在「瓶子记录列表」的编辑弹窗和 Excel 批量修改里，补录**开瓶日期 / 开瓶人 / 开瓶有效期(月)**；
> 首次补录要写 `OpOpen` 流水并把 `state` 推到 2，非首次只写 `OpEdit`，`state` 不变。

### 第 ① 步：planner 拆任务（默认就是主会话）

在主会话里敲（`/swarm-up` 默认把主会话登记为 planner；旧的独立 plan 会话需 `--plan-session new`）：

```
#plan 拆解 .trellis/tasks/archive/2026-10/10-20-bottle-open-info-edit/
```

**发生了什么（你看不到但确实执行了）：**

1. 插件检测到 `#plan`，把 planner 角色契约注入提示词（只拆不写、必须给 acceptance + verify_cmd + testing、禁 shell 拼接）。
2. planner 读 prd.md，识别出三条独立战线：后端校验流水、前端弹窗展示、Excel 导入导出。
3. planner 调 `swarm_read_queue` 查重 → 调 `swarm_plan` 批量入队。

**minimal 情况下 planner 应该产出这样的队列**（这也是你该检查的东西，R1 起含 `testing`）：

```json
{"id":"W1-T1","wave":"W1","title":"后端：开瓶信息成对校验","acceptance":"只填日期或只填人、日期+人但月数空、月数不在1~120 时均返回业务错误","verify_cmd":"go test ./tests/base -run TestOpenInfoValidate","testing":"同 verify_cmd"}
{"id":"W1-T2","wave":"W1","title":"后端：首次补录写 OpOpen 并置 state=2","acceptance":"open_time 与 open_user_id 均为空且本次填了日期+人 → 写一条 OpOpen；state<2 变 2","verify_cmd":"go test ./tests/base -run TestOpenInfoFirstOps","testing":"同 verify_cmd"}
{"id":"W1-T3","wave":"W1","title":"后端：非首次与清空只写 OpEdit","acceptance":"非首次修改/清空 → 只写 OpEdit，state 不回退","verify_cmd":"go test ./tests/base -run TestOpenInfoEditOps","testing":"同 verify_cmd"}
{"id":"W2-T1","wave":"W2","title":"前端：batch-edit 加 showOpenInfo 开关","acceptance":"开关默认 false，其它调用点 DOM 零变化","verify_cmd":"node smarterlab-front/scripts/tsc-gate.mjs","testing":"tsc-gate 快轨空跑"}
{"id":"W3-T1","wave":"W3","title":"Excel：模板 14 列与导出回填","acceptance":"列序正确；导出按 open_time→expiry 反算月数可精确复现","verify_cmd":"go test ./tests/base -run TestBottleExportOpenInfo","testing":"同 verify_cmd"}
```

**planner 交付后你要做的检查（30 秒）：**

- 每个 `verify_cmd` 是否**现在就能跑**？先在终端手跑一条：`go test ./tests/base -run TestOpenInfoValidate`。如果是红的（因为功能还没写），这是**对的**——红转绿才是验收。
- 有没有任务混了多件事？`W1-T2` 若同时含"写流水"和"改 Excel"，就该拆开。
- 有没有任务的 acceptance 是"代码正确"这种无法判定的废话？有就让 planner 重写。

### 第 ② 步：启动流水线（必须显式 start）

```
/swarm-start
```

> `/swarm-up` 只开轮**不派发**；plan 入队后如果不 start，dev/test 的 `swarm_claim/swarm_next` 会被闸门拒收
> （提示「本轮已 plan 未派发」）。这是为了杜绝「没 start 就被子代理抢跑」。

输出：`已派发 W1-T1（wave=W1）→ dev` + `已唤醒 ses_xxx（dev）→ 该会话开始执行 W1-T1`。
队列里 `W1-T1` 变 `dev_doing`，通道里出现 `[TASK-ASSIGN] task=W1-T1 ... to=dev`，
**dev 会话同时被唤醒开始干活**（不会再出现「派发了但没人动」的悬空状态）。

想换需求名，可以在这一步补：`/swarm-start --name 瓶子开瓶信息补录`，
当前会话和角色会话会一起改名。

### 第 ③ 步：dev 干活（会话 B）

**`/swarm-start` 已经自动唤醒 dev 会话**（把同一份 `#dev W1-T1` 指令发给它），
所以你不需要再手动敲一遍。输出里会明确写上唤醒结果：

```
已派发 W1-T1（wave=W1）→ dev
验证命令：`go test ./tests/base -run TestOpenInfoValidate`
本轮：**瓶子开瓶信息补录**
已唤醒 ses_xxx（dev）→ 该会话开始执行 W1-T1
```

只有这几种情况才需要你手动去 dev 会话敲 `#dev W1-T1`：

- 输出写「未自动唤醒：未登记 dev 会话」→ 说明这一轮不是 `/swarm-up` 建的（手动开的会话）；
- 输出写「⚠️ 唤醒失败：…」→ 按提示的原因处理；
- 你用了 `--no-wake`；
- dev 那边已经空闲、你想让它继续修上次的失败项。

手动敲时注入的内容大致是：

```
## 角色：dev
你是 dev：只做被指派的那一个任务。
先 swarm_claim 认领；再读 acceptance 与 verify_cmd，按它实现。
实现完自己跑一遍 verify_cmd，绿了才 swarm_done（门禁会重跑一次，不过会被拒发）。

## 任务 W1-T1（wave=W1，status=dev_doing）
- 标题：后端：开瓶信息成对校验
- 验收：只填日期或只填人、日期+人但月数空、月数不在1~120 时均返回业务错误
- 验证命令：`go test ./tests/base -run TestOpenInfoValidate`
```

dev 会：`swarm_claim` → 读代码 → 写校验（`bottleRecordProvider.go` 等）→ 自己跑测试 → `swarm_done`。

**关键点：`swarm_done` 会重跑 `verify_cmd`。** 跑红就直接拒发，消息都不会发出去：

```
❌ 门禁拒绝：verify_cmd exited 1
(消息未发送，先修复再重试)
stderr: --- FAIL: TestOpenInfoValidate ...
```

这是整个系统的防线：**dev 说"做完了"不算数，命令绿了才算数。**

### 第 ④ 步：tester 独立验收（会话 C）

dev 的门禁过了之后，任务变 `test_doing`，通道出现 `[TASK-DONE] task=W1-T1 commit=abc1234`。

在 tester 会话里敲：

```
#test W1-T1
```

tester 会：

1. **不看 dev 的结论**，自己跑 `go test ./tests/base -run TestOpenInfoValidate`。
2. 顺手检查边界：日期+人但月数为空真的拦了吗？月数 121 拦了吗？（PRD 的 Validation Matrix 给了 10 种场景）
3. 出结论。

**没过的情形：**

```
swarm_test { task_id: "W1-T1", pass: false,
             failed_ids: "只填月数未拦截",
             detail: "实测 month=6 且 date/user 为空 → 返回成功；期望业务错误" }
```

结果：任务回 `dev_doing`，`retries=1`，通道出现 `[TEST-FAIL]`。

**过了的情形：**

```
swarm_test { task_id: "W1-T1", pass: true }
```

结果：`W1-T1` → `passed`，**自动派发下一个 queued 任务**（`W1-T2` → dev），通道出现 `[TEST-PASS]` + 新的 `[TASK-ASSIGN]`。

### 第 ⑤ 步：dev 修复（会话 B）

收到 `[TEST-FAIL]` 后，在 dev 会话里：

```
#dev W1-T1
```

这次注入里会多一行：`已失败 1 次，重点看上次失败项`。dev 只修 `failed_ids` 指出的那条，重跑测试，再 `swarm_done` → tester 再 `#test W1-T1`。

**这个循环最多 3 次。** 第 3 次仍不过：

```
⛔ W1-T1 连续失败 3 次 → 已 HALT，等待人工 /swarm-retry
```

整个流水线停在这个任务上，不会带着错误往下跑。这是防止两个模型互相糊弄、无限烧 token 的刹车。

### 第 ⑥ 步：人工介入（可选）

看整体：

```
/swarm-status
```

```
| task  | wave | status     | retries | assignee | commit  |
| W1-T1 | W1   | passed     | 1       | test     | ed98857 |
| W1-T2 | W1   | dev_doing  | 0       | dev      | -       |
| W1-T3 | W1   | queued     | 0       | -        | -       |
| W2-T1 | W2   | queued     | 0       | -        | -       |
```

熔断一个跑偏的任务：

```
/swarm-halt --task W1-T2 --reason 该接口已废弃，不再需要
```

修好后重新拉起（retries 归零）：

```
/swarm-retry --task W1-T2
```

### 第 ⑦ 步：收尾

全部 `passed` 后：

 1. `/swarm-status` 确认无 `dev_doing` / `test_doing` / `halted` 残留（`gate_check` 列也应为 0）。
 2. 把 PRD 的 Acceptance Criteria 勾掉（这一步仍要人做——机器只保证 `verify_cmd` 覆盖到的部分）。
 3. 等主会话的完工汇报（全绿后推一次：任务摘要+证据+待验收点；推送前提是跑过 `/swarm-start` 登记 requester）。**每轮只推一次**：自测报 bug → `/swarm-revert` 重做 → 二次收敛**不二推**（防刷屏，复查走 `/swarm-status` / `/swarm-drained`）。
 4. 归档本轮：`/swarm-clean [--run <id>]`（搬到 `.swarm/archive/<id>-<YYYYMMDD-HHmm>/`，queue/timeline/events/round/meta 全保留供审计；缺 `--run` 默认清当前轮，直接执行并回显搬运路径）。清的是当前轮时自动指到最近还有活任务的轮；一个没有则清空 current（board 灰字"暂无轮次"，footer 隐藏；run 目录缺文件才是红 STALE）。批量清已完工轮用 `/swarm-clean --all-done`（只搬无进行中任务的轮，有活的跳过并列出）。不要再 `rm -rf .swarm/runs/<runId>`（散文件口径已退役，归档才可审计）。
 5. 归档任务目录，按仓里既有流程走。

---

## 3. 角色配合时序图

```
人           planner            dev                tester
│               │                │                   │
├─#plan 需求───>│                │                   │   （自动把本轮会话改名成需求名）
│               ├─swarm_plan────>│ (队列: queued×5)   │
│<──任务清单────┤                │                   │
├─/swarm-start──┼───────────────>│ W1-T1 → dev_doing │
│               ├──唤醒(#dev)───>│ 自动开始干活       │   ← 不需要人再敲一次
│               │                ├─swarm_claim       │
│               │                ├─写代码            │
│               │                ├─跑 verify 自己绿  │
│               │                ├─swarm_done ──────>│ (门禁重跑 verify)
│               │                │                   │ W1-T1 → test_doing
│               │                ├──唤醒(#test)─────>│ 自动开始验收
│               │                │                   ├─自己跑 verify
│               │                │                   ├─查边界
│               │                │<──[TEST-FAIL]─────┤ pass=false
│               │                │ W1-T1 → dev_doing │ retries=1（自动唤醒 dev 修）
│               │                ├─只修失败项        │
│               │                ├─swarm_done ──────>│
│               │                │<──[TEST-PASS]─────┤ pass=true
│               │                │ W1-T1 → passed    │
│               │                │ W1-T2 → dev_doing │ (自动派下一单 + 唤醒)
│               │                │                   │
│  ...重复直到队列清空，或某任务 3 次失败 → [HALT] 等人...
```

> 自动唤醒由 `autoWake` 控制（默认开）。想坚持「人肉交接」就 `/swarm-start --no-wake`，
> 或在该任务的派发输出里看到「未自动唤醒」后自己敲 `#dev W1-T1`。

---

## 4. 队列行怎么写得能过门禁

`swarm_plan` 会校验六个必填字段：`id / wave / title / acceptance / verify_cmd / testing`（R1：`testing` 非空，可写"同 verify_cmd"引用式；缺失入队被拒）。`swarm_done` 要求 `summary` 必填（一句话总结改动，缺失拒收不跑门禁；经 timeline 持久化，`--task` 可见，rebuild 还原）。`swarm_test` 判 fail 时要求 `disposition` 必填（R5：枚举 `fixed=修好了 / wrong=用例错了 / intentional=预期内 / wontfix=不修`，缺失或非法拒收；与 `failed_ids/detail` 同存队列+timeline）。

写错的典型：

| 写法 | 问题 | 改法 |
|---|---|---|
| `verify_cmd: "跑一下单测"` | 不是命令 | `go test ./tests/base -run TestX` |
| `verify_cmd: "go test && echo ok"` | 含 `&&`，被沙箱拒 | 去掉拼接，只留一条命令 |
| `verify_cmd: "curl localhost:8080/health"` | 不在白名单 | 用 `node`/`go`/`pytest` 等；或配置 `allowlist` 追加 |
| `acceptance: "代码正确"` | 无法判定 | "只填日期时返回错误码 40001" |
| 一个任务含前后端两件事 | 验收会含混 | 拆成两个任务 |

**白名单默认值：** `node npm pnpm yarn bun bunx npx go cargo python3 pytest uv git make mvn gradle ./gradlew`。
需要别的（比如 `task`、`pnpm-lock`）就在 `opencode.json` 里加：

```jsonc
{
  "plugins": [["./.opencode/plugins/swarm.js", { "allowlist": ["task"] }]]
}
```

**门禁开关（R2）：** 默认跑 `verify / verdict / policy / diff / security` 五门；`lint / type / tenant` 三门默认关闭，只在 `opencode.json` 配 `gates:{lint:true,type:true,tenant:true}` 才加入（`checkGate(opts.gates)` 取交集，新注册的门也不会被误带跑）。`tenant` 经 `node .opencode/lib/swarm-tenant-check.mjs` 中转（`tenant-check.sh` 是 shell，不许加 `bash` 进 allowlist，argv 守 B3 白名单）。reason 恒带 `gate=<name>` 前缀。

**base 竞态（R3）：** `swarm_done` 进 `gate_check` 时记录 `task.baseHEAD`（当时 `main || master` 头，取不到记 `null` 并放行+warning）。门禁通过后比对：base 前进则拒绝放行（回 `dev_doing`，reason 含 `rebase 后重跑`）；`force_base:true` 可显式越过（timeline 留 `force-base` 痕）。

**回门禁前（R4）：** `/swarm-revert --task X` 仅接受 `halted/passed`，timeline 重放到最后一次进入 `gate_check` 之前（`dev_doing + commit` 回退，`verdict_path=null` 显式清空），经 FSM `passed→dev_doing` 边写回并追加 `kind='revert'` 行（`rebuild` 重放即置换，防分叉）。绕开 transitionTask 的直调迁移不被承认（状态机校验与 timeline 均不记录）。

**语义评审（Reviewer-N1）：** 入队不写 `review` 即按 `risk` 默认（`medium/high` 默认进评审，`low` 默认直通；显式传入优先：`review:false` 可关、`review:true` 可开）。可选 `reviewDepth: quick|standard`（默认 `quick`；`reviewRounds` 计数器默认 0，前端不用填）。评审中的任务 `test pass` 后不直通 `passed`，而进 `reviewing` 待审（输出含 `excluded=[finding ids]` + REVIEW.md 命中提示），编排会话派 `subagent(agent=swarm-reviewer)`，reviewer 调 `swarm_review {task_id, findings, verdict}` 出结论：`approve→passed`（+自动派下一单）/`request-changes→dev_doing`（`failed_ids=Finding ids, detail=首条 Important 摘要`，dev 侧零适配；`reviewRounds+1`，≥2 自动 HALT 并复用 R6 HALT 文案）。显式 `review=false` 的任务直通 `passed`（老链路零变）。

---

## 4.1 Reviewer（一节：契约 / REVIEW.md / 深度档 / 与 test 分工）

**finding 契约**（PRD §1，存 queue patch 全量 + timeline `kind='review'` 行本轮快照 + `round` 号）：

```json
findings: [{id, severity: Important|Nit|Pre-existing, file, line, rule, evidence, suggestion, status: open|fixed|wontfix, reason?}]
```

- `severity`：`Important`（必答，拦 `approve`）/`Nit`（不拦，顺手修）/`Pre-existing`（存量免责，须注明）。
- `status`：`open`（待修）/`fixed`（已修）/`wontfix`（不修，**必须写 reason**，否则 `swarm_review` 拒收）。
- 举证格式：`文件+行+复现`（`evidence` 写实测/代码行，`suggestion` 写最小修法）。
- 去重（N1 投票替代）：同 `file+line+rule` 合并（确定性代码），冲突（同 file+line 不同 rule）留两条；N2 再做 LLM judge。

**verdict 规则**（`swarm_review` 强制）：`request-changes` 必须含 ≥1 条 `open Important`（空 Important 不得打回）；`approve` 不得含 `open Important`（只允许 `Nit`/`Pre-existing` open）。`Nit` 不拦：只有 `Nit` 时应 `approve`。

**REVIEW.md 约定**：`.opencode/review/<路径>.md`（就近祖先优先，无则回 `_default.md` 通用口径）。如 `paths=['src/a/b.ts']` 依次试 `src/a/b.ts.md → src/a/b.md → src/a.md → src.md → _default.md`，命中最近祖先（末端兜底通用口径）。reviewer prompt 自动拼接命中文件内容；`resolveReviewDoc` 无文件且 `_default.md` 缺失才回 `null`（单测锁嵌套命中最近、兜底命中、无文件回 null）。

**深度档**（task 字段，默认 `quick`）：`quick` = 单遍全文件；`standard` = `quick` + 逐文件第二遍（同一 reviewer 调两次，第二次 prompt 含不同排除集）。Deep 档（多 reviewer 扇出 + 投票）留 N2。

**与 test 分工**：test 管"跑没跑过"（`verify_cmd` 真跑 + verdict/commit 绑定，不过即 `fail`）；reviewer 管"写得对不对"（语义复核，只审不改，不跑命令）。评审中的任务必须两关都过才 `passed`；显式 `review=false`（或 `low` 默认直通）只过 test 即可。reviewer 是 subagent（`mode: subagent`，`write/edit deny`），不占会话（`/swarm-up` 仍拒绝 reviewer），由编排会话在 `test pass` 后派发；第二轮 prompt 含 `excluded`（已贴 findings 全列），输出不得与之相交（单测锁收敛"不重复贴"）。

**Board**：`swarm-board` L2 新增 findings 区（按任务渲染 chip：Important 红/Nit 灰/Pre-existing 斜体 + open/关闭态 + must-answer 计数 = open Important 数；数据走 timeline（含 `kind='review'`）+ queue patch 合并，timeline 为准，纯读）。`swarm-status --task` 打印 findings 全量；`--all`/`swarm-runs` 含 `reviewing` 列；`dispatchNext` 的"有活"判定为三态 `dev_doing/test_doing/reviewing`（唯一真相见 `swarm.js` 的 `liveTasks`，`/swarm-drained` 同调；`review=false` 时永无 reviewing，老行为不变）。

---

## 5. 常见问题

**Q：`/swarm-up` 说模型不对，可我明明写了模型名？**
现在是**建会话前就校验**，会告诉你错在 provider 还是模型名，并给出「你是不是想用」的确切写法：

```
- **dev**：provider "OpenCode" 下没有模型 "muse-spark-1.3-contributor"
  你是不是想用：`opencode-go/muse-spark-1.3-contributor`
```

（这俩错误长得很像：provider 大小写、少个 `-go`、模型名拼错。以前这些都只会在会话里变成一句
`ModelUnavailable`，看起来像「swarm-up 成功了但没人干活」。）
拿不准就先 `/swarm-models --search <关键词>`。

**Q：派发之后怎么知道那边是不是真在跑？**
`/swarm-start` 会直接唤醒 dev，并在输出里写「已唤醒 ses_xxx（dev）→ 该会话开始执行 W1-T1」。
想随时复查用 `/swarm-status`，它现在有一张会话表：role / session / title / model / 手上任务，
模型不可用会当场标 ⚠️。

**Q：会话名怎么都被改成一个样了？**
这正是设计意图：`--name` 或 `#plan <需求>` 之后，本轮会话标题固定为
`需求名`、`需求名 · dev`、`需求名 · test`，多轮 swarm 并排也能分清。
改名记录在 `.swarm/runs/<runId>/round.json`（按 run 隔离，`--all` 可看全部轮），插件还会拦掉 OpenCode 的自动标题，避免被覆盖成
「解决 xxx 问题」这种猜出来的名字。

**Q：多需求并行会串队列吗（run 隔离）？**
不会。队列/台账/事件/时间线按 `.swarm/runs/<runId>/` 切分（`queue.jsonl / round.json / events.jsonl / timeline.jsonl / meta.json`），唯一解析入口是 `lib/swarm-run.js` 的 `resolveRun`：显式 `--run` > 插件 `options.runId` > `.swarm/current` 指针 > `default`。不传 `--run` 的老调用走 current 指针，行为不变。`--all` 看全部轮，`/swarm-switch --run` 切换当前轮，`/swarm-migrate` 把旧全局队列一次性拷入某轮。

**Q：`gate_check` 是什么状态？**
`dev_doing → gate_check → test_doing` 的门禁中间态：`swarm_done` 先从 `dev_doing` 进入 `gate_check`（记录 `baseHEAD`），真跑 `verify_cmd` + 校验 `verdict/commit` + 政策禁区，过了才进 `test_doing` 并唤醒 test。门禁拒绝则打回 `dev_doing`（`retries` 不变，timeline 留 `gate-reject` 行，通道发 `[GATE-REJECT]`）。`test_doing` 之前必经 `gate_check`，`status` 表里看到 `gate` 列即有人卡在门禁里。

**Q：`swarm-status` 的质量两行是什么意思？**
`rounds-to-pass 均值`：本 run 已 passed 任务的 `(to=dev_doing timeline 计数+1)` 均值。定义：每个 passed 任务统计其 timeline 行中 `to==='dev_doing'` 的次数（含初次派发、test fail 打回、`gate_check→dev_doing` 打回——含门禁打回，均计入），再 +1；对全部 passed 取均值。`disposition 分布`：当前队列任务按 `fixed / wrong / intentional / wontfix` 的计数（非法值忽略）。无 passed 时显示"（暂无 passed）"。

**Q：fail 为什么非要写 `disposition`？HALT 了怎么办？**
`swarm_test pass:false` 必须带 `disposition`（`fixed / wrong / intentional / wontfix`），缺失或非法直接拒收（状态不动）。它与 `failed_ids/detail` 同存队列+timeline（`detail` 存全量，事件截 500，`--task` 可见，rebuild 还原）。连续失败达 `maxRetries`（默认 3）即 HALT：输出含"建议重审方案而非继续修" + 最近三轮 `detail` 摘要（timeline `patch.detail` 取，500 截断；无则 `(无记录)`，不崩）。HALT 后用 `/swarm-revert --task X` 回门禁前重做，或 `/swarm-retry` 归零重派。

**Q：高风险任务谁来放行？**
`status` 待批行点名的任务（risk=high 且无 approve），在主会话说一句"我看了 W1-T1，可以放行"——编排 skill 会调 `swarm_approve` 写 `kind='approve'` 审计行（by+sessionID 留痕，幂等，重复批不写行），派发自动解锁，任务状态不动。`swarm_claim` 不查批（软卡可绕过，靠审计威慑），所以派 subagent 前先看待批行，无批不派（§9 recipe 同款要求）。

**Q：`/swarm-nightly` 会改状态吗？**
不会，只读。顺序重跑该 run 全部 `passed` 任务的 `verify_cmd`（复用 `runVerify`，超时走配置），跑红也不改 `passed`，不调任何 `transition`。不建任务、不 at 人；cron 下一轮再议。只发一条汇总事件 `[NIGHTLY-GREEN]`（全绿）或 `[NIGHTLY-RED]`（有红，含失败 id），FileBus+timeline 双写，`status` 尾可见即算可见。长队列用 `--limit N`（默认 20，超出列清单不跑）。

**Q：policy 禁区到底拦什么（A1 口径）？**
声明 `paths` 时严格判定：命中 `tools/review/** / .opencode/** / opencode.json` 或自定义 `policyDeny` 即拒（`gate=policy`，`policy_exception:true` 显式放行）。未声明 `paths` 时看 git 工作区补充信号：其中 `.opencode/**` 命中降级为 warning 放行（reason 带 `gate=policy:warning`），其余禁区仍拒。未知 `paths` 与坏仓永不抛错。

**Q：dev 一直说"做完了"但门禁老是拒？**
让它先自己跑那条 `verify_cmd`。门禁跑的就是同一条命令，自己绿的才会放行。若命令本身写错了（比如测试名不存在），回 planner 改任务。

**Q：tester 太松，红了也放行？**
`swarm_test` 只认它自己调用的结果，但**它有没有真跑**取决于 agent 的自觉。所以 tester agent 的 `write/edit` 已设为 deny，且契约里写明"不看 dev 结论"。发现放水就在 `#test` 后面补一句「必须贴出 verify 的原始输出末 20 行」。

**Q：两个 dev 会话抢同一个任务？**
不会。`swarm_claim` 走 CAS + 目录锁，实测 10 并发只有 1 个赢家，其余收到「认领失败：already dev_doing」。

**Q：通道里的消息会不会丢？**
通道是本地 FileBus（`.swarm/runs/<runId>/events.jsonl` append-only，无外部二进制、无 outbox）：`send` 走目录锁取尾 `seq`（20 并发不重号不跳号），确定性 `eid` 去重（`TEST-FAIL / GATE-REJECT` 另纳 `failed/detail` 摘要，`TASK-ASSIGN` 另纳 `retry/wave` 摘要，同 commit 不同 detail 不得吞），坏行跳过，`tail` 读末 N 条（新位空回退旧位），`sweep` 的 `flushOutbox` 恒返 0（保留空实现兼容）。队列和门禁不依赖通道——通道挂了只影响"通知"，不影响"能不能往下走"（不变量 P2：通知可丢失，门禁不可绕过）。

**Q：能不能不要通道？**
可以，FileBus 只是本地审计日志。队列（`queue.jsonl`）和门禁（真跑命令）都不依赖通道；`nightly` 汇总事件在 `status` 尾可见即算送达。

**Q：任务粒度多大合适？**
一个任务应该能在数分钟内由 `verify_cmd` 判定完。超过 10 分钟的任务要拆。

---

## 6. 目录与文件

```
.opencode/
├─ lib/
│  ├─ swarm-store.js       队列存储（原子写/锁/CAS/缓存/timeline 双写；review/reviewDepth/reviewRounds 校验）
│  ├─ swarm-exec.js        verify_cmd 沙箱（无 shell / 白名单 / 异步 / 硬超时 / 截断）
│  ├─ swarm-filebus.js     通道（FileBus 本地 events.jsonl，幂等 eid / tail / 无 outbox）
│  ├─ swarm-events.js      旧通道薄适配（委托 FileBus，兼容保留）
│  ├─ swarm-fsm.js         状态机唯一真相（TRANSITIONS 表 + reviewing 三边，非法恒含 allowed:）
│  ├─ swarm-run.js         Run 隔离 + timeline 重放（resolveRun / rebuild / revert 回放点 / rounds-to-pass + finding 契约/merge/排除集/resolveReviewDoc）
│  ├─ swarm-gate.js        门禁管道（verify/verdict/policy/diff/security + lint/type/tenant 开关）
│  ├─ swarm-tenant-check.mjs tenant 门禁的 node 包装器（argv 白名单，不经 bash）
│  ├─ swarm-roles.js       角色表 + tag 展开（reviewer 仍占位：subagent 不经会话）
│  ├─ swarm-sessions.js    模型校验 + 需求命名 + 轮次台账
│  ├─ swarm.test.mjs       单元回归（127 项，含 Reviewer-N1 11 项）
│  ├─ swarm-board-data.mjs TUI 纯数据层（+ findingsByTask，timeline 为准）
│  └─ swarm-*.js
├─ plugins/
│  ├─ swarm.js             插件本体（15 命令/7 工具/hook，nightly 只读重跑 + swarm_review + swarm-drained 只读判活）
│  ├─ swarm.e2e.test.mjs   端到端回归（111 项，含 Reviewer-N1 全闭环 5 项 + drained 只读判活 7 项）
│  └─ swarm-SPEC.md        设计说明
├─ review/                REVIEW.md 约定目录（.opencode/review/<路径>.md，就近祖先优先；_default.md 通用兜底）
└─ agents/
   ├─ swarm-plan.md        planner agent
   ├─ swarm-dev.md         dev agent
   ├─ swarm-test.md        tester agent
   └─ swarm-reviewer.md    reviewer agent（mode:subagent，只审不改）
```

运行时产物（按 run 隔离，旧 `.trellis/swarm-queue.jsonl` 只作显式 `--queue` 兼容通道）：

```
.swarm/runs/<runId>/queue.jsonl        队列（事实源，按轮切分；review/reviewDepth/reviewRounds/findings 随 patch 持久化）
.swarm/runs/<runId>/timeline.jsonl     事件溯源（create/move/revert/nightly/review，rebuild 只重放 create/move/revert，review 行纯审计）
.swarm/runs/<runId>/events.jsonl       FileBus 通道（status 尾即读它，无 outbox；含 [REVIEW-APPROVE]/[REVIEW-CHANGES]/[TEST-PASS review:pending]）
.swarm/runs/<runId>/round.json         本轮需求名 + 三个角色会话 id（改名/唤醒/status 用）
.swarm/runs/<runId>/meta.json          轮元信息（name/createdAt/executor/roleModels）
.swarm/current                         当前轮指针（不带 --run 的命令都看它）
.swarm/runs/<runId>/queue.jsonl.lockd/ 瞬时锁目录（正常应不存在）
```

---

## 7. 边界（如实说明）

- **不做真机/视觉验收**。`verify_cmd` 能覆盖的它管，界面好不好看、Android 手感如何，仍要人。
- **planner 的拆解质量决定上限**。任务拆错，后面两个角色再努力也是白跑——所以第 ① 步花 30 秒检查是值得的。
- **自动唤醒是「发一条指令」，不是「保证跑完」**。会话那边的模型/权限/额度问题仍可能让它停在半路，
  所以 `/swarm-status` 的会话表要会用。
- **命名只对登记过的会话生效**。手动开的会话不在 `.swarm/runs/<runId>/round.json` 里，`/swarm-status` 会写「未登记」，
  唤醒也会跳过（提示「未自动唤醒」）。
- **tag 依赖 `session.prompt` hook**。旧版本没有该 hook 时，`#dev` 会当普通文本处理（不报错，但也不注入）。
- **单机单仓串行**。同一时刻只有一个 dev 任务在跑，不做并行分支合并。
- **HALT 不是终点**。连续失败即熔断并建议重审方案；用 `/swarm-revert` 回门禁前（`halted/passed` 可回）比硬修更省 token。
- **`nightly` 只读不改状态**。跑红也不动 `passed`，只发汇总事件；`--limit` 外的任务列清单不跑。

---

## 8. TUI 大屏（swarm-board，只读）

TUI 内一目了然：各会话实时状态 + 任务流向 + 健康结论，键盘可跳入任意会话。纯读——不调任何
swarm_* tool，不写队列/timeline，动作指回命令（板上文案只写命令名）。

- **打开**：`/swarm-board`（slash 命令，随 app 常驻注册，随处可用）。
- **三处**：sidebar 窄卡（run 名 + 新鲜度 `Xs前`/断源 `STALE` + funnel 一行 + rounds-to-pass + 异常行，
  有事才渲染异常行；多轮并存时追加进行中轮列表，每轮一行名 + 迷你 funnel + 状态灯，`▶` 标出当前会话所在轮且只加标记不重排，已完成轮折为一行灰字，单轮无多余行）→ 整页 board（会话表 + funnel + 任务明细 + 健康判据 + 事件尾 8 条）→
  footer 状态行（跟随所在会话，只渲染该会话所属轮的 funnel，未登记会话回退当前轮，`swarm <run>: D<n> G<n> ✓<n>` 单轮文案不变）。
- **按键**（仅 board 页内生效，板外按键放行）：`j/k` 移动，`Enter` 跳会话
  （会话行→`tabs.focus`，不在则建；任务行→其 assignee 会话；tab 禁用时回退到路由导航），
  `Backspace` 回进入前会话（无记录则回 home），`1/2/3` 切会话/任务/明细区，`w` 循环切波次，`?` 弹按键帮助。
- **数据**：2s 轮询 + mtime 指纹（`.swarm/runs/<run>` 下 queue/timeline/events/round/meta 最大 mtime，
  无变化不刷新）；路径以项目根为基准（`data.location.default().directory`，不用 cwd）。
- **已知缺口**：`Enter` 跳会话与 `Backspace` 返回尚未进 TUI 真机实测（headless `node --test` 只覆盖数据层；
  数据层单测 16 项全绿，`bun build` tsx 通过）。进 TUI 后若跳转不符合预期，按 §7 口径人肉验证、
  回本节补一句。

---

## 9. 子代理编排 recipe（附录；slash 为应急通道）

> 主入口见 §0.5（说人话开工）。本节是 recipe 附录 + 应急命令说明：
> 日常编排走 skill + `swarm_*` tool 循环；下面各 `/swarm-*` 命令只在手动救火时用。

> 默认 `hybrid`（dev/plan 走 sessions 常驻会话唤醒，test/reviewer 走 subagents 一次性派发）；显式 `--executor sessions|subagents` 整轮行为零变（老行为保留）；roleModels 落 meta 供派发时读模型。

### 9.1 开一轮混合 run（默认 hybrid）

```bash
/swarm-start --executor hybrid --dev-model opencode-go/deepseek-v4-flash --tester-model opencode-go/muse-spark-1.3-contributor --reviewer-model opencode-go/deepseek-v4-flash
```

- `--executor` 只接受 `sessions|subagents|hybrid`，写 run `meta.json`（`{executor, roleModels:{dev,test,reviewer}}`）；删掉该字段即回默认（hybrid）。显式 `--executor sessions|subagents` 整轮行为零变。
- `wakeRole` 按角色拆分：hybrid 下 dev/plan 走会话唤醒（常驻），test/reviewer 直接 skipped（编排会话自己派 subagent，不经过 role 会话）；`nameRound`/title hook 保持兼容（无登记会话时只改当前会话）。
- `/swarm-mode` 只读打印当前 run 的执行器 + 角色模型 + 本节 recipe（设置走 start 的显式 flag，不在此命令写）。
- `/swarm-up` 默认 hybrid 只建 plan+dev 会话（test/reviewer 不建会话，走子代理）；显式 `--executor sessions` 建三个会话（老行为），显式 `--executor subagents` 仅建 plan（老行为）。board 会话区 hybrid 仅展示 dev/plan（test/reviewer 本无会话，不占区）。

### 9.2 编排循环 recipe（主会话执行，与 /swarm-mode 输出逐字一致）

> 下面的 fence 块与 `/swarm-mode` 输出逐字一致（e2e 锁死）：改判活文案先改 `swarm.js` 的
> `DRAINED_RECIPE` 常量，两边同改。判活三态 = `dev_doing/test_doing/reviewing` 任一非空即有活，
> 唯一真相是 `swarm.js` 的 `liveTasks`（`dispatchNext` 与 `/swarm-drained` 同调）。

```
/swarm-status 确认 run → #plan 入队 → /swarm-start（默认 hybrid：dev常驻会话，test/reviewer走子代理）
loop:
  /swarm-drained --run <id>（只读：drained/有活+任务列表，不改状态）
  有活 → dev会话直接开工（wake已投递）+ subagent(agent=swarm-test|swarm-reviewer, model=roleModels.*, prompt=expandTag体+任务JSON+补充要求)
  子代理自己调 swarm_claim/swarm_done/swarm_test/swarm_review（tools 对任何会话开放）
  队列空 + 无 dev/test_doing/reviewing → 结束（判活口径见 /swarm-drained，与 dispatchNext 同调）
```

dev 常驻会话直接开工（wake已投递；任务已是 dev_doing 且归自己时跳过 claim 直接开工，claim 返回"可继续"时同样直接开工）。test/reviewer 子代理流程不变。
high-risk 任务派 subagent 前先查 approve 行（swarm_read_queue 看 timeline 或 status 待批行），无批不派。

确认门（两道，缺一不可，不代跑）：门一，开轮（空轮/新轮、队列为空）后先问用户「是否开始 planner？（#plan 输入具体需求/探索，分解成任务）」，得到确认才拆解；门二，`swarm_plan` 入队后一律输出任务映射表（任务 id/标题/risk/verify_cmd 一览），再问用户「是否 /swarm-start 派发？」，得到确认才派发；大小活一视同仁，原来“≤3 直接派”作废。

review 开的任务（medium/high 默认进评审，low 默认直通，显式 review 优先）test pass 后派 reviewer subagent（agent=swarm-reviewer）；standard 分两轮：第二轮 prompt 附第一轮 findings 全列为 excluded；N1 去重：同 file+line+rule 合并一句（冲突留两条）。

质量巡检（非门禁，只建议不拦截）：时序点死为 **test pass 后立刻、先于 reviewer**，主会话加载 `swarm-quality` skill 走一遍（重复块/超长函数/魔法数/调试残留/TODO，输出文件:行号—问题—建议，High/Med/Low 分级）；有 High 回 dev 修，修完重走 test，再进 reviewer；无 High 照常往下进 reviewer。完整链路固定为 `test → quality → (High 回 dev → 重走 test) → reviewer → drained`，质量巡检不改变门禁状态、不替代 reviewer。

prompt 模板：dev 常驻会话走 wake 注入体（`expandTag({role:"dev",taskId})` 全文 + 任务 JSON + 补充要求，**必须含上次 fail 的 `detail/failed_ids`**，时间线已现成，直接复用）；test 用 `expandTag({role:"test",taskId})` 全文 + 任务 JSON；reviewer 用任务 JSON + `git show <commit>` diff（截断 50KB）+ REVIEW.md 命中（含 `_default.md` 兜底）+ `excluded=[finding ids]`（评审中的任务 test pass 后派）。

模型映射：dev 常驻会话用 `roleModels.dev`（建会话时写入），test subagent 用 `roleModels.test`，reviewer subagent 用 `roleModels.reviewer`；subagent 无配置模型则继承父会话模型（官方语义）。gate/FSM/门禁/timeline 全部沿用，与执行器无关。

### 9.3 对比记录表（对比跑完填任务 notes）

| 指标 | sessions run | subagents run |
|---|---|---|
| 授权弹框次数（人工数） | | |
| rounds-to-pass（status 现成） | | |
| 父会话消息数（上下文膨胀代理指标） | | |
| 耗时 | | |

### 9.4 清理归档（/swarm-clean）

```bash
/swarm-clean --run <id>   # 归档指定轮（整目录搬到 .swarm/archive/<id>-<YYYYMMDD-HHmm>/，全部文件保留）
/swarm-clean              # 缺 --run 默认清当前轮（人敲即执行，回显搬运路径，无二次确认）
/swarm-clean --all-done   # 只搬无进行中任务的轮（queued/dev_doing/test_doing/reviewing 任一非空即有活，跳过并列出）
```

- current 善后：清的是当前轮 → 自动指到最近还有活任务的轮；一个没有 → 清空 `.swarm/current` 文件。board 侧区分"无 current"（灰字"暂无轮次（/swarm-up 开新轮）"，footer 隐藏）与"run 目录缺文件"（红 STALE 不变，真断源）。
- 判活口径与 `/swarm-drained` 同调（`swarm.js` 的 `liveTasks` 三态 + queued）。
- bugfix 闭环：test pass（drained）后主会话直接执行 `/swarm-clean`（人不敲命令），整轮搬运保留 queue/timeline/events/round/meta 供审计；确认门与高风险查批口径不变（见上 recipe fence 外两行）。
