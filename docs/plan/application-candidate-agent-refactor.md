# Application 层与受控候选 Agent 链整体重构计划

状态：proposed，尚未实施

## 目标

在 Reprise Agent 运行链已经重构完成的前提下，整体重构 Application 层与受控候选 Agent 链，完成可回放、可审计、隔离且由 Controller 驱动的单候选实验。候选每次在 Recovery 产生的隔离目录中启动一个全新的本地产品 Session；目标产品为 Claude Code 与 Codex。整体重构不保留旧命名、兼容别名或双轨实现。

## 目标架构

```text
Reprise Agent 链：Controller / Recovery / Comparison
  → AgentHost / AgentSession → PiProviderAdapter → Pi Agent / Pi AI → Reprise 模型

候选链：TaskCase → ProductPack.history → observations → RecoveryAgent
  → CandidateLaunchContext → CandidateRun → ProductPack.runtime / TargetRunner
  → 本地候选 CLI 新 Session
```

Application 是两条链之间的编排器，不执行候选工具、不读取隐藏推理、不替 Controller 生成消息、不替 Comparison 判断。

## 实验闭环

```text
配置 Reprise 模型 → 选择历史会话并冻结 TaskCase → 物化 observations
→ RecoveryAgent 恢复任务起点 → Host 机械校验 → 选择候选产品/模型
→ 启动新 Candidate Session → Controller opening send
→ CandidateRun 投递普通用户消息 → 等待原生 turn settlement
→ Product UI Projection 生成 UserVisibleTurn → 持久化本轮材料
→ Controller steering send/done → 循环 → 停止候选、封存、释放
→ 物化历史与候选双轨 Comparison 输入 → ComparisonAgent → report.html
```

Controller opening/steering 以 `docs/architecture/controller.md` 和源码为准；Comparison 材料范围以 `docs/architecture/comparison.md` 为准。

## Product Pack

每个 Pack 必须同时提供：

```text
ProductPack = HistoryReader + RuntimeLauncher + UserSurfaceProjection
```

HistoryReader 负责本地会话发现、读取和转换；RuntimeLauncher 负责可用性、模型目录、隔离目录中新 Session、消息投递、原生 settlement 和停止；UserSurfaceProjection 消费标准 Runtime 事件并在稳定 turn 后生成用户可见结果。三者不共享可变 Session 状态。凭据直接使用用户本地登录状态，绝不进入事件、artifact、briefing 或报告。

## 历史材料与 Recovery

HistoryReader 产生完整可追溯的 `ImportedSession`（消息、事件、产物、元数据和 source refs），Host 物化只读：

```text
observations/{INDEX.md, session.json, user-inputs/, transcript/, events/, artifacts/, files/, metadata/, source-refs/}
```

Recovery 只读 observations 和 staging，不读产品原始目录。必须恢复任务开始前的等价条件；无法解析的内容保留脱敏原文/引用并标记缺失。Recovery 写 recovery.md 后，Host 检查文件、隔离路径、污染、输入和环境，再生成不可变 `CandidateLaunchContext`。

## 候选运行

```ts
type CandidateLaunchContext = {
  experimentId: string; runId: string; workspaceRoot: string;
  productId: string; requestedModel: string; resolvedModel: string;
  permissions: Record<string, string>;
};
type CandidateSessionHandle = {
  sessionId: string; productId: string; requestedModel: string;
  resolvedModel: string; workspaceRoot: string;
};
```

每个 TaskCase 只创建一个 CandidateRun；运行中不得换产品、模型、workspace 或悄悄重启新 Session。CandidateRun 是状态、幂等、事实、清理和结果的唯一边界；TargetRunner 提供 start/send、delivery receipt、原生 settlement、停止和取消等待。

## 标准 Runtime 事件

```ts
type CandidateRuntimeEvent = {
  eventId: string; sequence: number; type: CandidateRuntimeEventType;
  occurredAt: string; sessionId: string; turnId?: string;
  messageId?: string; callId?: string; payload: unknown;
  evidenceRefs: readonly string[];
};
```

