# 同等人类能力与 Controller 设计

本文约束当前实现。未关闭验收见 [MASTER](../progress/MASTER.md)。

状态：当前模块设计

本文完整定义产品无关的同等人类能力模块：它如何读取规范化历史任务、理解 Target Runner 的输入边界、构造观察、调用 Pi Agent、生成下一条用户消息并留下证据。公共领域类型、七状态模型和端口所有权以[架构总览](./overview.md)为准；本文只细化 Controller 所需的视图和交互协议。Controller 的实验级配置、工具、完整会话可见性、预算与压缩细节见[Controller 实验条件](./controller-experiment-conditions.md)。

## 1. 模块目标

Controller 回答一个问题：

> 面对候选 Agent 当前已经产生的轨迹，一个与原用户能力、目标和约束相当的人，接下来最合理会输入什么？

它不重放原用户的固定文本，不替 Target Agent 做任务，也不裁判模型分数。它只在 Target 到达稳定输入边界后返回一条普通用户消息，或说明为什么应结束。

```text
原始 TaskCase
+ Host 用户视图快照（current-user-view.md）
+ 用户可访问材料（按需）
+ 已发送的用户消息
+ Host 固定权限
          ↓
      Controller
          ↓
 send(message) | done(reason)
```

## 2. 模块边界

```mermaid
flowchart LR
    CASE[TaskCase View] --> ASSEMBLER[Observation Assembler]
    EVENTS[Target Events] --> ADAPTERS[Observation Adapters]
    ARTIFACTS[Artifacts] --> ADAPTERS
    ENV[Environment Observation] --> ADAPTERS
    ADAPTERS --> ASSEMBLER
    HISTORY[Prior Decisions] --> ASSEMBLER
    ASSEMBLER --> CONTEXT[SteeringContext]
    CONTEXT --> CTRL[Pi Controller Session]
    CTRL --> DECISION[ControllerDecision]
    DECISION --> ORCH[RunOrchestrator]
```

Controller 模块负责：

- 从 `TaskCase` 构造用户能力和历史任务视图；
- 接收 Runtime/Environment 已采集的事实；
- 通过 Observation Adapter 整理 Controller 可理解的观察；
- 管理本 CandidateRun 的 Controller session；
- 调用 Pi Agent Host 并验证结构化输出；
- 返回 `ControllerDecision`；
- 为每次决策生成可追溯事件和上下文引用。

Controller 模块不依赖具体 Product Pack。ProductHistoryReader 和 ProductRuntime 先把产品私有数据转换成 `ImportedSession`、`TargetEvent`、`TurnSettlement` 与 artifact 引用；随后由本模块的 Observation Assembler 统一构造 `SteeringContext`。这样 Codex、Claude Code 或其他产品不会获得不同的 Controller 上下文规则。

Controller 模块不负责：

- 发现、安装或解析 Agent Runtime；
- 读取或解释产品私有 session、JSONL、hook 或 CLI 输出；
- 判断进程是否真正 accepted、started 或 settled；
- 恢复、复制、修改或清理任务环境；
- 调用 Target Agent 的工具；
- 生成公共质量分或覆盖原始 trace；
- 代替真实用户授权高影响操作。

## 3. “同等人类能力”的操作定义

等价的是能力条件，不是消息文本。对一个 `TaskCase` 的不同 CandidateRun，固定：

- 原始用户已经表达的目标、事实、偏好和约束；
- 用户在原会话中表现出的协作能力和验收习惯；
- 用户正常能够看到的任务环境与产物；
- Controller 的模型、system prompt、工具能力和配置；
- 安全边界与默认运行预算。

Controller 模型由用户从自己通过 Pi 可用的 provider 与模型中选择。Harness 不指定、捆绑、推荐或评价某个 Controller 模型。该配置属于 `ExperimentSpec`，在首个候选运行前解析一次；每个 CandidateRun 创建独立 Controller session，但同一 Experiment 的所有候选使用同一份 `ResolvedAgentConfig`，不共享隐藏状态。

