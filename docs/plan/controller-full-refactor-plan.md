# Controller 模块全面重构计划

## 目的

本计划面向执行重构的 coding agent。只读本文、当前源码和链接的现状文档即可开始工作。目标是让 Controller 在一个连续 Session 中先理解完整历史任务，再在候选每个稳定完成的 turn 后以真实用户视角观察、按需读取详情、发送下一条自然消息或结束。

Controller 不是历史消息播放器、目标任务执行者、模型评分器或自由发挥的测试脚本。它模拟的是一个有真实目标、知识、偏好、权限和验收习惯的用户。历史会话提供目标和节奏证据；当前候选结果决定下一步回应。

## 必须保持的不变量

- 每个 CandidateRun 一个 Controller Session；不同候选不共享 Session 隐藏状态。
- 首次工作委托先读取完整用户输入并理解任务，然后才生成 opening `send`。
- 后续决策只在候选 turn 稳定 settlement 后触发；流式中间输出、运行中工具和未确认 delivery 不触发。
- 每次决策最多产生一条用户消息或一个 `done`；消息数量不固定，历史消息不是待发送队列。
- Controller 首先看到 Host 生成的用户可见视图，详细材料按需读取；隐藏推理、审计和 Host 诊断不可见。
- 用户可见授权由 Controller 代表用户回应；实际文件、网络、命令和审批权限由 Host 固定，沿用历史会话有效设置，消息不能扩大权限。
- 用户输入通过稳定索引完整可访问；历史 Agent 输出、工具过程和交付物不在启动时全部内联。
- 候选自称完成、历史消息耗尽、未读文件或轮数本身都不是结束条件。用户目标已满足且没有必要下一步时才可 `done/satisfied`。
- Controller 不直接调用 Target Runtime、不执行任务、不改原始目录、不修改 CandidateRun 状态机。
- 默认不设置 Controller 专属总预算或每轮配额；取消、真实错误、显式用户配置和 provider 重试仍按通用边界处理。
- 所有模型可见输入、用户消息、视图读取和决策都可由事件日志复原；隐藏推理不持久化。

## 现状与目标差异

| 位置 | 当前能力 | 重构目标 |
|---|---|---|
| `src/agents/controller-agent.ts` | 已有单 Session、结构化 `ControllerDecision`、opening/steering、工具和校验；system prompt 仍混有旧式固定决策说明 | 薄 system prompt；首次 decide 在同一 Session 先自由理解再结构化 opening；后续使用统一循环 prompt |
| `src/infrastructure/agent/host.ts` | `request` 主要围绕 schema 解码和修复 | 增加通用自由文本 append/工作委托，复用工具、压缩、审计、取消和错误处理；不在 Controller 复制 loop |
| `src/application/controller-briefing.ts` | 已有 `view.txt`、`permissions.txt`、历史 outline、`history/user-inputs/INDEX.tsv`、settled turn 文件 | 保持统一稳定路径；核对视图内容只包含用户可见事实，稳定边界更新，索引明确按需入口 |
| `src/application/experiment.ts` | 在 `awaiting_controller` 循环调用 `decide` 并投递消息 | 保持状态机所有权；确保 opening 理解失败不投递，settlement 后写视图再触发下一决策，done/取消/错误路径幂等 |
| `src/application/candidate-run.ts`、Runtime | 已有稳定 settlement 和状态迁移 | 不让流式事件、未确认 delivery 或 finalizing 触发 Controller |
| `src/core/schema.ts` / 事件 schema | 已有决策、请求和观察事件 | 仅按需补 schema；保留 send/done、授权和读取事实，避免新增理解账本 |

现有 accepted 决策中关于单 Session、briefing、七工具、停止条件、权限和审计的有效边界继续成立；本计划给出其合并后的实施路径。

## 目标架构与调用链

```text
准备 CandidateRun
  └─ 创建 controller-briefing（索引、用户输入、view、权限、路径）
  └─ 创建一个 Controller Session

opening decide
  ├─ append Turn 1（自由文本：读取完整用户输入，理解任务）
  └─ append opening prompt（结构化：必须 send）
  └─ Host 校验 ControllerDecision → 投递一条用户消息

候选执行
  └─ 等待 delivery accepted → Target started → turn settled
  └─ Host 写入不可变 run/turns/{n}、view.txt、THIS-TURN、INDEX

steering decide（重复）
  └─ append 循环 prompt + 当前 view 状态
  └─ Controller 先看 view，按需 read 用户可访问详情
  └─ send 一条消息 → 投递下一 turn
     或 done → 结束 CandidateRun
```

`RunOrchestrator/experiment` 拥有投递、settlement、状态迁移、权限和取消；`controller-briefing` 拥有只读材料投影；`ControllerAgent` 拥有 Session 与决策解码；`AgentSessionHost` 拥有模型/工具循环；RuntimePort 拥有候选执行。任何一层不得越权代替另一层。

## Session 与 API 重构

### 通用 Host 能力

先阅读 `AgentSessionHost.request`、底层 Pi session append、压缩回调和审计写入。补充一个通用的自由工作委托 API，语义至少包括：