事件 ID 唯一，sequence 在 CandidateRun 内递增；标识不得猜测或复用。最小类型：session_started/failed、message_submitted、delivery_observed、turn_started、tool_started/finished、visible_output/prompt、turn_settled、usage_reported、runtime_failed、session_stopped/closed。影响状态、Controller 视图、Comparison 判断、清理或审计复原的事件必须进入 Journal；原始包体、心跳、内部重试、未稳定 token、私有 UI 树和凭据只留 Adapter 内部。

## 用户可见投影

```text
标准 Runtime 事件 → UserSurfaceProjection → UserVisibleTurn
```

只在 settlement 后生成用户可见助手文本、状态、确认/授权/拒绝提示、交付入口和观察时间。写入：

```text
controller-briefing/current-user-view.md
controller-briefing/run/turns/{n}/user-view.md
```

本轮文件不可变，当前文件是最新稳定入口；禁止隐藏推理、完整工具参数、内部诊断和流式中间内容进入视图。视图持久化后才触发 Controller。

## Application 顺序与终止

每轮顺序：`controller.decision → input.submitted → runtime.delivery_observed → runtime.turn_settled → user-view → controller.requested`。只有 completed/waiting_input 进入下一次 Controller；候选 failed/aborted、任一 Reprise Agent 失败、Application/持久化失败或用户取消都终止。终止统一执行：停止候选 → 封存 artifact → 释放 staging → 写 outcome；迟到事件不得覆盖终态。

## Comparison 双轨输入

CandidateRun 停止、清理和封存后，Application 发布不可变 Comparison 输入，分别挂载历史与候选的完整过程和结果，不强行统一结构：

```text
comparison-attempt/{INDEX.md, facts/, history/, candidate/, work/}
```

History 包含历史用户输入、Agent 过程、事件、产物和视图；candidate 包含 Controller 消息、Runtime 事件、用户视图、产物和 outcome。ComparisonAgent 按 `INDEX.md` 按需读取，不访问活动 Session、不修改事实。候选失败但有封存材料时仍可比较；材料未形成则不启动。

## 实施步骤

1. 冻结调用图、状态图、事件顺序和本计划引用的既有规范。
2. 重写 ProductPack 合约，删除旧 Provider/兼容接口。
3. 重写 HistoryReader、ImportedSession 和 observations 物化，保留完整材料及隐私/所有权校验。
4. 重写 Recovery 准入和 CandidateLaunchContext 交接。
5. 重写 TargetRunner/产品 Adapter 的新 Session、sessionId、delivery、原生 settlement、投影和停止。
6. 重写 CandidateRun 与 Application 编排、视图持久化、取消、失败和清理。
7. 重写 Comparison materializer，挂载历史与候选完整轨迹，复用既有 Runner/Publisher。
8. 用 Fake ProductPack/TargetRunner 覆盖闭环、失败、取消、超时、投影和 cleanup；再接入 Claude Code 与 Codex。
9. 每阶段 `npm run build`，最终 `npm run check`；协议变化同步 decisions/ 与 progress/MASTER.md。

## 验收

- 一个 TaskCase 一个 CandidateRun，候选始终在 Recovery 隔离目录启动全新 Session。
- Controller 输入、CandidateRun 状态、Runtime settlement 和用户视图均可从持久化事实复原。
- 历史与候选过程/结果均可供 Comparison 按需读取。
- 候选失败与 Reprise Agent 失败来源清晰并终止；取消、超时和迟到事件安全。
- 原始项目不变，凭据不落盘到 Reprise 事实，默认路径不产生外部费用。

## 禁止事项

- 不新增 Agent 间消息总线；不把候选交互放进 Reprise AgentHost。
- 不让 Application 执行候选工具或读取隐藏推理。
- 不把候选原始输出直接交给 Controller。
- 不用摘要替代可按需读取的历史/候选材料。
- 不在应用层写产品类型分支。

## 后续完整重构实施计划

本节是在前述目标架构基础上的执行清单。执行者应先阅读本文件以及 `docs/architecture/controller.md`、`docs/architecture/comparison.md`、`docs/architecture/environment.md`、`docs/architecture/run-outcome.md` 和相关 `AGENTS.md`，再开始修改。不要先改产品 Adapter；先完成领域边界和 Fake 验证。

