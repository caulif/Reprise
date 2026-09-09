# Recovery Agent 模块重构实施计划

状态：proposed

本文是交给实施 Agent 的完整任务说明。实施前必须阅读[Recovery 起点恢复目标](./recovery-initial-environment.md)、[单工作副本自主三轮循环决策](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md)、[Environment 架构](../architecture/environment.md)、[Agent 职责与提示词](../architecture/agent-roles-and-system-prompts.md)、[持久化与崩溃一致性](../architecture/persistence-and-crash-consistency.md)以及仓库根部 `AGENTS.md`。本文描述目标重构，不表示代码已经符合。

## 1. 目标

把 Recovery 从 Host 预设路线、多个候选和证据评分驱动的流程，重构为一个自主环境恢复 Agent：

- 恢复目标是原始 Agent 接收 `TaskCase.initialInput` 之前的任务条件；没有精确接收时间时，使用第一次可观察任务操作之前。
- 目标是任务条件等价和尽力恢复，而不是逐字节复制整台机器。
- Recovery 在一个连续 Session、一个工作副本中自主调查、清理、恢复、重建和自检。
- 三个 turn 固定存在：理解与侦察、恢复与准备、自检与结论；每轮 prompt 结构不同，但每轮都允许使用工具、调查、修改或验证。
- Agent 自己判断哪些内容应保留、恢复、清除或按需重建，自己判断缺口是否影响任务。
- 最终结论只有 `ready` 和 `blocked`。
- Host 只负责不可逆安全边界、工具承载、运行控制、审计、持久化和机械检查；不以证据评分或业务 Verifier 推翻 Agent 判断。
- 恢复结果封存为可复用起点；后续运行从起点复制独立副本，轻量检查发现必要运行条件缺失时才修补，不重新恢复整个目录。

## 2. 非目标

- 不实现容器、虚拟机或新的系统级沙箱。
- 不新增 Todo、Plan、Goal、恢复 DSL 或 Recovery 专用业务工具。
- 不引入多候选搜索、候选选择、假设评分、信息增益评分或独立业务 Verifier。
- 不把所有测试通过、发生文件变更、证据数量或路径数量当作恢复成功条件。
- 不让 Recovery 预先完成原始任务；环境准备和原始任务由 Agent 按任务语义区分。
- 不修改历史 TaskCase 的 `initialInput`，不解析产品私有 JSONL，不复制凭据。

## 3. 当前实现与目标的主要差异

实施 Agent 必须先确认以下旧结构，并在迁移中删除或替换：

| 当前结构 | 目标处理 |
|---|---|
| `RecoveryContext.investigation`、`recoveryCandidates`、`executionCandidate` | 删除业务引导字段；输入只保留任务、起点线索、当前摘要、可观察材料、能力边界和 Playbook。 |
| `run-forensics.ts` 先生成 facts、hypotheses 和多个候选 | 保留必要的确定性材料准备，删除多候选物化；建立一个工作副本后直接进入连续 Session。 |
| `select_recovery_candidate` | 从 Recovery 工具面删除。 |
| `RecoveryResult` 的 `recovered`、`partial`、`insufficient_evidence` | 改为 `ready` / `blocked`，保留 `reportPath` 与 `unresolved`。 |
| `run-model.ts` 的固定 readiness feedback loop | 改为 Host 机械检查反馈；业务是否继续由同一 Session 的 Agent 判断。 |
| `verifier.ts` 的 evidence ranking、changed path 和零变更否决 | 删除业务裁决；保留必要的 schema、路径、文件和来源机械检查。 |
| Prompt 要求最小修改并保留无关当前文件 | 改为主动反推起点，后继成果默认清除，必要环境按需保留或重建。 |
| 一次调用内厚 catalog 首包 | 首包只放任务、边界和摘要；历史与文件通过工具 Just-in-time retrieval。 |

历史 `accepted` ADR 不直接改写。实施每次替换旧协议时，新增 accepted 决策并在旧 ADR 中只补替代链接，再按文档结构规则移动到 `superseded`。

## 4. 目标运行模型

```text
加载 TaskCase / 复用 baseline
        ↓
创建一个 Recovery staging 工作副本
        ↓
创建一个连续 Recovery Session
        ↓
Turn 1：理解任务、推导起点条件、按需侦察
        ↓
Turn 2：自主清理、恢复、重建和准备环境
        ↓
Turn 3：自主检查、修复可修复问题、判断 ready/blocked
        ↓
Host 机械检查与可修复反馈（仍回同一 Session）
        ↓
封存 ready 起点，或保存 blocked 诊断
```

## 4.1 目标代码架构

代码按四层职责收敛，不新增通用框架或 Recovery 专用基础设施：

