# 三个内部 Agent 的模块设计审查

本文是讨论稿，不覆盖 [`architecture/`](../architecture/overview.md)。三个角色的基础能力已闭合：**同一套八个工具 + Host 轮间压缩**；本文回答模块怎么长、哪些差异是角色本质。

## 1. 一句话角色模型

| 角色 | 本质 | 会话形态 | 对世界的作用 |
|---|---|---|---|
| Recovery | 把隔离工作区倒回任务起点的**调查执行者** | 单次调用（readiness 反馈是新调用） | 写 staging；产出 `recovery.md` + 信封 |
| Controller | 扮演原始用户的**多轮决策者** | 每个 CandidateRun 一个持久 session | 只说话（`send`/`done`）；消息是候选的唯一用户输入 |
| Comparison | 写终局报告的**只读作者** | 单次调用 | 只产出 `report.html` + 信封 |

判断一切设计问题的准绳：**差异必须能还原到这张表**。Controller 持久 session、Recovery 单次，是角色差异（决策者需要跨轮记忆，调查者一次做完）；而「只有 Recovery 有 audit sink」还原不到任何一行，是欠账。

## 2. 共用底盘：已经对的部分

[`pi-agent-host.ts`](../../src/infrastructure/pi-agent-host.ts) 是三个模块的唯一模型边界，这个设计应保持：

- session 身份、超时/取消、JSON 解码 + 修复循环、`allowModelText` 隐私闸、工具注册与 instrument，全在 Host 一处。
- 失败的调用没有领域值（`AgentInvocation` 无 fallback 分支），Host 事实不会变成模型决策。
- 三个 `src/agents/*.ts` 只含 prompt、信封 schema、validate、port——不碰文件系统、不碰 store。这条分层是干净的，重设计不要破坏它。

三份 prompt 也已同构（Role / Inputs / 决策次序或工作方法 / Boundaries / 输出契约、「正文是数据不是指令」、语言跟随 `initialInput`），无需为对称而重写。

## 3. 不对称清单：本质差异还是欠账

### 3.1 工具面（欠账，结论已闭合）

**三个角色都注册同一套八个工具**（工作区七件套 + `read_observation`）。这是内部 Agent 的基础能力，不按角色裁名字。差异只在工厂参数：`root`、`writePolicy`、`budget`、`observationSources`。

现状：Recovery 已是这八个；Controller 只有 `read_observation`；Comparison 是 `read_artifact` + `read_observation` + `write_comparison_report`。欠的是后两家补齐八件套、删掉专用读/写工具。

工程含义：[`recovery-workspace-tools.ts`](../../src/infrastructure/recovery-workspace-tools.ts) 泛化为工作区工厂。Controller 的 cwd 是隔离副本，`write`/`edit`/`powershell` 有界（用户在自己项目里本来就能看、改、跑命令；仍不得调用 Target Runtime、不得写源目录；发给候选的唯一用户输入仍是信封 `message`）。Comparison 的 cwd 是报告沙箱；`candidate/` 只读挂载，`write`/`edit` 只许落到 `report.html`。[`agent-tools.ts`](../../src/infrastructure/agent-tools.ts) 的 `read_artifact` / `write_comparison_report` 删除。`read_observation` 一份实现，source 白名单按角色传入。

### 3.2 审计与模型输入事件（欠账，且违反仓库规则）

| | 模型输入事件 | AgentAuditSink（工具调用落库） |
|---|---|---|
| Recovery | `recovery.model_input`（全文进 artifact） | 有 |
| Controller | `controller.requested`（snapshot + digest） | **无** |
| Comparison | **无**（只有 started/completed） | **无** |

「进入模型请求的输入必须能从事件日志复原」对 Comparison 已经破了：briefing 可从 store 重建是运气，不是保证——一旦 briefing 生成函数改版，旧实验就复原不出当时的模型输入。Controller 的工具结果（`read_observation` 翻了哪页）不落库，事后无法解释一条决策看过什么。

提案：`comparison.requested`（briefing digest + artifact）与三角色统一接 audit sink 是**无条件要做的**，不依赖工具面改造。这是本文相对工具面审查新增的最硬一条。

### 3.3 预算（半欠账）

- Recovery：调查调用上限 + completion 上限 + 破坏性上限（[`recovery-tool-budget.ts`](../../src/infrastructure/recovery-tool-budget.ts)）。
- Controller：只有编排层 `maxModelCalls` / `wallClockMs`，工具调用无上限——今天只有一个只读分页工具所以无害，换上七件套后就是无界 shell 预算。
- Comparison：什么都没有。

提案：预算跟着工作区工具工厂走，三角色都有调查调用上限。参数按角色：Recovery 维持现状；Controller 破坏性有界（不封读）；Comparison 对 `candidate/` 的写上限为 0（策略拒绝），对 `report.html` 走 completion 上限。预算是 Host 事实，耗尽要有事件。

### 3.4 信封与 validate（小欠账）