### 阶段 A：建立重构基线

1. 绘制当前调用图：TUI/CLI → Application → Recovery/Controller/CandidateRun/Comparison → Runtime/Environment。
2. 列出所有旧接口、旧路径和旧字段，确认它们的真实调用者。
3. 冻结目标状态图、事件顺序、失败来源和数据所有权。
4. 建立 Fake ProductPack、Fake HistoryReader、Fake TargetRunner 和 Fake UserSurfaceProjection 的测试骨架。
5. 运行现有构建与门禁，记录基线；不得把当前绿灯当作新架构完成证据。

交付物：调用图、状态图、依赖清单、Fake 测试骨架和基线验证记录。

### 阶段 B：重构 ProductPack 合约

目标：一个产品同时提供历史读取与候选运行，Application 只依赖产品无关端口。

1. 定义 `ProductPack`、`ProductHistoryReader`、`ProductRuntime`、`ImportedSession`、`CandidateLaunchContext` 和 `CandidateSessionHandle`。
2. 删除旧 Provider/Pack 兼容接口和重复的产品选择分支。
3. 将产品发现、模型目录和 Runtime 创建收敛到 Pack；Application 不判断产品类型。
4. 所有跨边界对象在持久化或来自外部 JSON 时经过 Schema 校验。

验收：Fake Pack 可完成会话发现、模型选择和新 Runner 创建；Application 不导入产品私有实现。

### 阶段 C：重构历史会话与 observations

目标：Recovery、TUI、CLI、Comparison 都能读取完整且可追溯的历史材料。

1. 各 Product HistoryReader 将本地会话转换为完整 `ImportedSession`。
2. 保留用户/Agent/工具消息顺序、事件、产物、项目路径、时间、元数据和 source refs；不可解析内容标记缺失并保留脱敏引用。
3. Host 物化只读 `observations/`，生成稳定 `INDEX.md`、用户输入索引、transcript、events、artifacts、files 和 metadata。
4. 应用隐私策略、路径所有权、大小和类型限制；凭据和秘密永不物化。
5. TaskCase 冻结只引用物化材料，不把产品原始路径暴露给 Recovery。

验收：同一 ImportedSession 重复物化结果稳定；Recovery 可按索引读取完整材料；TUI/CLI 摘要不读取产品原始格式。

### 阶段 D：重构 Recovery 交接

目标：Recovery 只负责恢复任务开始前条件，Application 负责确定性准入。

1. Recovery 使用 observations 和 staging 工具，不访问产品原始会话目录。
2. 明确必须恢复、可选保留和默认清除内容。
3. Recovery 写 `recovery.md` 和结构化结果；Host 检查文件、路径隔离、污染、必要输入、报告 Schema 和 staging 可读性。
4. 检查通过后生成不可变 `CandidateLaunchContext`，包含实验、运行、workspace、产品、模型和权限事实。
5. 任何 RecoveryAgent 失败或准入检查失败都停止流程，不创建 CandidateRun。

验收：恢复失败不能启动候选；成功交接只包含隔离 workspace 和已解析候选配置；原始项目保持不变。

### 阶段 E：重构候选 Runtime 与 TargetRunner

目标：以产品无关端口驱动本地候选产品的新 Session。

1. `ProductRuntime` 提供可用性检查、模型目录、候选校验和 Runner 创建。
2. Runner 在 `CandidateLaunchContext.workspaceRoot` 启动全新 Session，返回真实 `sessionId`。
3. 实现普通用户消息的 start/send、delivery receipt、原生 turn settlement、取消等待、inspect、stop 和 close。
4. 不恢复历史来源会话；进程重启、Session 失效或无法确认交付均按候选失败处理。
5. 产品 CLI/IPC/API、登录状态和产品私有协议全部封装在 Product Adapter；Application 不解析原始消息。
6. Windows 进程、`.cmd` 启动、路径和终止按项目平台规范实现。

验收：Fake Runner 覆盖接受、拒绝、未知交付、原生完成、等待输入、失败、超时、取消和迟到事件。