不固定：

- 后续用户消息的具体文字；
- 消息出现的轮次；
- 候选 Agent 自己已经发现的信息；
- 因候选轨迹不同而产生的纠正、确认和验收请求。

Controller 可以直接读取原始会话，并自主判断哪些历史内容表达用户能力、哪些只属于原轨迹。这里不实现复杂的未来信息检测、泄漏评分或人工规则引擎；行为边界由 system prompt、只读观察能力和 trace 可追溯性保证。

## 4. TaskCase（任务胶囊）视图

`TaskCase` 是 Controller 的历史事实来源，也是早期设计所称 Task Capsule 的统一名称。Controller 不重新提炼一份替代 transcript 的任务说明，而是在完整材料上使用一个只读视图：

```ts
interface ControllerTaskView {
  caseId: string;
  source: SessionRef;
  initialInput: UserMessage;
  transcript: TranscriptView;
  historicalEvents: HistoricalEventView[];
  baseline: BaselineEvidenceView;
  taskContext?: TaskContext;
  sourceRuntimeSummary: SourceRuntimeEvidenceSummary;
  environmentSummary: EnvironmentBaselineSummary;
  privacy: EffectivePrivacyPolicy;
}
```

### 4.1 完整会话与 initialInput

用户选择的完整逻辑会话就是 TaskCase 表示的任务。Controller 必须同时理解两种不同用途：

```text
TaskCase.initialInput             TaskCase.transcript
─────────────────────┬────────────────────────────────────────
冻结的原用户任务句（只读考卷）     理解用户协作能力与历史结果的完整证据
```

- `initialInput` 是 Case Preparation 从完整会话选出的第一条用户任务句（跳过产品注入的指令块）；
- Target Runtime 收到的每一条用户消息都由 Controller 写出，包括第一句；Host 不把 `initialInput` 原文投递给候选；
- Controller 可以读取完整 transcript，并根据候选当前表现决定是否需要提出历史中类似的纠正、补充或验收输入；
- 历史会话结束不是候选运行的停止边界。

Controller 不选择会话内任务边界，也不为 Target 补造会话开始前上下文。resume、fork 或 parent session 是否属于同一个逻辑会话，由 ProductHistoryReader 在导入时确定并留下 provenance。

### 4.2 用户能力证据

Controller 可以从原会话自然理解：

- 用户知道的业务和技术事实；
- 用户偏好的范围、风格和取舍；
- 用户愿意授权或拒绝的动作；
- 用户通常如何纠偏、要求验证和确认完成；
- 用户实际能查看的文件、页面、命令输出或其他产物。

`taskContext` 可以包含用户确认的备注或导入 Agent 的摘要，但摘要不能替代原始 transcript。推断内容保留 provenance，不能伪装成用户明确说过的话。

### 4.3 BaselineEvidence

Baseline 保存原始完成结果，是候选结果的比较对象，但不是要求复刻的标准答案。更强的候选模型可以采用不同路径、产生更好的结果，Controller 不应把原 Agent 后来调查得到的答案或实现路径当作用户原本知道的事实直接提供给候选。这个边界由 canonical system prompt 约束，不增加未来信息检测或第二审查 Agent。

历史产物缺失时，Controller 只能依据仍然存在的消息和引用；不得把缺失的文件、截图或检查结果补造成事实。

## 5. Target Runner 交互生命周期

TargetRunner 的公共协议定义在[架构总览](./overview.md)。从 Controller 视角，一轮协作经历：

```text
Controller opening send persisted
→ RunOrchestrator 调用 start（正文是 Controller 的 message）
→ delivery accepted
→ Target started（可能稍后发生）
→ Target 输出消息、调用工具和修改环境
→ TargetRunner 产生 TurnSettlement
→ RunOrchestrator 进入 awaiting_controller
→ Observation Assembler 构造 SteeringContext
→ Controller 返回 send 或 done
```