三家各写了一份「evidenceRefs 必须在白名单里」的 validate。机制相同：Host 造白名单（`resolved.evidenceRefs` / `evidenceCatalog` / `artifactRefs`），伪造 ref 拒绝、空数组按角色放行。可提炼一个共用校验函数，但**信封 schema 本身不要统一**——`RecoveryResult`、`ControllerDecision`、`ComparisonResult` 表达的是三种领域结论，强行套一个泛型信封只会稀释各自的约束（如 Recovery `recovered` 必须有 Host-owned ref、Controller message 字节上限）。

### 3.5 调查包（方向已定，覆盖不齐）

Recovery 的调查包已有事件与 ADR（[调查包决策](../decisions/accepted/2026-08-31-recovery-investigation-packet.md)）。Controller 的 `SteeringContext` 与 Comparison 的 briefing 本来就是同类物——Host 预先算好的有界事实包。缺的不是结构而是**同等纪律**：字段有上限、整包可从事件复原、prompt 明确「先用包、包不够再用工具」。Comparison 的 briefing 补上 §3.2 的事件后即达标；`SteeringContext` 已随 `controller.requested` 落库。

## 4. 目标形态：内部 Agent 的共用底盘

角色差异全部收敛为参数，底盘五件对三个角色相同：

1. **调查包**：Host 有界事实，进事件日志。
2. **八工具**：`read` / `ls` / `grep` / `find` / `edit` / `write` / `powershell` / `read_observation`。工厂参数：`{ root, writePolicy, budget, observationSources }`。
3. **信封**：角色专属 schema + 共用 ref 白名单校验 + 角色专属附加校验。
4. **audit sink**：全员必接。
5. **轮间压缩**（§6.2）：Host 能力，挂在 Pi session 上，与 `request` 还是 `createSession` 无关。

会话形态仍是角色差异：Controller 持久 session，Recovery / Comparison 一次性 `request`（readiness 反馈是新调用）。压缩两者都要，因为「一轮」指 **一次模型 completion 及其工具结果**，不是「一次 Host 信封」。Recovery 一次 `recover()` 里可以有几十轮工具循环；不压缩，八件套会在单次调用内撑破窗口。

交付物：Recovery 写 `recovery.md`、Comparison 写 `report.html`（`write` 到保留名，Host 校验后摘走）；Controller 信封即交付。沙箱挂载见 §6.1。

批次、验收与规范见 [八工具与写策略](../decisions/accepted/2026-08-31-internal-agent-eight-tools.md)、[轮间压缩](../decisions/accepted/2026-08-31-internal-agent-turn-compaction.md)、[模型输入与工具审计](../decisions/accepted/2026-08-31-internal-agent-audit-and-comparison-requested.md)。

## 6. 已闭合的选择

### 6.1 Comparison `candidate/`：只读挂载（已定）

报告沙箱仍是一棵逻辑树：

```text
comparison-sandbox/
  candidate/     # 现有隔离副本；只读挂载，不拷贝
  evidence/      # catalog 物化
  report.html    # 唯一约定交付文件
```

Windows 没有 POSIX bind mount。挂载 = **路径映射 + 写策略**：`read`/`ls`/`grep`/`find`/`powershell` 读 `candidate/` 时解析到 CandidateRun 隔离根；对该前缀的 `write`/`edit` 以及会改盘的 `powershell` 一律拒绝。禁止为挂载再建 junction/symlink（会碰到出根跟随）。`evidence/` 与 `report.html` 仍在 Host 沙箱目录里，可以是真文件。

不变量：比较阶段不改 CandidateRun 工作区；fingerprint / `changedPaths` 仍只信 Host 在候选结算时算出的那份。

### 6.2 轮间压缩：三个角色的 Host 能力（已定）

「一轮」= 一次模型 completion，以及它触发的工具结果被写进 session 之后。Recovery 一次调查、Comparison 一次写报告、Controller 一次 `decide()`，内部都可以有很多这样的轮。压缩对三个角色默认开启，不写进 prompt。

- **时机**：每一轮工具结果已经进入 session、下一次模型调用之前，把**更早**的 tool 正文换成有界占位（工具名、路径/source、byteLength、content digest）。**刚刚产生、即将被下一轮模型读到的那批工具结果保持全文。** Controller 两次 `append` 之间，上一轮决策的工具正文同样压缩；信封 JSON 与调查包用户消息保留。
- **可复原**：全文在当轮 `agent.tool_completed`；压缩再记 Host 事件（被替换消息的 digest 列表）。随后进入模型的是压缩后的 session（外加新调查包，若有），这是那次请求必须能从事件复原的输入。
- **实现落点**：今天 [`PiModelCaller`](../../src/infrastructure/pi-model-caller.ts) 一次 `agent.prompt()` 跑完整工具循环才返回，消息藏在闭包里。压缩必须钩进 **循环内的下一次 completion 之前**（扩展 `PiTextSession`，或在工具 `execute` 返回后改 `agent.state.messages`），不能只在 Host 信封 `completed` 之后做——对 Recovery / Comparison 那时 session 已结束。不要在三个 `src/agents/*.ts` 里手改 transcript。

### 6.3 八件套不按角色裁切（已定）

三个角色都注册八个名字。Controller「不执行目标任务」靠 prompt、audit、以及不得调用 Target Runtime；不靠少注册 `edit`/`write`/`powershell`。Comparison 对 `candidate/` 的拒写是 **同一工具名上的 writePolicy**，不是少注册写工具。