### 阶段 F：实现标准 Runtime 事件与 UI Projection

目标：将产品事件转换为可审计事实和 Controller 可见结果。

1. 实现 `CandidateRuntimeEvent`，强制 `eventId`、单调 sequence、时间、sessionId、可选 turnId/messageId/callId、payload 和 evidence refs。
2. Adapter 先标准化事件，再交给 CandidateRun Journal；Application 不处理产品私有事件。
3. 实现每个 Product Pack 独立的 `UserSurfaceProjection`，只消费标准事件。
4. 只在原生 settlement 后生成 `UserVisibleTurn`；区分 completed、waiting、failed、aborted、empty、unavailable。
5. 持久化 `controller-briefing/current-user-view.md` 与每轮不可变 `run/turns/{n}/user-view.md`，同时保存 settlement、事件索引和变更路径。
6. 投影失败不得静默当作空输出；明确失败或不可用状态。

验收：流式中间内容不会触发 Controller；用户视图只含公开事实；同一事件序列可重建同一视图。

### 阶段 G：重构 CandidateRun

目标：CandidateRun 成为单候选的状态、事实、幂等和清理边界。

1. 保留并收敛合法状态迁移，所有迁移通过 `assertTransition`。
2. 绑定 `CandidateSessionHandle`，验证 run/session/turn/message 的所有权。
3. Controller `send` 只能调用 start/submit；`done` 只能调用 settleController。
4. 固定每轮持久化顺序：decision → input → delivery → settlement → user view → next controller request。
5. 对 `waiting_input` 回到 awaiting_controller；候选 failed/aborted 立即终止。
6. 幂等处理 clientMessageId；unknown delivery 不重发。
7. 统一 stop、artifact capture、environment release 和 outcome 创建；终态不可覆盖。

验收：并发 submit、重复消息、取消竞态、超时、迟到 settlement、stop 超时和 cleanup 失败均有确定结果。

### 阶段 H：重构 Application 工作流

目标：Application 只做跨模块编排。

1. 重写 workflow 入口，按配置、intake、Recovery、候选选择、启动和运行阶段传递不可变上下文。
2. 为每个活动阶段建立 AbortSignal，并将取消传播到对应 Reprise Agent、CandidateRun 和 Runtime。
3. Controller opening 先自由理解再返回 send；steering 只在用户视图持久化后调用。
4. Application 不生成候选消息、不执行候选工具、不读取隐藏状态、不绕过 CandidateRun。
5. CandidateRun 结束后先完成停止、封存和释放，再决定是否创建 Comparison 输入。
6. Reprise Agent 失败、候选失败、Application 失败和用户取消分别写来源并终止。

验收：完整闭环只有一个活动候选；任一失败都能停止候选并释放资源；TUI/CLI 取消可跨终端生效。

### 阶段 I：重构 Comparison 资料物化

目标：Comparison 同时按需读取历史和候选的过程与结果，不强行统一两侧结构。

1. CandidateRun 完成清理和封存后，生成不可变 `comparison-attempt`。
2. 分别提供 `history/` 和 `candidate/`，包含消息、事件、用户视图、产物、变更、outcome 和证据索引。
3. 生成 `facts/`、`links` 和执行条件投影；缺失 token/速度/费用保持缺失，不补零或估价。
4. 复用既有 Comparison 四轮 Session 和 Publisher；Comparison 不访问活动 Session，不修改事实。
5. 候选失败但有封存材料时允许比较，并由 Agent 表达限制；材料未形成时不启动。

验收：Comparison 能读取两条完整轨迹；报告失败不覆盖候选结果和旧成功报告。

### 阶段 J：TUI/CLI 同步与删除旧代码\r\n\r\nTUI/CLI 的具体执行清单见阶段 L；本阶段只作为依赖关系节点，不提前实现界面。

### 阶段 K：测试与验证

每阶段改动后先运行 `npm run build`，完成相关测试后运行 `npm run check`。至少覆盖：