候选进程与 Controller session 在准备阶段一同拉起。第一条用户输入之前，首次 `decide` 在本 run 的同一 Session 内先做一轮自由理解（读取完整历史用户输入，不交决策信封），再返回 opening `send`。没有独立 Understanding schema 或账本。Controller 只在 `awaiting_controller` 上做后续决策，并先看 Host 生成的 `current-user-view.md`。以下都不能触发后续决策：

- Runtime 只接受了消息但 turn 尚未开始；
- 模型刚输出一段流式文本；
- 工具仍在运行；
- Runtime 的 transport 暂时静默；
- Harness 尚未确认 delivery；
- CandidateRun 已进入 `finalizing` 或 `finished`。

### 5.1 可产生决策的 settlement

```ts
type TurnSettlementStatus =
  | "completed"
  | "waiting_input"
  | "failed"
  | "aborted";
```

- `completed`：Target 结束当前 agentic turn，可判断继续、验收或停止；
- `waiting_input`：Target 明确要求澄清、确认或权限决定；
- `failed`：Controller 可以在仍有正常用户可提供的信息时纠正，否则结束；
- `aborted`：通常结束，不自动生成一条假用户消息恢复运行。

Runtime 产品的 turn 数和模型调用数不等价。Controller 的一次决策对应一个稳定用户输入边界，而不是某个固定模型调用次数。

### 5.2 approval 与真实用户决定

如果 Target 等待的是低风险、可逆且原会话已体现授权倾向的普通选择，Controller 可以发送自然语言确认。遇到真实发布、删除、付款、权限扩大、数据迁移或其他高影响动作，而原会话没有明确授权时，Controller 必须返回：

```ts
{ type: "done", reason: "requires_real_user_decision" }
```

Controller 不直接调用 Runtime 的 approval API；它只能通过普通用户消息表达原用户有能力作出的决定。

### 5.3 delivery unknown

`DeliveryReceipt.delivery === "unknown"` 时，RunOrchestrator 不会调用 Controller 生成替代消息。它先要求 ProductRuntime 核查旧 message/turn；仍无法确认则进入 `finalizing`。这样避免同一纠正或授权被发送两次。

## 6. Observation Adapter

Controller 不能只读 Target 的最终自述，也不应获得无界、无 cwd 锁的 shell。Observation Adapter 是 Controller 模块内部的产品无关组件：它只处理 ProductRuntime、Environment 和 ArtifactStore 已经规范化、且用户正常可见的事实。Host 把工作区七工具挂在 briefing 根上，`project/` 只读挂载隔离副本；不注册 `read_observation`。见 [Controller 七工具](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)、[路径 briefing](../decisions/accepted/2026-09-03-controller-path-briefing.md)。

```text
TargetEventSink / Environment fingerprint / ArtifactStore
                         ↓
               Observation Adapters
                         ↓
                 TargetObservation
                         ↓
                Observation Assembler
                         ↓
                  SteeringContext
```

### 6.1 设计原则

1. **事实优先**：保留 Agent 自述、工具结果、Harness 观察和独立检查的证据来源。
2. **轻量内联**：消息、状态和短摘要内联；长日志、diff、截图和二进制内容使用引用。
3. **Adapter 不替 Target 干活**：Observation Adapter 不修改候选环境、不替 Target 执行修复。Host 工作区工具另有写策略，仍不得调用 Target Runtime。
4. **按需展开**：Controller 可读取允许的 artifact 引用，不把所有历史内容塞进每轮 prompt。
5. **产品隔离**：Claude/Codex 私有事件先由 ProductHistoryReader 或 ProductRuntime 归一化；Controller 不解析私有 JSONL，也不加载产品专属 Controller Playbook。
6. **诚实缺失**：无法采集的事实标记 unavailable，不根据 Agent 文字推断为已验证。

### 6.2 TargetObservation