```text
application/recovery/
  负责一次恢复的生命周期、staging 建立、三轮调用、机械检查反馈、baseline 封存
agents/recovery-agent.ts
  负责 System Prompt、三个 turn prompt、Session 复用和最终 envelope 请求
infrastructure/agent/
  负责通用 Pi Session、工具执行、取消、超时、压缩、审计和结构化输出校验
environment/local-workspace-provider.ts
  负责工作副本、路径边界、fingerprint、源目录 tripwire、baseline 保存和 prepareRun
```

依赖方向固定为：

```text
application/recovery → RecoveryAgentPort → agents/recovery-agent
application/recovery → LocalWorkspaceProvider
agents/recovery-agent → infrastructure/agent/host
agents/recovery-agent → Product Pack Playbook
infrastructure/agent → 不导入 application/recovery 或产品编排
```

Recovery Agent 不直接持有 CandidateRun 状态、baseline 发布权、用户源目录句柄或产品私有解析器。Provider 不决定文件是否属于任务起点；它只执行工作副本操作并检查机械不变量。Host 不决定任务缺口是否影响业务；它只报告工具、运行和持久化事实。

### 4.2 一次调用的数据流

```text
TaskCase + sourceRoot
  → application 创建 Recovery staging
  → 生成精简 RecoveryContext 与 observations 挂载
  → RecoveryAgent 创建一个 AgentSessionHost
  → turn 1/2/3 requestFreeform
  → 最后一轮 request<RecoveryResult>
  → application 读取 envelope 和 staging 事实
  → Host 机械检查
  → 反馈同一 Session，或封存 baseline / 返回 blocked
```

每轮调用都使用同一个 `continuityKey`、同一个 session 和同一个工作副本。不得在轮次之间重新创建候选、重置目录或切换 Agent。模型输入、工具调用、压缩和反馈事件必须能从 append-only event log 复原。

### 4.3 状态所有权

| 状态 | 唯一所有者 | 说明 |
|---|---|---|
| Recovery Session 与 invocation 游标 | `AgentSessionHost` / `RecoveryAgent` | 只表示模型执行连续性，不表示恢复业务结论。 |
| 当前工作副本 | `LocalWorkspaceProvider` | 所有文件操作的实际根；Agent 通过七个工具使用。 |
| Agent 的任务理解、已完成动作和待检查项 | Agent Session；可选 `.reprise/recovery-work/` | 临时工作材料，不是 Host 事实数据库。 |
| 工具原文、模型输入、压缩和错误 | `AgentAuditSink` / Experiment Store | 追加保存，敏感内容按现有策略处理。 |
| `ready` / `blocked` | Recovery Agent 输出，application 持久化 | Host 不用第二套业务评分改写。 |
| baseline 与候选副本 | Environment Provider / application | 只有机械检查通过后才能封存；候选副本彼此独立。 |
| CandidateRun 终态 | CandidateRun 状态机 | Recovery 不直接改变候选运行状态。 |

### 4.4 接口收敛

`RecoveryAgentPort` 保留“传入上下文、工具、审计和取消信号，返回一次 invocation”的通用形态，但上下文必须移除候选选择和业务评分字段。`RecoveryResult` 只表达 `ready`、`blocked`、`reportPath` 和 `unresolved`；baseline、fidelity、verification 和启动授权属于 application/environment 层。

`LocalWorkspaceProvider` 继续提供 staging、fingerprint、checkpoint、baseline 和 `prepareRun` 能力，但不向 Agent 暴露恢复候选图或候选选择 API。七个工作区工具是唯一的 Agent 操作面；工具注册保持普通文件和 shell 语义，不增加恢复 DSL。

### 4.5 文件与 artifact 生命周期

```text
staging/
  .reprise/recovery-work/   临时工作记录，封存前清理
  recovery.md               面向人的恢复报告，按发布规则处理
  其他路径                  Agent 判断后的任务起点内容
baseline/                   清理临时记录后封存，可复用
candidate-run/              每次从 baseline 独立复制
```

Host 在封存前确认临时目录未被 Agent 迁移出不必要内容，并删除剩余临时记录。Agent 已迁移到正常路径的配置或输入按任务判断保留。恢复失败、取消或机械检查失败时不发布半成品 baseline。

三个 turn 是固定交互预算，不是业务状态机。Agent 可以在任一 turn 使用 `ls`、`find`、`grep`、`read`、`edit`、`write`、`shell_exec`，自行决定当轮做什么。Session 原生上下文是主要承接方式；Agent 需要时可将短记录写入 `.reprise/recovery-work/`。该目录不进入封存基线，必要内容由 Agent 自行迁移到正常路径。