- 输入 system 已建立的同一 Session、纯文本 prompt、tools、signal 和审计上下文；
- 允许模型多次调用工具并返回自然文本；
- 不要求 schema、不触发结构化 repair、不把结果解码成业务对象；
- 复用同一 append、context compact、provider retry、cancel、timeout 和 failure 分类；
- 返回 invocation 状态和可选可见文本，供日志审计但不转成业务状态。

若现有 `request<T>` 已可通过可选 schema 表达此语义，优先使用最小通用扩展；不要在 `ControllerAgent` 中直接访问 Pi 原始 session。

### ControllerAgent

保留 `ControllerDecisionSchema`、证据白名单、最大消息字节、控制字符检查、opening 禁止 done、session map、inflight 防重入、cancel/release。调整 `decide`：

1. opening：创建/取得 session；先调用自由工作委托发送 Turn 1 prompt；成功后在同一 session 发送 opening 结构化请求；任一失败都不投递候选。
2. steering：只发送循环结构化请求；动态 prompt 来自 Host 生成的路径和当前状态，不内联完整 context JSON。
3. 第四类自由文本只用于理解，不写 `understanding` 事件或账本；已有历史理解事件可只读兼容。
4. 不添加 Controller 专属预算；若请求上游显式传入 timeout，遵循通用配置，默认无 deadline 语义不能被本模块覆盖。

### Orchestrator

检查 `experiment.ts` 的 `awaiting_controller` 循环：

- opening 只在 CandidateRun `created`/准备完成边界调用；首次 decide 内部完成理解和 opening。
- send 后只等待稳定状态；delivery unknown 先核查，不能重复发送。
- settlement writer 完成后才构造 steering context 与 prompt。
- done 后通过 `assertTransition` 进入终态；不再调用 Controller。
- 失败、取消和 abort 停止后续消息并 release；不把异常转成 done。

## Briefing 与用户视图

### 目录契约

统一使用实际 attempt/run briefing 根；不按会话长短切换路径。建议入口：

```text
controller-briefing/
├── INDEX.md
├── history/user-inputs/INDEX.tsv
├── history/user-inputs/{turn-id}.txt
├── history/outline.tsv
├── history/transcript/{id}.txt
├── view.txt
├── permissions.txt
├── run/sent-user-messages.jsonl
├── run/turns/{nnnn}/visible.txt
├── run/turns/{nnnn}/event-index.tsv
├── THIS-TURN.txt
└── project/                         # 用户可访问的隔离副本，只读
```

`INDEX.md` 只做导航：说明每类文件是什么、属于历史还是候选、稳定路径和读取工具。用户输入索引按顺序列出全部 user turn、稳定 ID、正文路径、附件和关联入口。历史 Agent 内容不伪装成用户知识。

### view.txt 生产

候选 turn settlement 后由 Host 从规范化公开事件、最终回复、用户可见交付入口、可见状态和提示生成 view 快照。它应能回答“用户此刻看到什么”，而不是“Host 知道什么”。禁止写入隐藏推理、内部审计、完整工具参数、未公开诊断或未稳定内容。快照在 Controller 决策期间不改写，下一次 settlement 再写新版本；保留来源 ref 供审计。

视图可以复用 TUI/view projection 的公开事实，但不要把 TUI 文本格式变成隐式协议。确定性 writer 应区分 empty、unavailable、waiting、failed、completed，并保留用户可打开路径。媒体由 provider/通用工具负责，Controller 只能描述实际收到的媒体内容。

### permissions.txt

准备阶段从历史会话有效设置生成 Host 固定权限快照，并将相同设置交给 Candidate Environment/approval 层。Controller 可读到该事实但不能修改。用户可见授权请求写入 view；Controller 的普通消息表达批准或拒绝，Host 在实际执行前再次强制安全策略。历史设置不完整时记录差异并采用当前安全上限，绝不让 Controller 猜测扩大权限。

## Prompt 实施要求

源码中的 system、Turn 1、opening 和循环 prompt 必须以[Controller Agent 重构参考](./controller-agent-reconstruction.md)为基础重新审阅，不照搬旧版“先调查再马上交信封”或“使用完历史消息”的约束。关键语义：完整用户输入先理解；历史是目标和节奏证据而不是队列；当前 view 优先；详情按需；候选路径可不同；达到用户目标后结束。

Prompt 中不得出现：产品角色名作为自我身份、Comparison 术语、固定决策轮数、固定任务状态表、要求读取隐藏内部信息、把候选自述当完成证据、通过消息协商权限、或把当前预算文字写成执行上限。

## 事件与持久化

至少保证这些公开事实可复原：

- Controller Session 创建及 prompt/system hash；
- 每次自由理解委托和结构化决策的请求快照、顺序和结果状态；
- Host 提供的 view 快照 digest/路径及其对应 settlement；
- Controller 实际 send 消息、intent、done reason 和证据引用；
- 用户可见授权回应与最终 Host 执行结果；
- 工具读取的 run-owned evidence refs；
- 取消、失败、delivery unknown 核查和 Session release。