```ts
interface TargetObservation {
  turn: {
    index: number;
    settlement: TurnSettlement;
  };
  messages: MessageObservation[];
  toolCalls: ToolCallObservation[];
  claims: AgentClaim[];
  checks: CheckObservation[];
  blockers: BlockerObservation[];
  artifacts: ArtifactSummary[];
  telemetry: TurnTelemetry;
  rawRefs: ArtifactRef[];
}
```

`TargetObservation` 只描述当前 turn 及其必要上下文。完整候选轨迹由 trace 引用，Observation Assembler 根据上下文预算提供相关窗口。

### 6.3 Adapter 类型

第一版不建立复杂插件框架，只需要一组显式注册的普通 adapter：

| Adapter | 输入 | 输出示例 |
|---|---|---|
| message | 规范化 Target events | assistant 消息、澄清、完成声明 |
| tool | tool start/result events | 工具名、状态、短结果、错误引用 |
| filesystem | before/after fingerprint、artifact | 文件变化、diff 引用、输出文件 |
| check | 命令或 Runtime 事件 | 测试、构建、lint、验收结果 |
| visual | screenshot/document preview artifact | 页面、幻灯片、文档预览引用 |
| browser | 浏览器 observation artifact | URL、页面状态、截图 |

未支持的任务类型仍可通过原生 artifact 和 Target 消息运行，不要求先发明新领域类型。

### 6.4 被动观察与主动探测

默认使用执行过程中自然产生的被动事实。只有任务判断确实需要、且用户正常会查看某项结果时，Observation Adapter 才能请求声明式只读探测。探测能力必须标明输入、可能副作用和证据来源。

Controller 不获得无界 shell。需要 Target 建立证据时发送 `verify` 消息；报告阶段由 Comparison 写 `report.html`，不把两者混进 Controller。隔离副本上的 `powershell` 有 cwd 锁、净化环境和预算。

### 6.5 Artifact 解析

`ArtifactRef` 只是一条受保护引用。Pi Controller 通过 Controller Host 提供的只读 resolver 读取允许内容：

```ts
interface ControllerArtifactReader {
  readText(ref: ArtifactRef, limit: ReadLimit): Promise<TextArtifactView>;
  renderPreview(ref: ArtifactRef, options?: PreviewOptions): Promise<PreviewRef>;
}
```

Host 在读取前执行 run ownership、路径边界、类型、大小和 privacy policy 校验。Controller 看不到 Trace Store 或文件系统的可变句柄。

## 7. SteeringContext

Host 每次结构化 `append` 给模型的用户消息是固定决策段加 INDEX.md，不是本对象的 JSON。首次 `decide` 另有一轮自由理解委托。`current-user-view.md` 是用户可见表面快照：可见助手文本取最近一次 settlement 事件区间内的全部公开正文（段间拼接），确认/授权请求写入 Prompt。`permissions.txt` 分 Controller 只读工具与候选运行权限；后者来自历史会话已解析设置，缺失时标 unconfirmed。历史正文与本 run 回合在 briefing 文件里，由 Controller 先看快照再按需 `read`。`controller.requested` snapshot 含 `promptContent`、`briefingRoot` 与所列文件 hash。settled turn 先写不可变 turn 目录，再发布 `current-user-view.md` / `THIS-TURN.txt` / `INDEX.md`。见 [权限快照与当前视图](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md)、[唯一用户视图入口](../decisions/accepted/2026-09-10-controller-current-user-view.md)、[briefing 原子发布](../decisions/accepted/2026-09-10-controller-briefing-atomic-publish.md)。

```ts
interface SteeringContext {
  runId: string;
  task: ControllerTaskView;
  current: TargetObservation;
  trajectory: TrajectoryWindow;
  environment: EnvironmentObservation;
  priorDecisions: ControllerDecisionRecord[];
  budget: RunBudgetSnapshot;
  permissions: ControllerPermissionView;
}
```