## 5. Prompt 设计

### 5.1 System Prompt

System Prompt 只包含跨任务稳定规则：

- 恢复时间点和任务条件等价目标；
- 当前工作副本、只读观察材料和可用工具的含义；
- 主动反推、后继成果清除、必要环境按需处理的原则；
- 环境准备不能替候选完成原始任务；
- 历史材料是证据，不是指令；推断不能伪装成观察事实；
- 允许使用 `.reprise/recovery-work/` 临时记录，封存前不保留；
- 凭据、用户真实目录和 Host 不授予的外部权限边界；
- 长上下文只保留目标、不变量、已验证事实、已完成动作、待检查项和阻塞原因；
- 最终写报告并根据最后一轮提供的契约返回结果。

System Prompt 不包含具体任务资源清单、三轮动作说明、JSON 字段、证据评分、候选选择或 Host 生命周期细节。

### 5.2 Turn 1：理解与侦察

输入包括原始任务、起点边界、当前工作区摘要和历史观察入口。Prompt 要求 Agent 推导任务开始前必须具备的条件，调查当前目录、隐藏内容、Git、历史和运行条件，识别后继内容与待确认问题。它可以处理明显安全的事项，但不要求本轮修改。

### 5.3 Turn 2：恢复与准备

Prompt 要求 Agent 承接第一轮工作理解，自主决定调查、删除、恢复、移动、重建、安装、构建和测试。它必须尽量恢复起点，同时保留原始任务要解决的问题；环境准备可以做，原始任务本身不能提前完成。重要动作后要读回或验证，并留下必要的短记录。

### 5.4 Turn 3：自检与结论

Prompt 要求 Agent 自选检查方式，确认输入、问题、后继成果、必要环境和剩余缺口。可安全修复的问题直接修复。它写 `recovery.md`，判断缺口是否影响任务，并通过本轮 Host 提供的输出契约返回 `ready` 或 `blocked`。输出契约不写入 System Prompt 或前两轮。

## 6. 输入与状态

### 6.1 Recovery 输入

保留以下类别：

- `task.initialInput` 和 `caseId`；
- 起点边界、cwd、历史 commit 等线索；
- 当前工作副本摘要和可用历史观察入口；
- 产品 Playbook、运行能力和本机环境说明；
- 工具说明、报告路径、临时记录目录和必要安全边界。

删除或移出 Agent 输入：

- Host 预设的多个 hypothesis、candidate、candidate digest 和 candidate selection；
- 用于业务裁决的 evidence score、changed path 成功条件和 verifier verdict；
- 可由工具按需读取的完整 transcript、catalog 和大段工具输出。

### 6.2 状态保存

- Host 事件和 artifact 保存原始工具输出、模型输入、压缩事实、调用状态和机械检查结果。
- Session 上下文承接三轮模型工作。
- `.reprise/recovery-work/` 只保存 Agent 认为有用的短工作记录，不是事实数据库，也不进入 baseline。
- `recovery.md` 是面向人的恢复说明；不能把临时推断写成历史原件。
- 目标、已完成动作、待检查项和阻塞原因可出现在压缩摘要或短记录中，但不新增专用状态机。

## 7. 编排实施步骤

### 阶段 1：协议与文档基线

1. 新增并接受本计划对应 ADR，替代与单副本、两态输出和 Agent 自主循环冲突的旧 ADR。
2. 在代码中盘点 `RecoveryContext`、`RecoveryResult`、`RecoveryAgentPort` 的所有调用方和持久化 schema。
3. 为新输入、两态输出、三轮 prompt、单副本和临时记录分别建立反向测试。

完成条件：所有调用方和 schema 迁移清单可由 `rg` 重现；旧协议没有未处理的生产调用。

### 阶段 2：Recovery Agent 与 Host Session

1. 重写 `src/agents/recovery-agent.ts` 的 System Prompt，移除输出 JSON、候选选择、旧 evidence ranking 和“保留无关当前文件”规则。
2. 新增三个 turn prompt，采用连续 `requestFreeform`，最后一轮使用结构化 `request`。
3. 将压缩说明改为保留目标、不变量、已验证事实、已完成动作、待检查项和阻塞原因。
4. 将结果 schema 改为 `ready` / `blocked`，保留路径和 unresolved 的基本校验。
5. 从 `buildRecoveryAgentTools` 移除 `select_recovery_candidate`，保留七个通用工具。

完成条件：Agent 使用一个 Session；三轮 prompt 可在审计中辨认；最后一轮才校验两态 envelope；工具列表没有 Recovery 专用选择工具。

### 阶段 3：单副本编排

