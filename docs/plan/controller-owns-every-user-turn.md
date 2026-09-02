# Controller 拥有每一轮用户输入

候选一启动，Controller 就启动。发给候选的每一条用户消息（含第一句）和何时停止，只由 Controller 决定。Host 投递、等回合结束、执行预算；不替用户说话。

相关规范：[Controller 设计](../architecture/controller.md)、[架构总览](../architecture/overview.md)、[持久化](../architecture/persistence-and-crash-consistency.md)、[运行结果](../architecture/run-outcome.md)。触发背景：隔离副本已就绪，但 Host 仍把冻结 `initialInput` 里的历史绝对路径原样交给候选，控制器要等第一回合结束后才说话。

## 1. 判断

这个分工是对的，而且本来就是「同等人类能力」的操作定义：等价的是协作条件，不是把历史句子当脚本重放。

需要收窄的只有一句：**Controller 不管「别的」里，不包括它看不见的事实。** 它仍然只输出 `send` / `done`。下面这些永远不是它的活：

- 启动或停止 Target 进程、确认 delivery、判定 turn 已结算
- 复制/恢复工作区、阻止写穿原目录
- 对照打分、写 `report.html`
- 改冻结的 `TaskCase.initialInput`（那是考卷原文，只读）

第一句也由它写，并不等于让它发明任务。冻结 `initialInput` 仍是「原用户当时想做什么」；Controller 用当前工作区身份把它说成**这个人今天会输入的那句**。

开场不得 `done`：还没有候选回合，谈不上满意、卡住或不再有价值。开场只许 `send`。

## 2. 目标循环

```text
prepareRun（隔离副本就绪）
→ 并行：拉起 Target 进程（cwd = 副本根）+ 打开 Controller session
→ Controller.decide(opening)          // 尚无候选轨迹
→ Host：start/send(决策.message)      // 唯一的第一句用户输入
→ 每个 TurnSettlement：
      Controller.decide(steering)     // send 下一句，或 done 停止
→ Host 按 done.reason 结束 CandidateRun
```

与代码里 `runControllerLoop` 的差别：今天是 `run.start(initialInput)` 之后才 `controller.started`。本计划把「第一条用户输入」也放进同一条决策环，不再有 Host 私自投递的第 0 句。

`CandidateRun.start` 若把「拉进程」和「投第一句」绑在一起，实现上拆开：先能进入 running 并等待第一条 `send`，或 `start` 只接受 Controller 已经做出的那条 message。状态变化仍只走 `assertTransition`。

## 3. 开场决策的输入

开场的 `SteeringContext` 与后续共用同一 schema，缺的字段诚实标空，不编造回合：

| 字段 | 开场 |
|---|---|
| `task.initialInput` | 冻结原文（目标、语气、约束） |
| `task.historicalUserTurns` | 原用户后来实际说过的话（能力证据，不是脚本） |
| `current` / `trajectory` | 无候选回合：settlement 为「尚未开始」，命令/变更/正文均为空 |
| `replay` | Host 核实的路径事实：`historicalCwd`、当前副本根、`sourceRootKind` |
| `budget` | `decisionsUsed = 0` |

开场 system 约束（补进 Controller 提示词，不另做产品分支）：

- 用原用户的语言和协作习惯写**一条**任务句。
- 历史工作区路径改口到当前工作区；原用户会指着「我现在这份材料」说话，不会指着已经搬走的旧盘符。
- 不提 Reprise、隔离、恢复、对照、基线、Controller。
- 不把恢复报告、历史 Agent 后来才发现的做法、基线产物清单写进 message。
- 旁路材料（历史句里 cwd 以外的参考文件）若已在副本里，按副本内相对位置说；副本没有的外部路径保持「用户当时知道的引用」，不要假装已经拷进来。

后续回合决策次序不变：满意 / 需真人决定 / 卡住 / 纠偏 / 告知 / 核验 / 继续。Host 安全限额（墙钟、Controller 调用次数、连续重复 `send` 文本）仍由 Orchestrator 执行，不是 Controller 自己停。

## 4. 持久化

进入候选模型的第一句必须能从事件日志复原，不能只活在内存里。

最低事件：

- `controller.started` 与 Target 拉起同一准备阶段发出，先于第一条 `input.submitted`
- `controller.requested` / `controller.decision`：开场也走，`requestId` 从 1 计
- `input.submitted`：正文是 Controller 的 `send.message`，不是冻结 `initialInput` 原文
- 冻结原文仍只存在 `TaskCase`；需要对照时用 `task.initialInput`，不要把开场句写回 Case

Privacy：开场句是用户角色文本，按现有 `allowModelText` 规则进入 Controller 后续试卷和报告，与今天的 follow-up 相同。

## 5. 观察必须跟候选产品

Controller 要决定「发什么 / 停不停」，Host 摘要不能把 Claude 事件交给 Codex 翻译器。`inspectRun` 的 Pack 用 `CandidateSpec.productId`，与对照阶段一致。来源 `productId` 只解释历史会话。

这不是 Controller 的新职责，是 Host 把观察做对，否则开场之后仍会误判「零命令」。

## 6. Host 仍守的边界

Controller 即使开场改了路径，模型仍可能 `cd` 回旧盘符。写穿原目录是隔离失败，用 Runtime 根外拒绝和/或 Host 越界停跑处理，不写进 Controller prompt 当唯一防线。那是另一项工作，不在本计划把 Controller 撑成沙箱。

## 7. 实施切面

1. **循环**：`runControllerLoop` 先 `controller.started` + opening `decide`，再把 `send.message` 交给 `start`/`submit`；禁止 opening `done`（schema 或 Host 校验失败并走现有 repair）。
2. **进程**：Target 拉起与 Controller session 创建可并行；第一条用户 JSON 必须来自 opening 决策。
3. **提示词**：开场与后续共用 canonical prompt；用 `replay` + 「尚无候选回合」区分，不复制第二份 Controller。
4. **观察**：`inspectRun` 改候选 Pack；反向用例：来源 Codex、候选 Claude 的 Bash/Write 必须出现在 Controller 摘要的命令/文件计数里。
5. **测试**：opening 的 `input.submitted` ≠ `initialInput` 当历史句含 `historicalCwd`；opening `done` 不得启动候选回合；崩溃后从事件能复原第一句；TUI 时间线第一句用户气泡来自 Controller 投递。
6. **文档**：落地后改 [controller.md](../architecture/controller.md) §4.1/§5、[overview.md](../architecture/overview.md) 里「`TargetRunner.start(TaskCase.initialInput)`」、并写 `docs/decisions/accepted/`（冻结原文保留、实际开场由 Controller 写、放弃 Host 原样重放第 0 句）。

## 8. 验收

- 含历史绝对路径的任务：候选收到的第一句指向隔离副本（或「当前目录」），事件日志同时能读到冻结原文。
- Controller 失败发生在 opening：候选没有用冻结原文开跑。
- 跨产品：Controller 能看见候选工具，不只看见空指纹。
- `npm run check`；涉及提示词契约则更新 snapshot 与 ADR。