- `trajectory` 包含相关的近期消息、早期阶段摘要和 trace 引用；
- `environment` 是只读的候选产物与 mismatch 观察，不是 Environment 句柄；
- `priorDecisions` 防止重复纠正，并帮助维持同一个用户的连续性；
- `budget` 供 Host 记录调用次数与可选显式上限，不写入模型可见 prompt；
- `permissions` 表明哪些决定必须交还真实用户。

上下文裁剪顺序：

1. 永远保留 `initialInput`、用户目标和硬约束；
2. 保留当前 turn 的完整轻量观察；
3. 保留 Controller 已发送消息；
4. 压缩较早候选轨迹，但保留 artifact/trace 引用；
5. 只按需读取长 artifact；
6. 不因预算不足删除安全和授权边界。

## 8. Canonical ControllerDecision

Controller 对外只暴露一个决策方法。以下接口与架构总览完全一致，Controller 实现直接导入公共类型：

```ts
interface ControllerPort {
  decide(context: SteeringContext): Promise<ControllerDecision>;
}

type ControllerDecision =
  | {
      type: "send";
      message: string;
      intent: "continue" | "inform" | "correct" | "verify";
      rationale?: string;
      evidenceRefs?: EvidenceRef[];
    }
  | {
      type: "done";
      reason:
        | "satisfied"
        | "blocked"
        | "requires_real_user_decision"
        | "no_further_value";
      rationale?: string;
    };
```

只有 `send.message` 发送给 Target Agent；intent、rationale 和 evidenceRefs 只写入 trace。`wait` 是 Runner 状态，不是 Controller decision。

### 8.1 四类发送意图

- `continue`：方向正确且继续自主执行仍有价值；
- `inform`：补充原用户知道、但 Candidate 当前缺少的事实或约束；
- `correct`：指出目标理解、范围、计划或产物已经出现的偏差；
- `verify`：要求 Target 对完成声明、风险或产物建立必要证据。

intent 是可观测解释，不是硬编码的行为策略。Controller 仍通过 Agent 判断最自然的具体消息。

### 8.2 done 理由

- `satisfied`：目标和必要证据已经足够；
- `blocked`：Target 或环境无法继续，普通用户输入不能解决；
- `requires_real_user_decision`：需要超出历史授权的真实决定；
- `no_further_value`：继续运行预计不会增加有效结果或比较信息。

预算、timeout、Runtime failure 和 user abort 是 Orchestrator stop reason，不伪装成 Controller done。

有效的非 satisfied 判断表示任务 incomplete。Host 接受 Controller 的 `done` 作为停止决定，不因未读 briefing 文件、缺失账本或省略 `understandingDelta` 而拒绝。历史记录中的 `controller.understanding` 与账本事件仍可只读展示。具体取舍见 [先理解再按视图决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md)。

## 9. 决策过程

首次 `decide` 先在同一 Session 自由理解完整历史用户输入，再返回 opening `send`。后续只在稳定 settlement 后，先看 `current-user-view.md`，再按需读取用户可访问材料。判断顺序由 prompt 约束，不在 Core 写成规则引擎：

```text
1. 当前用户可见结果是否已经满足这项历史任务？候选自称完成不够。
2. 真实用户此刻会不会继续检查、修改、确认或授权？
3. 若会继续，发送一条符合当前结果和历史交互节奏的自然消息。
4. 若目标已满足且没有必要下一步，则结束。
```

不要按历史用户句下标重放。候选走了不同但有效的路径时，根据当前结果回应。不要为了增加轮数或追求无关完美而继续。

## 10. Prompt 与评估分层

可执行 system prompt 与 Turn 1 / opening / 循环 prompt 以 [`controller-agent.ts`](../../src/agents/controller-agent.ts) 为准，门禁快照为 [`controller-system-prompt.txt`](../../test/snapshots/controller-system-prompt.txt)。本文不复制全文。