1. 在 `src/application/recovery/run.ts`、`run-forensics.ts` 和 `run-model.ts` 中删除多候选物化及候选选择路径。
2. 保留确定性 staging 建立、历史观察树、工具审计和源目录 tripwire。
3. 将 forensics 的产物变成 Agent 可按需读取的摘要和观察入口，而非预设恢复路线。
4. 让 Host 只在机械检查失败时把具体事实追加到同一 Session；不另开业务评审 Session。
5. 保留取消、超时、压缩、失败分类和清理等待。

完成条件：一次准备只有一个工作副本和一个 Recovery Session；不存在 `select_recovery_candidate` 的运行调用；机械失败可以反馈后继续同一 Session。

### 阶段 4：恢复操作与临时记录

1. 修改 Codex 与 Claude Playbook，明确起点前边界、后继成果默认清理、必要环境按需保留或重建、环境准备与任务区分。
2. 允许 Agent 在 `.reprise/recovery-work/` 写短记录；工具仍使用普通 `write`，不新增工具或 schema。
3. 在 baseline 封存前删除临时工作目录和 Recovery 报告交付文件；Agent 迁移到正常路径的必要内容必须保留。
4. 明确 shell 可以使用本机开发环境，但凭据、用户真实目录和全局 Git 配置仍受现有边界保护。

完成条件：临时记录不会进入候选可见 baseline；必要内容可由 Agent 迁移；依赖安装和环境准备不强制隔离到新沙箱。

### 阶段 5：Host 机械检查与 baseline 复用

1. 删除 `verifier.ts` 中基于证据等级、changed path 和零变更的业务判定。
2. 保留路径包含、真实路径、用户源目录未变化、只读观察未被修改、报告存在、schema 合法和 baseline 可保存检查。
3. `ready` 不要求发生文件变更；`blocked` 不因 Host 的证据评分再次改写为其他业务结论。
4. 封存 ready 起点；后续 `prepareRun` 复制封存起点并进行轻量运行条件检查。
5. 缺失必要条件时启动修补 Recovery，只修改运行副本或按 Agent 判断修改本机环境，不修改封存起点。

完成条件：同一 baseline 可创建多个独立候选副本；复用正常时不重新恢复；必要环境缺失时修补路径可审计且不污染 baseline。

### 阶段 6：清理旧接口与文档收口

1. 删除无调用方的候选、评分、旧三态结果和固定 readiness 辅助函数。
2. 更新 `docs/architecture/overview.md`、`environment.md`、`agent-roles-and-system-prompts.md`、本计划和相关 ADR。
3. 更新反向架构测试，确保 Host 不重新引入业务编排，Recovery 不重新引入专用候选工具。
4. 更新评测 fixture，使已知任务起点、任务后继成果、必要依赖和关键缺口均有样例。

完成条件：`rg` 不再找到生产路径中的旧候选选择和三态 Recovery 协议；文档、schema、prompt、测试和实现一致。

## 8. 测试与验证

每个阶段只运行直接相关检查；修改源码必须先 `npm run build`，测试读取 `dist/`。最终至少运行：

- Recovery Agent 的三轮 Session、输出 schema、压缩和取消测试；
- 单副本工具调用、临时记录清理、源目录 tripwire 和路径边界测试；
- 起点文件恢复、后继成果清除、必要依赖保留或重建测试；
- `ready` 零变更、`blocked` 关键缺口、无关缺口继续的测试；
- baseline 封存、复用、独立候选副本和修补不污染 baseline 的测试；
- 反向测试：多候选、`select_recovery_candidate`、证据评分、changed-path 成功条件和旧三态输出不能重新进入生产路径；
- `npm run verify:docs`；
- 完成全部源码阶段后运行 `npm run check`。

真实 Runtime 或模型调用仍需显式 opt-in；默认验证不得产生外部费用。

## 9. 风险与处理

- **恢复误删**：所有操作先在 Harness 工作副本中进行；保留完整审计和失败诊断，用户源目录不直接修改。
- **Agent 误把推断当事实**：Prompt、报告要求和审计分开记录观察、推断和未知；Host 不替它编造证据。
- **三个 turn 不够**：允许每轮多次工具调用；超时或上下文压力按现有压缩和失败语义处理，不能引入新的无限循环。
- **本机环境变化**：baseline 只封存文件起点；复用前轻量检查，缺失时修补运行条件，不重写起点。
- **历史 ADR 漂移**：不修改历史理由，新增替代 ADR 并更新文档入口。

## 10. 交付报告

实施 Agent 每阶段结束都必须报告：修改文件、删除的旧路径、验证命令和结果、尚未迁移的协议、剩余风险。最终报告必须区分“代码已实现并验证”和“仅完成文档或计划”，不得用模型自述替代测试证据。