- ProductPack 历史/运行端口和 Schema；
- observations 稳定物化、隐私和所有权；
- Recovery 准入和 CandidateLaunchContext；
- TargetRunner 生命周期、原生 settlement、失败和取消；
- Runtime 事件关联和证据引用；
- UI Projection 稳定视图；
- CandidateRun 状态、幂等、竞态和 cleanup；
- Application 完整闭环及 Agent/候选失败来源；
- Comparison 双轨输入、报告发布和失败隔离；
- TUI/CLI 结果与取消路径。

## 交接要求

执行 Agent 每完成一个阶段，应记录：改动文件、删除的旧接口、验证命令及实际输出、尚未解决的设计问题。不得声称“完成”而缺少构建和门禁证据。任何新增协议、持久化格式、工具面或工程门禁都必须在同一批次更新对应 `docs/decisions/`。

### 阶段 L：重构 TUI 与 CLI 入口

底层 Application、CandidateRun、ProductPack 和事件协议完成后，必须同步重构 TUI/CLI；界面不得继续持有旧的 RecoveryAttempt、Runtime 或 Provider 状态。

#### TUI 状态边界

TUI 只保存当前界面选择、活动句柄和事件投影，不拥有实验状态机。所有流程动作通过 `ExperimentWorkflow` 或活动控制端口完成：

```text
配置 → Intake → Recovery → 候选产品 → 候选模型
→ 启动确认 → Controller/Candidate 循环 → 终态 → Comparison/报告
```

TUI 必须展示不可变的实验、运行、候选 `sessionId`、产品、请求模型/解析模型、workspace 隔离状态、当前阶段、最近用户视图、失败来源、cleanup 状态和报告入口。选择确认后不得在 TUI 中修改 `CandidateLaunchContext`。

#### TUI 事件投影

TUI 只订阅 Application 事件和已持久化事件，不读取产品私有事件、Pi 内部事件、隐藏推理或活动 Runner 对象。事件投影至少覆盖 Recovery、Controller 决策、候选启动、delivery、turn settlement、用户视图、失败、停止、cleanup、Comparison 和报告发布。

用户可见候选内容统一来自 `UserVisibleTurn`；流式过程可作为临时展示，但不得写入 Controller 输入或正式时间线，除非已稳定并持久化。

#### TUI 取消与跨终端控制

TUI 取消只调用 Application 活动控制端口，不直接终止进程。取消信号必须传播到当前 Reprise Agent、CandidateRun、TargetRunner 和 Comparison。跨终端取消复用持久化控制记录和认证 IPC；取消、自然完成和清理竞态服从 CandidateRun 已持久化终态。

#### CLI/Headless

CLI 与 TUI 必须调用同一 `ExperimentWorkflow`，禁止复制实验编排或绕过 CandidateRun。以下入口统一使用新端口和数据结构：

```text
products / models / history / config
prepare / run / compare / cancel
```

CLI 输出产品无关的结构化状态，包括阶段、experimentId、runId、candidate sessionId、候选产品/模型、Controller 状态、终态、cleanup 状态、报告路径和失败来源。不得输出凭据、原始产品协议、隐藏模型文本或敏感诊断。

#### 路径与结果导航

TUI/CLI 不自行拼接实验路径，由 Application 返回受控目录或 artifact 引用。导航适配新的用户视图、本轮材料、Comparison attempt、报告和失败页路径；TUI 不解析 HTML，不从报告抽取业务结论。

#### TUI/CLI 删除与验收

删除旧的 Provider/Runtime 直接调用、旧状态字段、旧兼容路径和无调用者的 UI 分支。同步更新帧基线、国际化文案、帮助文本和无头协议。验证配置、intake、Recovery、候选选择、启动确认、Controller 循环、取消、失败页、Comparison 和报告导航；TUI 与 CLI 必须对同一持久化事实给出一致状态。

## 14. 最终交付检查

- 目标调用图、状态图和事件顺序与代码一致；
- ProductPack 同时提供 HistoryReader、RuntimeLauncher 和 UserSurfaceProjection；
- Application 不执行候选工具，不解析产品协议；
- TUI/CLI 只通过 Application 和事件投影工作；
- CandidateRun、Controller、Recovery、Comparison 的失败和清理边界可审计；
- 构建、项目门禁、相关测试和文档校验均有新鲜输出证据。