briefing INDEX 把材料分成三类，不得混用：历史用户要求（`history/user-inputs/` 与 `initial-input.txt`）、历史 agent 发现（`role=assistant`，不是模拟用户的先验）、当前候选事实（`current-user-view.md`、`run/turns/` 与 `project/`）。历史用户句不是按序重放队列；发完历史句不是完成条件。高影响授权仍要求历史会话已体现。模型可见请求是决策段加 INDEX.md，不把 SteeringContext JSON 或隐藏字段内联进 prompt。

Host 先持久化 `controller.decision` 再按 `clientMessageId` 投递；取消或 `unknown` 投递不重发。`controller.requested` 快照含 `promptDigest`（与 `CONTROLLER_PROMPT_DIGEST` 相同）。Invocation 完成记录 `modelRequests`；压缩记录 `tokensBefore`。每个 CandidateRun 独立 Controller Session。

机械协议由 `test/controller-collaboration-protocol.test.ts`、`test/candidate-run.test.ts` 与合同 lane `test/controller-capability-evaluation.test.ts` 覆盖。合同 lane 的样例族覆盖已满足用户、尚需核验、无继续价值、授权不足、历史 agent 结论不可信；该 lane 用脚本输出，不证明与真人协作等价。真实模型能力评估入口为 `npm run evaluate:controller -- <dataDir> <绝对报告路径>`，要求 `REPRISE_REAL_MODEL=1`，不进入 `npm run check`；报告只记类型/理由/intent 是否匹配，不含模型原文。见 [能力评估分层](../decisions/accepted/2026-08-22-controller-capability-evaluation-lane.md) 与 [协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)。

实现时把 schema、有效 reason、任务数据和权限边界作为独立结构化上下文提供，不在 prompt 文本中拼接不可信内容。

## 11. AgentHost

Controller 通过 Reprise `AgentHost` / `AgentSession` 管理模型调用、session、上下文和工具生命周期。每个 CandidateRun 使用独立 Controller session；不同候选模型不能共享模型隐藏状态，但必须使用 Experiment 已解析的同一 Controller 配置。

Host 负责：

- 创建具有固定 system prompt、模型和配置的 session；
- 注入只读 artifact reader；
- 捕获模型调用和工具生命周期遥测；
- 使用 schema 验证结构化输出；
- 将输入快照和原始输出保存为受保护 artifact；
- 在 CandidateRun 结束时关闭 session。

Controller session 不是可恢复实验状态。Orchestrator 只信任已经持久化的 `ControllerDecision`。如果调用返回后、decision 持久化前发生中断，可以重新构造同一 `SteeringContext` 调用一次；结果可能不同，但不能把未持久化的模型输出当成已发送事实。如果 decision 已持久化，则恢复时直接使用该事实，不再次调用模型。

Recovery Agent 和 Comparison Agent 复用同一个 AgentHost 实现，但使用独立 session、prompt、上下文和工具，不与 Controller 共享对话。Controller 的 prompt 属于 Controller 模块，不由 Product Pack 提供。执行循环由 Pi 适配器驱动，见[基座 Host](../decisions/accepted/2026-09-09-agent-foundation-host.md)。

## 12. Trace 与遥测

每次 Controller 调用至少追加：

```text
controller.requested
controller.observation_read
controller.decision
controller.completed | controller.failed
```

`controller.requested` 保存去标识化快照与 digest。同一 `requestId` 的 `controller.observation_read` 把本轮成功的 workspace `read` 或带 event refs 的观察记入 catalog。离线重建只读事件日志和已保存 artifacts，并校验 digest。

事件引用：

- `runId`、turn ID、`requestId` 和 operation ID；
- SteeringContext 快照或 hash；
- 使用的 Controller 模型、解析后身份和配置；
- Observation 与 artifact refs；
- 结构化 decision；
- 调用时间、token、成本和工具调用；
- schema 解析或模型失败。