持久化输入、外部 JSON 和模型输出遵循 schema `Value.Check`。不要持久化隐藏推理或把自由理解文本升级成新的完成状态。任何进入候选模型的用户消息必须能从事件和 briefing 重建。

## 分阶段实施

### 阶段 0：基线与影响面

阅读本计划、[Controller 架构](../architecture/controller.md)、[实验条件](../architecture/controller-experiment-conditions.md)、`src/agents/controller-agent.ts`、`src/infrastructure/agent/host.ts`、`src/application/controller-briefing.ts`、`src/application/experiment.ts`、相关 schema 和测试。运行 `git diff`，不要覆盖其他未完成改动。列出当前 `AgentSessionHost.request` 调用方，确认自由 append 可复用范围。

### 阶段 1：统一 briefing 与用户视图

核实并补齐 user-inputs 索引、稳定路径、view snapshot 写入和权限快照。使用真实用户可见投影，确保流式内容不触发写入。补充 deterministic tests：完整用户输入顺序、快照只含公开内容、历史/候选路径隔离、权限不越权、settlement 更新 current view。

### 阶段 2：通用自由工作委托

扩展 `AgentSessionHost` 最小 API。测试同一 Session 先自由 append 再结构化 append；工具调用、压缩、取消、provider 错误和审计行为与既有 request 一致。禁止 Controller 直接复制 Pi loop。

### 阶段 3：Controller prompt 与 Agent 编排

更新 `CONTROLLER_SYSTEM_PROMPT`、opening/steering prompt 生成。实现首次 decide 的理解 append + opening decision，保持后续 decide 的稳定 settlement 循环。删除旧 prompt 中与当前设计冲突的固定顺序、内部信息可见性、过时身份和预算暗示。保留输出 schema 和安全校验。

### 阶段 4：Orchestrator 生命周期

逐条核对 opening、send、delivery、settlement、view、steering、done、cancel、failure、release。确保只有稳定边界触发；确保权限由 Host 执行；确保重复 delivery 和状态迁移幂等。必要时补最小事件字段和 schema。

### 阶段 5：真实案例验证

使用真实或明确 opt-in 的案例覆盖：分步任务、候选提前完成、候选走不同有效路径、需要授权、一个 turn 失败后可纠正、用户目标已满足、无合理下一步、历史交互长但候选短、视图含媒体或不可用媒体。检查 Controller 的消息自然、信息时序公平、结束合理。真实调用遵循 smoke gate，不因本计划自动产生费用。

### 阶段 6：文档收口

实现生效后同步当前 `architecture/controller.md`、`controller-experiment-conditions.md`、`agent-roles-and-system-prompts.md` 和相关 accepted ADR；把目标提案按仓库生命周期处理。不要把测试通过写成设计已实现，进度证据写入 MASTER。

## 测试与门禁

代码改动后先 `npm run build`，再 `npm run check`。只改文档运行 `npm run verify:docs`。测试读 `dist/`，不得直接用 `node --test` 执行 `.ts`。

最小自动化覆盖：

- Host 自由 append 与结构化 append 的同 Session 顺序；
- 首次理解失败不投递 opening；opening 只能 send；
- 后续只在 settlement 触发，流式和 delivery unknown 不触发；
- view 与 permissions 快照内容和更新时机；
- 用户输入索引完整、稳定、按序；
- send/done schema、消息大小、控制字符和证据归属；
- 授权消息不能扩大 Host 权限；
- done 不受未读文件、历史消息剩余或候选自述单独阻止；
- 取消/失败释放 Session，不发送补偿消息；
- 压缩后路径和用户目标仍可回读。

不要写固定自然语言快照来证明 Agent 判断正确；prompt snapshot 只验证关键边界词和不变量，真实案例验证交互质量。

## 完成判定

重构只有在以下条件全部满足时才算完成：

1. 代码调用链实现一个 Session、理解首轮和稳定 settlement 后循环；
2. Controller 先看用户视图、详情按需读取，权限和历史一致；
3. 四类 prompt 已按本计划生效，Agent 内部 loop 仍自由；
4. 旧冲突 prompt、账本守卫和固定轮数假设已清理，不只是新增旁路；
5. 所有持久化输入和决策可复原，取消、失败和重复投递安全；
6. `npm run build` 与 `npm run check` 有新鲜通过证据；
7. 真实案例证明 Controller 能自然推进、合理停止，并让候选经历与历史用户相近的信息时序。

## 相关文档

- [Controller Agent 重构参考](./controller-agent-reconstruction.md)
- [Controller 架构](../architecture/controller.md)
- [Controller 实验条件](../architecture/controller-experiment-conditions.md)
- [连续 Session 决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md)
- [Briefing 路径](../decisions/accepted/2026-09-03-controller-path-briefing.md)
- [停止条件](../decisions/accepted/2026-09-03-controller-stop-on-acceptance-habits.md)
- [七工具](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)
- [角色与 Prompt 入口](../architecture/agent-roles-and-system-prompts.md)
