---
name: swarm-quality
description: "test pass 后做轻量代码质量巡检：扫本次 diff 的重复块、超长函数、魔法数、调试残留与 TODO，按文件:行号—问题—建议输出 High/Med/Low 分级。当 test 通过后要过一遍质量、有坏味道要不要回 dev 修时加载；只报问题不拦截、不改门禁状态。"
---

# Swarm 轻量质量巡检

test pass 后走一遍的轻量质量检查：只报问题，不拦截轮次、不改门禁状态。
有 High 回 dev 修，无问题照常往下（reviewer / drained / 归档）。

## 1. 触发条件

- 任务 test pass 后，主会话加载本 skill 走一遍，再往下（review / 归档）。
- 有人说"代码质量看看 / 有没有坏味道 / 过一遍质量"时加载。

## 2. 不触发条件

- test 未 pass / 任务还在 `dev_doing`：先修先测，不做巡检。
- 要改门禁结论（pass↔fail）：那是 test / reviewer 的活，本 skill 无权改状态。
- 要直接改代码：本 skill 只读、只报告；修走 dev（回 dev 任务重修）。

## 3. 检查维度（只看本次 diff）

范围限定为本次变更（`git diff` 列出的文件）；不翻全仓，不追历史。

| 维度 | 看什么 | 典型例子 |
|---|---|---|
| 重复块 | 近似相同的代码块（复制粘贴改两行） | 三处一样的判空 + 报错拼接 |
| 超长函数 | 单函数过长 / 嵌套过深 / 参数过多 | 200 行函数、五层 if 嵌套 |
| 魔法数 | 无名数字面量 / 硬编码字符串 | `timeout 30000`、`status == 7` |
| 调试残留 | 调试打印 / 断点 / 临时注释 / TODO | `console.log`、`print`、`debugger`、`TODO/FIXME/XXX` |

## 4. 输出格式（文件:行号—问题—建议三段）

每条发现写成三段，一行一条：

```
<文件>:<行号> — <问题一句话> — <建议一句话>
```

示例：

```
internal/base/orderProvider.go:214 — 重试超时 30000 与 187 行重复 — 抽成常量放一处
internal/base/orderProvider.go:301 — console.log 调试打印残留 — 删除
```

无发现时回一句"本次 diff 无质量问题"，不凑数。

## 5. 严重度（只建议，不拦截）

- **High**：很可能埋 bug（调试残留进主干、魔法数决定分支、重复块各改各）→ 建议回 dev 修。
- **Med**：坏味道（函数偏长、命名含糊、小重复）→ 可修可留，记任务 notes。
- **Low**：顺手 polish（注释错别字、多余空行）→ 有空再说。

收尾动作：有 High → 建议回 dev（重开 dev 任务修，修完重走 test）；
无 High → 照常往下（reviewer / drained / 归档），把报告附在汇报里。

## 6. 三铁律

1. **只读不改**：不碰代码，不调 `swarm_claim` / `swarm_done` / `swarm_test` / `swarm_review` / `swarm_approve` / `swarm_halt`。
2. **只建议不拦截**：不改门禁状态，不卡轮，无权把 pass 改成 fail。
3. **只看本次 diff**：不扩大范围，不翻旧账，不重审 reviewer 的结论。