Controller 产生的耗时和成本单独展示，不混入 Target 模型的过程效率。用户关心使用候选模型的实际体验时，报告可以同时显示 target-only 和 end-to-end 两种墙钟时间。

## 13. 失败与重试

- 结构化输出不合法：不发送半截文本；允许一次同上下文修复调用，仍失败则结束为 controller failure。
- Controller provider 失败：根据 Controller 自己的 `AgentBudget.maxProviderRetries` 允许有限重试；`RunPolicy` 只约束 Target Runtime。不能自动换模型后仍声称 Controller 条件相同。
- Artifact 不可读：保留 unavailable，Controller 基于其余证据判断。
- Observation Adapter 失败：记录 adapter 和原始引用；必要观察缺失时可以结束为 blocked。
- 重复调用：以 `runId + turnIndex + observationHash` 关联；已持久化 decision 不重新生成。
- Candidate 已进入 finalizing：迟到的 Controller 输出只保存 raw artifact，不执行。

Controller failure 与 Target failure、Runtime failure 和报告 failure 分开记录。

## 14. 安全与隐私

- Controller 输入先应用 `TaskCase.privacy`；密钥和凭据不进入模型上下文。
- Controller 工具只能作用于本 run 的隔离副本与 Host 允许的观察源；不得写用户源目录或调用 Target 工具。
- 原始会话可能包含个人和业务数据；外部 provider 的发送范围必须可见并可配置。
- `rationale` 不应包含敏感推理或完整私有内容，只保留对用户有用的简短依据。
- Controller 消息经过长度、空文本和控制字符验证后才能发送给 Runtime。
- 模型输出中的路径、artifact ID 和 evidence ref 均视为不可信输入并校验。

## 15. 与 Comparison 的关系

Controller 可以要求 Target 验证工作，但不决定最终报告布局。运行结束后，产品无关的 Comparison Agent 读取 baseline、RunRecord、规范化 artifacts、客观遥测和 FidelityAssessment，选择值得并排展示的结果证据。

两者区别：

```text
Controller Agent: 为了让任务继续完成，下一条用户消息是什么？
Comparison Agent: 为了让用户直接比较结果，应该展示什么以及如何组织？
```

Comparison Agent 不读取 Product Pack 或产品私有日志，也不改变运行结果、质量打分或 fidelity。它失败时报告退化为客观遥测、原始消息和 artifact 列表；CandidateRun 仍然完成。完整设计见[Comparison 专题](./comparison.md)。

## 16. 最小实现顺序

1. 从一个已有 `TaskCase` 构造 `ControllerTaskView`；
2. 接收 ProductRuntime 的规范化 turn 和 message/tool 事件；
3. 实现轻量 `TargetObservation` 与 artifact 引用；
4. 构造可 hash 的 `SteeringContext`；
5. 用 AgentHost 实现一次 schema-constrained decision；
6. 将 decision 先写 trace，再交给 RunOrchestrator；
7. 覆盖 satisfied、纠偏、验证、真实用户授权和 controller failure 场景；
8. 再按实际任务增加视觉、浏览器或文档 Observation Adapter。

## 17. 模块验收条件

- 同一原始会话面对两条不同候选轨迹可以生成不同且合理的消息；
- 原始后续消息不会被机械 replay；
- Controller 只在稳定 settlement 后调用；
- decision 公共 schema 与架构总览一致；
- Target 只收到普通用户消息，不收到 intent 或 rationale；
- Controller 能读取允许的产物证据，但不能修改环境或调用 Target 工具；
- 已持久化 decision 在恢复后不会重复生成或重复发送；
- 高影响且无历史授权的决定返回 `requires_real_user_decision`；
- Controller 遥测与 Target 遥测可分开查看；
- 报告失败或 Comparison Agent 失败不改变 Controller 或 RunOutcome。

目标重构中 Controller 的会话边界见[Session / harness / workflow 规划](../plan/reprise-architecture-redesign.md)；本文仍描述当前实现。
