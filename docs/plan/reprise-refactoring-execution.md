# Reprise 逐步重构实施计划

本文供执行重构的 coding agent 使用。它把[架构目标](./reprise-architecture-redesign.md)的七批迁移拆成执行步骤，不重新定义产品需求、公共字段或验收编号。目标语义以该文档及 [TUI 目标](./reprise-tui-design.md)为准；当前差异见[迁移边界](./documentation-reconciliation-for-session-harness-workflow.md)，唯一完成记录在 [MASTER](../progress/MASTER.md)。

M1.1–M7 实施步骤已关闭。未关闭的是 TUI 真终端、未通过的 Controller 真实模型 lane，以及未授权的 Runtime smoke，见 MASTER。下文各节是已执行批次的记录与验证命令，不是尚未开工的待办清单。

## 1. 执行规则与完成单位

### 1.1 每次接手的固定流程

1. 读取根与修改目录的 AGENTS、MASTER、本批目标和相关当前规范；检查 Git 状态，保留用户修改。
2. 查找本批入口及所有调用者，沿请求、事件、存储、清理四条路径确认所有者。测试只能说明覆盖的行为，不能代替调用链调查。
3. 写明本次边界、预期行为、失败场景、涉及 A 编号和验证方式；复用[任务 brief](./task-brief-template.md)，小步骤无需另建文档。
4. 先为重要行为差异建立最小可重复验证，再修改共同所有者，随后迁移调用方并删除失效实现。
5. 协议、磁盘格式、prompt、工具面或工程规则变化，同批更新对应 ADR 与当前规范。已确认目标不必重新求批准；新出现的产品取舍才向用户说明并询问。
6. 运行与修改匹配的验证，检查 diff 和受影响文档。失败要定位原因，不能降低覆盖率、跳过门禁或把旧预期机械改成新快照。
7. 在 MASTER 记录完成的步骤、验证命令与结果、剩余问题、下一步入口。未经授权不提交或 push；没有提交时如实记录工作区证据。

一个步骤完成需要实现、调用方切换、失败验证、旧路径清理和规范更新全部成立。允许一个步骤拆成几个可审查变更，但不能仅增加未接入的新模块便宣布完成。阶段间短期适配器必须有明确调用者和删除步骤，不保留第二套 Host、Session 写者或 workflow。

### 1.2 持续保持的边界

- 保持历史来源只读、候选环境隔离、秘密不进入日志与模型输出、边界 JSON 校验和真实调用 opt-in。
- Session 与 Invocation 的执行状态和 CandidateRun 的领域状态分别管理；CandidateRun 转换仍走唯一入口。普通列表、冻结及流程函数不升级成 workflow engine。
- 任务判断、终止原因、清理结果分别保存。投递未知不自动重发，取消不回滚文件副作用，重开只读历史不续跑。
- 优先收薄和复用现有 Pi、存储、路径、进程及 Pack 能力。不要为了目标示意图建立六层目录、DI 框架、通用 Verifier 或审计子系统。
- 默认三个内部角色共用模型配置，但绝不共享对话；内部 provider 适配和候选产品适配分开。
- 每批保留可运行的模拟路径。真实模型质量、实际产品协议和终端兼容性分别验证，不能用模拟成功代替。

## 2. 代码起点与迁移路线

### 2.1 优先调查的现有所有者

| 范围 | 代码入口 | 实施方向 |
|---|---|---|
| Agent 执行 | [Pi Host](../../src/infrastructure/pi-agent-host.ts)、[model caller](../../src/infrastructure/pi-model-caller.ts)、[压缩](../../src/infrastructure/pi-compaction.ts) | 复用 loop，分清持续 Session 与单次 Invocation，补全持久化事实 |
| 存储与领域状态 | [store](../../src/infrastructure/store/experiment-store.ts)、[schema](../../src/core/schema.ts)、[状态机](../../src/core/state-machine.ts) | 复用边界校验和原子写，建立唯一顺序写者及只读重建 |
| 实验编排 | [experiment](../../src/application/experiment.ts)、[CandidateRun](../../src/application/candidate-run.ts)、[TUI workflow](../../src/application/tui-workflow.ts) | 业务生命周期留在应用侧，提取与界面无关的公共操作 |
| 三角色 | [Recovery](../../src/agents/recovery-agent.ts)、[Controller](../../src/agents/controller-agent.ts)、[Comparison](../../src/agents/comparison-agent.ts)、[组装](../../src/application/harness-agents.ts) | 各操作连续 Session，删除独立理解和双会话的强制路径 |
| 恢复与环境 | [恢复入口](../../src/application/experiment-recovery.ts)、[恢复编排](../../src/application/recovery-orchestrator.ts)、[环境](../../src/environment/local-workspace-provider.ts) | 保留证据调查和隔离能力，封存可重复使用的场景 |
| 产品兼容 | [Pack 契约](../../src/products/contract.ts)、[Runtime 端口](../../src/core/runtime.ts)、[注册](../../src/products/index.ts) | 从静态注册接向显式本地加载，保持宿主产品无关 |
| 用户入口 | [CLI](../../src/cli/main.ts)、[TUI 控制](../../src/tui/controller.ts)、[intake](../../src/tui/intake-app.ts) | 纯 CLI 与 TUI 调用同一业务操作，选择与阅读状态留在 TUI |
| 投影与终端 | [timeline](../../src/tui/timeline.ts)、[projection](../../src/tui/view-projection.ts)、[viewport](../../src/tui/viewport.ts) | 单条持久化时间线，稳定阅读锚点，键盘与原生选区优先 |
| 本机能力 | [platform](../../src/infrastructure/platform.ts)、[process runner](../../src/infrastructure/process-runner.ts)、[Pack 进程 helper](../../src/products/shared/process.ts) | 统一 PowerShell/Bash 语义，验证进程树和本机控制端点 |

现有 Host 已提供 createSession 和 request，但部分 session 结束事件随 request 发出，消息/工具记录有摘要与散列，不能据此认定全过程可重建。Controller 已保留会话，但独立 understand、账本和完成反馈仍在实验调用链中。Comparison 有规划/报告路径。迁移必须检查这些实际行为，避免重复建设已有连续会话能力。

### 2.2 依赖与阶段出口

| 批次 | 输入条件 | 必须形成的可运行出口 |
|---|---|---|
| M1 执行与持久化 | 基线可解释 | 模拟 Session 多次调用、工具、压缩、取消、重开阅读 |
| M2 harness 与场景 | M1 的事实源可用 | prepare 产生封存场景，重复候选副本彼此隔离 |
| M3 Controller | M2 可运行候选 | 单 Session 完成 opening、多轮协作与停止 |
| M4 Comparison | M1 与终态快照可用 | 新进程从终态事实独立对照 |
| M5 Workflow 与 UI | M2–M4 的应用能力 | 完整/分步 CLI 和键盘 TUI 使用相同操作 |
| M6 平台与 Pack | M5 接入点明确 | 三平台控制端点、外部插件及跨终端取消可验证 |
| M7 收口 | 前述出口有证据 | 无双轨实现，公开文档、包和支持声明一致 |

按七批顺序推进。M1 就考虑平台路径，M2 就明确活动所有权，M5 就定义 cancel 的应用接口；M6 完成其真实 IPC 和平台证明。M5 可用进程内控制验证，不能因此提前宣布跨终端取消或整个 CLI 验收完成。

## 3. M1：Agent 执行机制与唯一持久化事实源

### M1.1 建立基线并验证 Pi 的实际能力

1. 核对安装和锁定的 Pi 版本，阅读正在调用的公开 Agent API。用模拟 provider 验证模型→工具→模型循环、原生消息块、取消和事件顺序。
2. 检查存储与压缩是否真正可用，特别是高级接口的占位分支；不得把类型存在当成功能存在。优先使用已经接入的 Agent Core，缺口只由 Reprise 的薄封装补齐。
3. 记录 Session/Invocation/message/tool/request 的身份及因果关系草案，明确一个 Session 同时最多一个 Invocation。
4. 对当前相关测试建立基线。已有失败单独记录，不把环境问题或既有失败归因于重构，也不以基线失败豁免本次新增缺陷。

出口：一项可运行的最小能力验证覆盖工具往返和取消，并给出唯一存储所有者选择。对应 A1；该选择涉及格式时更新 ADR。

**完成（2026-09-08）。** 锁定 Pi 0.84.1。公开 `Agent` 验证覆盖工具往返、原生消息块、事件顺序与取消；`AgentHarness` 高级入口为占位，不接入。唯一存储所有者是 Experiment `events.jsonl`，身份草案见[事实源决策](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)。验证：`npm run build` 后 `node --test dist/test/pi-agent-loop-baseline.test.js dist/test/pi-session-reliability.test.js dist/test/session-compact.test.js`。Invocation 生命周期拆分仍属 M1.2。

### M1.2 分开 Session 生命周期与 Invocation 生命周期

1. 保留 createSession/request 的真实复用价值；将请求完成与 Session 关闭的语义分开，给每次 Invocation 和底层模型请求稳定身份。
2. Session 创建时固定角色、模型配置快照、prompt/工具策略版本；Invocation 接收本次输入和取消信号。
3. 同一 Session 并发请求明确拒绝或串行化，选择一种并测试，不允许消息交错。操作结束后关闭 Session，禁止继续追加。
4. 超时、provider 重试、结构化输出修复分别指定唯一所有者和预算。修复继续原 Session，不能重跑已经成功的业务投递或有副作用工具。
5. 上层只消费完成、失败、取消等明确结果；结构化解析成功不替代业务检查，失败不能制造默认领域结果。

出口：同 Session 两次调用共享上下文，不同 run/角色不串话；并发重入、晚到响应、超时与取消有验证。对应 A2、A6、A9。

**完成（2026-09-08）。** Host 将 Invocation 完成与 Session 关闭分开；同 Session 并发 `request` 拒绝；`close()` 后禁止追加。验证：`npm run build` 后 `node --test dist/test/agent-session-lifecycle.test.js dist/test/agent-host.test.js`。理由见[生命周期决策](../decisions/accepted/2026-09-08-session-invocation-lifecycle.md)。完整模型输入仍属 M1.3。

### M1.3 完整记录并可重建模型输入

1. 扩展现有存储边界，持久化实际模型可见的消息、系统输入、工具定义版本、工具参数/结果、媒体引用及修复输入。大内容可引用受控附件，但引用必须可解析、可校验。
2. 保留文本/图片/工具块结构；工具调用与结果有稳定配对。只记长度、digest 或 UI 摘要不足以复原输入。
3. 压缩记录实际 summary、retained tail 的内容或稳定引用、触发原因及可用用量。压缩不删除完整历史，不保留孤立工具结果。
4. 秘密过滤发生在持久化和模型可见工具输出之前；明确被遮蔽的内容，记录真实发给模型的过滤后输入，不复制凭据快照。
5. 确定提交顺序：模型输入先可靠记录，再调用；结果记录后才能报告成功。事件监听和 TUI 渲染失败不能改变已提交业务事实。
6. 明确事件日志与索引/摘要的关系，派生索引可重建，不建立两份权威 transcript。附件落盘与引用发布中途失败不能产生虚假完成。

出口：从空进程读记录重建每次请求输入，包含一次压缩和一次修复；模拟写失败、尾部不完整、缺附件和非法 JSON，给出明确诊断。对应 A6–A8、A10。

**完成（2026-09-08）。** Host 在调用模型前写入过滤后的 `agent.message_appended`，成功路径在解码前写入 `agent.model_output`；大正文与图片落到 `agent_model_input` 附件。验证：`npm run build` 后 `node --test dist/test/agent-model-input.test.js dist/test/agent-host.test.js dist/test/agent-session-lifecycle.test.js dist/test/session-compact.test.js`。理由见[模型输入重建](../decisions/accepted/2026-09-08-model-input-reconstruction.md)。旧日志缺正文的只读解释属 M1.4。

### M1.4 历史兼容与只读重开

1. 为新格式设置明确版本，区分可读旧格式、未知版本和损坏记录。旧日志缺少正文时显示“该记录未保存完整内容”，不能补写推测过程。
2. 优先非破坏性的旧格式只读适配；如必须迁移磁盘数据，先明确备份、原子发布、幂等和失败恢复，再实施，禁止启动时无提示重写全部历史。
3. 新旧格式的读入口不实例化 provider、Runtime 或原产品插件。历史只读过程不产生费用、消息重发或候选启动。
4. 崩溃后只能依据已提交事实显示中断或未知；不凭锁文件/PID 存在与否推导候选已停止。

出口：杀掉写进程后，新进程可读取提交前缀；未知格式明确失败；旧历史仍可读其已保存内容。对应 A7、A8、A18。

**完成（2026-09-08）。** History 只读 `events.jsonl`：缺正文显示固定缺口文案；未知信封/正文版本失败；旧 `session_completed` 只读解释为当时请求结束。崩溃无 record 时按已提交事件显示 interrupted/unknown，不读 lock/PID，不加载 Pack。验证：`npm run build` 后 `node --test dist/test/agent-model-input.test.js dist/test/agent-history-read.test.js dist/test/local-history.test.js dist/test/widgets.test.js dist/test/architecture.test.js`。理由见[历史只读](../decisions/accepted/2026-09-08-history-readonly-compat.md)。

## 4. M2：harness、Recovery、封存场景与运行生命周期

### M2.1 收拢业务所有权

1. 沿恢复、候选创建、运行、清理链确定每个副作用的唯一所有者，复用现有工具和环境 helper。
2. 通用执行只负责模型请求和结构化结果；恢复接受、候选投递、报告发布归应用/harness。不要为这些操作增加统一业务 Verifier 接口。
3. 工具按角色最小权限注入：Recovery 只写恢复副本；Controller 只读证据与候选结果；Comparison 只写本次 attempt 目录。
4. 参数和磁盘输入在边界校验；路径校验考虑真实路径、链接、大小写及写入时目标变化，不用简单字符串前缀判断目录包含关系。

出口：越界写、源目录修改、非法工具参数、秘密内容在边界被拒绝或遮蔽；原有隔离和恢复调查有效测试继续成立。对应 A10。

**完成（2026-09-08）。** 角色写权限留在 application：Controller 只读，Comparison 只写本次 attempt 的 `scratch` 第一段、计划文件与 `report.html`；不新增跨角色 Verifier。路径包含改用 `pathContainedBy` / `relativeInside`，写入后再 `realpath`。验证：`npm run build` 后 `node --test dist/test/comparison-report.test.js dist/test/experiment-inspection.test.js dist/test/controller-briefing.test.js dist/test/architecture.test.js dist/test/recovery-tools.test.js`；随后 `npm run check` 通过。理由见[角色副作用所有权](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)。

### M2.2 Recovery 连续 Session 与停止语义

1. 一次准备创建一个 Recovery Session；调查、业务反馈和可修复输出在同 Session 中继续。
2. 保留原有恢复证据、变更调查和验证能力，删除仅为统一架构命名而存在的桥接层，不因为简化设计删掉有效保护。
3. 证据不足保存原因、调查过程和诊断，返回不可执行结果；所有 CLI/TUI 路径均不能强行接受。
4. 可修复结构问题与真实证据缺失分开：前者有界修复，后者停止，不用循环请求伪造证据。

出口：充分证据生成场景；不足证据、工具失败、取消分别有终态记录，无可运行场景泄漏。对应 A2、A5、A7。

**完成（2026-09-08）。** Recovery 按 `continuityKey` 复用 Pi Session；信封修复同 Invocation；不足证据停止就绪循环、诊断 failed、不暴露 `accept`。TUI/CLI 无 current-state fallback。验证：`npm run build` 后 `node --test dist/test/recovery-envelope.test.js dist/test/codex-experiment-recovery-effort.test.js dist/test/recovery-user-status.test.js dist/test/tui-workflow.test.js dist/test/architecture.test.js`；随后 `npm run check` 通过。理由见[Recovery 连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)。

### M2.3 场景封存与重复运行

1. 把冻结 TaskCase、恢复结果、必要文件、起点与来源 provenance 作为可独立读取的场景输入，定义封存发布边界。
2. 先完成文件与 manifest 校验，再发布可运行身份；半成品不能出现在可选场景列表中。
3. 场景封存后不可修改。每次 run 使用新 ID、新工作副本和相同起点指纹；候选变化不能污染封存内容或其他 run。
4. 运行不重新从原会话目录推导起点；移走来源目录仍能使用完整封存场景。
5. 候选结束时封存可供对照的结果输入；快照未完成要明确标识，不能读活动目录冒充终态快照。

出口：同场景两次模拟运行初始指纹一致且写入隔离；封存中断、指纹不符、缺文件均拒绝运行。对应 A17。

**完成（2026-09-08）。** 封存 baseline 在 `prepareRun` 后保留；源目录缺失只读封存 fingerprint。`case.complete` 才进入可选列表。对照挂 `snapshots/{runId}`，incomplete 不挂活动 run 目录。验证：`npm run build` 后 `node --test dist/test/scene-seal.test.js dist/test/environment.test.js dist/test/local-history.test.js dist/test/comparison-report.test.js dist/test/experiment-inspection.test.js`；随后 `npm run check` 通过。理由见[场景封存与重复运行](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md)。

### M2.4 CandidateRun 与活动所有权

1. 复用状态机与 CandidateRun，把状态写入从 UI 回调剥离；执行生命周期先持久化决定，再进行候选投递。
2. 保留 accepted/rejected/unknown 的协议语义和 settlement 证据，未知投递不可重发。
3. 为 prepare/run/compare 建立可查询的操作身份和实验写锁所有权；精确操作 ID、实验 ID、run ID 的区别必须在 CLI 输出及取消解析中明确。
4. 本批实现进程内统一取消与收尾，M6 再接 IPC。取消请求与最终取消分开，晚到模型/Runtime 事件不能改写终态。
5. 同实验同一时间只有一个写操作；不同实验不被全 dataDir 锁串行化。异常关闭保留事实，不自动夺锁或接管。

出口：启动失败、未知投递、取消等待、自然完成与取消竞态、清理失败均保留独立事实。对应 A9、A15 的应用侧前提。

**完成（2026-09-08）。** CandidateRun 先持久化再投递；未知投递不重发。进程内 `operationId`/`experimentId`/`runId` 可查询；`reprise cancel` 解析三类 ID 且不夺锁。取消请求与终态分开；晚到 settlement 不改写终态。实验目录写锁不自动回收。验证：`npm run build` 后 `node --test dist/test/candidate-run.test.js dist/test/store.test.js dist/test/experiment-activity.test.js dist/test/cli.test.js`；随后 `npm run check` 通过。理由见[CandidateRun 活动所有权](../decisions/accepted/2026-09-08-candidate-run-activity-ownership.md)。

## 5. M3：Controller 单 Session 与用户协作行为

### M3.1 合并首次理解与 opening

1. 从实验入口移除独立 understand 调用，将必要历史、用户目标与来源事实直接提供给首次 Invocation。
2. 首次 Invocation 在本 run 的 Controller Session 内调查并形成 opening；后续调用继续同一 Session，只追加真实新事实。
3. 删除强制 Understanding 输出、账本更新、基于账本/read 操作的 done 拒绝与对应反馈循环。逐一搜索 schema、prompt、应用调用、事件消费者和测试，避免删除入口后留下隐性约束。
4. 保留必要的输入准备、证据引用、权限和结果校验，不把取消“强制 briefing”误解成不再准备模型输入。
5. 旧记录里的理解/账本事件仍可只读展示，但新路径不再生成它们；不要为历史兼容重新运行旧策略。

出口：模拟调用计数证明没有理解前置请求；opening 与后续 send/done 属于同一 Session；旧字段不再影响新运行停止。对应 A2、A3、A12。

**完成（2026-09-08）。** 实验入口只 `decide`；首次 Invocation 在本 run Controller Session 内调查并 opening。新路径不写理解账本、不以 unread/ledger 拒绝 `done`。验证：`npm run build` 后 `node --test dist/test/controller-full-session-judgment.test.js dist/test/codex-experiment.test.js dist/test/controller-briefing.test.js dist/test/snapshots.test.js`；随后 `npm run check` 通过。理由见[opening 同 Session](../decisions/accepted/2026-09-08-controller-opening-single-session.md)。

### M3.2 验证协作语义和投递边界

1. prompt 区分历史用户要求、历史 agent 发现和当前候选事实；历史消息不是顺序重放队列。
2. 保留原用户授权与风险边界，按原用户习惯协作和停止；不把“所有历史句子都发送了”作为完成条件。
3. 模型输出的实际消息先记录，再按唯一消息身份投递；取消或未知响应不得重复发送。
4. 记录策略/prompt 版本、输入、实际干预和用量，确保不同候选不共享 Controller 轨迹。
5. 用现有 Controller 评估素材选择有代表性的样例：已满足用户、尚需核验、无继续价值、授权不足、历史 agent 结论不可信。结构测试与人工语义评估分别报告。

出口：机械验证执行/投递协议，人工记录协作与停止是否合理及局限；不得声称模拟测试证明模型语义等价。对应 A3、A7。

**完成（2026-09-08）。** briefing 区分三类事实；决策先落盘再投递；`promptDigest` 入快照；不同 run 不共享 Session。合同 lane 覆盖五类样例且与真实模型 lane 分报。验证：`npm run build` 后 `node --test dist/test/controller-collaboration-protocol.test.js dist/test/controller-capability-evaluation.test.js dist/test/candidate-run.test.js dist/test/codex-experiment.test.js dist/test/snapshots.test.js`；随后 `npm run check` 通过。理由见[协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)。

## 6. M4：Comparison 单 Session 与独立执行

1. 从应用对照入口梳理规划、调查、报告生成及修复；一次 attempt 只创建一个 Comparison Session，内部可多次 Invocation。
2. 取消 Planner/Reporter 双 Session 的强制要求及只为其服务的产物转换。保留确有价值的调查与计划内容作为同 Session 上下文。
3. 输入只能来自冻结历史、终态运行事实及封存结果；活动 run、未完成快照或不支持的历史格式明确拒绝。
4. 对照入口不依赖原运行进程、内存 RecoveryAttempt、活动 Runtime 或原插件。重开应用可选择历史 run 发起新 attempt。
5. 每次 attempt 有独立目录、Session 与发布结果。失败/取消不能覆盖此前成功报告；输出修复在同 Session 内完成。
6. 报告区分任务结果、协议/恢复限制与配置差异，不把不同产品、工具或策略的差异归因于纯模型能力。

出口：结束原进程后独立对照成功；重复 attempt 隔离；损坏快照、取消、报告写失败不发布成功结果。对应 A2、A4、A7、A17。

**完成（2026-09-08）。** 每次 attempt 一个 Comparison Session；应用只 `compare()`；计划文件是同 Session 笔记。对照读封存快照与已提交事实，候选结束后 `runComparison` 可独立发起。失败/取消不覆盖成功 `report.html`。验证：`npm run build` 后 `node --test dist/test/comparison-agent-phases.test.js dist/test/codex-experiment.test.js dist/test/comparison-report.test.js dist/test/scene-seal.test.js dist/test/snapshots.test.js dist/test/architecture.test.js dist/test/agent-host.test.js`；随后 `npm run check` 通过。理由见[单 Session 对照](../decisions/accepted/2026-09-08-comparison-single-session.md)。

## 7. M5：共用 Workflow、完整 CLI 与键盘 TUI

### M5.1 提取与界面无关的应用操作

1. 以现有 workflow 为起点，将配置/来源查询、准备、场景运行、历史/事件查询、对照、取消请求接入明确的应用函数。
2. 完整 run 直接组合 prepare 与场景运行，分步入口调用同一函数。TUI 只负责收集选择和消费事件；CLI 不模拟按键，不加载 TUI 组件。
3. TUI 在恢复可用后选择候选；非交互 CLI 可以提前指定候选，但封存完成前不能启动候选。
4. 去掉只在 TUI 内生效的默认策略、错误判断和成功判定，迁到正确应用所有者。命名去产品化只在实际调用链切换时进行。
5. 现有 CLI 参数的兼容/弃用在实现时明确记录；不能静默把旧参数解释为不同实验动作。

出口：同输入的 CLI/TUI 调用同一应用路径；模拟完整与分步执行得到一致的领域结果。对应 A13。

**完成（2026-09-08）。** `prepareExperiment` / `runPreparedExperiment` / `runFullExperiment` 为 CLI 与 TUI 共用；完整 run 先 prepare 再同一 scene-run。候选启动守卫在 application；`start` 在已有 recoveryAttempt 时执行该守卫。无子命令仍开 TUI；`prepare`/`run`/`compare`/`cancel` 不静态加载 TUI。验证：`npm run build` 后 `node --test dist/test/experiment-operations.test.js dist/test/cli.test.js dist/test/architecture.test.js dist/test/tui-workflow.test.js`；随后 `npm run check` 通过。理由见[共用实验操作](../decisions/accepted/2026-09-08-shared-experiment-operations.md)。

### M5.2 CLI 查询、配置与机器协议

1. 先实现帮助、产品/模型/项目/会话查询、内部配置、认证状态与历史查询，再连接有副作用命令。具体参数和错误码在实现代码定义，文档只给经过验证的示例。
2. 查询提供稳定身份与分页信息；来源产品和候选产品独立，歧义来源用 sourcePath 精确指定，不能用标题或列表下标操作。
3. 配置复用与 TUI 相同的校验、保存及 provider 目录。密钥不作为命令行参数，不回显；确需交互的登录流程明确声明，非交互模式缺信息立即报错。
4. prepare 返回封存场景或清晰失败；run 支持来源与已有 scenario 两条互斥输入；compare 支持历史终态 run；事件查询支持按序号续读。
5. 实现互斥的 JSON 单结果与 JSONL 事件流。机器 stdout 只写协议数据，诊断到 stderr；正常事件流有终态，异常 EOF 不等于成功。
6. 明确稳定错误分类及退出码，区分查询命令成功和所查询实验失败。未知 ID、能力缺失、配置缺失、冲突、取消和超时有不同可识别结果。
7. ID 一经持久化便应在活动输出中可发现，方便另一终端查询/取消；JSON 单结果模式也要有无污染 stdout 的发现途径。

出口：真实子进程运行 CLI，覆盖无 TTY、stdout 管道、错误 stderr、退出码、分页和事件续读；全流程不要求打开 TUI。对应 A13、A14。

**完成（2026-09-08）。** 查询子命令与 `--json`/`--jsonl` 互斥协议；来源用 `--source-path`；`run` 的 source 与 `--scenario` 互斥；`compare --experiment` 对照终态 run；密钥不进 argv。验证：`npm run build` 后 `node --test dist/test/cli.test.js dist/test/cli-protocol.test.js dist/test/architecture.test.js dist/test/experiment-operations.test.js`；随后 `npm run check` 通过。理由见[CLI 查询与机器协议](../decisions/accepted/2026-09-08-cli-query-config-protocol.md)。

### M5.3 TUI 选择与配置流程

1. 首页实现目标规定的少量斜杠入口，键盘补全与确认；提示当前按键，不设计网页式按钮工具栏。
2. 配置使用字段列表与编辑草稿，应用/撤销、校验保存和未保存离开明确；内部模型与候选产品模型名称分清。
3. 来源按产品→项目→会话→起点核对。03a 宽屏左列表右详情，列表支持大量项目、项目名/路径筛选和分页；窄屏上下排列。
4. 03b 支持会话筛选及摘要，核对起点之后才确认准备。空列表、无匹配、无权限和读取失败分开，不能把摘要截断当作不可恢复。
5. 切换页面保留筛选/选中位置。空匹配禁止确认，IME 输入不被快捷键截断。

出口：只用键盘可完成配置、来源选择、准备、候选选择、运行和结果查看；大量项目及窄屏均可操作。按 TUI 验收。

**完成（2026-09-08）。** 首页只接收斜杠命令；配置 Ctrl+S/Ctrl+T 与未保存离开确认；列表可打印输入筛选，Ctrl+F/N/R 为目录动作；切层保留筛选与选中；空匹配、无历史、无权限、读失败分文案。验证：`npm run build` 后 `node --test dist/test/page-input.test.js dist/test/config-editor.test.js dist/test/intake-ui.test.js dist/test/product-first-intake.test.js dist/test/widgets.test.js`；随后 `npm run check` 通过。理由见[TUI 选择与配置按键](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)。

### M5.4 单实验连续时间线

1. 统一 Recovery、Controller、候选执行、结束与 Comparison 的记录来源，按持久化顺序呈现；阶段变化不替换整页历史。
2. 保留公开进度/发现；工具与长篇公开摘要分别折叠，最新活动突出；实际模拟用户发送消息醒目显示，之后追加候选公开活动。
3. 插件只输出通用活动数据，宿主布局。实时规范化活动必须可持久化供历史读取，不能重开时必须加载原插件才能翻译。
4. 内联展开命令、有限输出和相关文件；完整长文件/diff 留给编辑器，原始事件在更深入口。不生成模型未公开的推理。
5. 结果继续追加在原记录中，区分任务判断、终止和清理。提供独立对照与真实本地产物路径，不用“取消已接收”冒充结束。

出口：实时与重开投影一致，未知活动有通用降级，原插件缺失仍可读。按 TUI 验收及 A8、A18。

**完成（2026-09-08）。** 候选启动不清空时间线；单列连续记录；`runtime.public_activity` 经 schema 校验后持久化；TUI 不加载 Pack；thinking 不进主列；任务/终止/清理分条可见；对照门叠在时间线；历史实验只读 `events.jsonl`。验证：`npm run build` 后 `node --test dist/test/timeline.test.js dist/test/public-activity.test.js dist/test/architecture.test.js dist/test/widgets.test.js dist/test/codex-intake-commands.test.js`；随后 `npm run check` 通过。理由见[公开活动持久化与单列时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md)。

### M5.5 阅读、搜索与终端交互

1. 滚动以稳定条目身份保存阅读锚点；追加、折叠、缩放和分页不抢位置。向上阅读暂停跟随，End 返回最新。
2. 实验内搜索覆盖已记录可见消息与活动标题，含折叠及未加载页；不默认搜索长工具输出或原始事件。明确与首页命令、列表筛选的按键上下文区别。
3. v 阅读/选择模式关闭鼠标报告并暂停视图重绘，后台持久化继续；退出后提示新活动。普通输入、搜索和编辑态处理冲突键。
4. 本地链接使用受验证路径和正确 file URI 编码，支持 OSC 8 则输出链接，否则显示完整可复制路径；清除不可信终端控制序列。
5. 异常退出也恢复终端模式。真实鼠标、IME、修饰点击、缩放验证留给 M6，不把 HTML 原型作为证据。

出口：假终端/事件回放验证锚点、键盘、搜索和选择模式；更新相关 TUI 帧并审阅差异。按 TUI 验收。

**完成（2026-09-08）。** 阅读锚点用 `itemId`/`sequence`；查找不扫 `original`；`v` 关鼠标报告并暂停重绘；`fileLink` 按 OSC 8 能力输出；真实终端异常路径 `tui.stop()`。ADR：[阅读锚点、搜索与终端恢复](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)。

## 8. M6：跨平台本机控制与可扩展 Pack

### M6.1 明确原生平台语义

1. 核对实际 shell 选择，Windows 默认 PowerShell，macOS/Linux 默认 Bash；不继续无条件继承用户 SHELL，不要求 Windows 安装 Bash。
2. 用现有进程 helper 统一 argv、cwd、环境和取消；区别执行文件与 shell 文本，禁止以字符串拼接跨 shell 运行路径。
3. 测试空格/中文/盘符、大小写、只读权限、符号链接、缺 shell 和子进程树。WSL 使用 Linux 本机路径，不混用宿主 Windows 产品。
4. 取消涵盖模型、工具进程与 Runtime 子进程；超过收尾时限保存清理失败或未知事实，不能显示全部清理成功。

出口：三个系统的模拟流程与进程清理有独立证据；运行环境不可用时报告能力不足，不静默换语义。对应 A9、A11。

**完成（2026-09-08）。** Windows PowerShell、macOS/Linux `/bin/bash`，不读 `SHELL`；`shell: false` 与 POSIX 进程组；WSL 拒绝宿主 Windows 路径；`stop` 超时 cleanup 为 `unknown`。ADR：[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。

### M6.2 跨终端 cancel

1. 活动所有者启动本机端点，Windows 用受限命名管道，POSIX 用私有目录 Unix socket。先验证权限实现，不允许未鉴权 TCP 回退。
2. 控制记录关联精确操作及 owner 实例；认证材料只存在受限本机存储，不进入普通事件、JSON 输出或报告。验证协议版本、请求长度和身份。
3. cancel 客户端读取目标并发送请求；实际取消和写终态由 owner 执行，客户端不写实验事实、不删锁、不按历史 PID 杀进程。
4. 请求绑定当前操作，不能在 prepare 结束后漂移取消下一 run。重复请求幂等，自然完成竞态返回真实已知终态。
5. 有界等待区分已接收、已结束与未知；端点不可达、过期、认证失败或 PID 复用不能触发接管。只读观察者退出不取消 owner。
6. 确保同实验 compare 与其他写操作冲突时拒绝，不同实验可独立执行。

出口：用两个真实本机进程取消 CLI/TUI 的 prepare/run/compare；额外覆盖错误 owner、过期记录、断连、重复、自然结束、清理超时和权限拒绝。对应 A15；此时才能关闭 M5 的跨终端前置缺口。

**完成（2026-09-08）。** Windows 命名管道 / POSIX Unix socket；token 不进事件与 JSON；客户端不删锁、不杀 PID。ADR：[跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md)。

### M6.3 版本化本地插件边界

1. 从现有 Pack 和 Runtime 契约提炼最小公共 API。新增 Runtime 能力先改端口再改两个内置 Pack；不要暴露整套宿主内部文件。
2. 分开导入与运行能力，使 import-only/runtime-only 插件可以独立使用。产品安装、认证和模型目录按所需能力检查，不误阻塞纯导入。
3. 在应用组装时加载显式配置的 JS、编译后 TS 或已安装包，定义路径相对基准和稳定包解析方式；不执行原始 TS、不下载或热加载。
4. 校验导出、API major、productId 唯一性及能力组合；逐插件显示可理解诊断，禁止忽略异常或静默替换重复身份。
5. 内置 Pack 与外部 Pack 走同一 registry 和契约。CLI/TUI 只消费能力，不增加产品名 switch。
6. 将历史只读与插件初始化分离；缺包、导入异常不能阻止无关历史查看。可信插件是同进程代码，不承诺能隔离其挂起或恶意行为。

出口：重复身份、不兼容版本、错误导出及单能力插件有验证；现有两个产品行为保持成立。对应 A16、A18。

**完成（2026-09-08）。** `{dataDir}/plugins.json` 加载 JS/已安装包；`apiMajor` 与 `import`/`runtime` 能力；重复身份保留先注册者。ADR：[版本化本地 Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。

### M6.4 独立第三 Pack 与平台证明

1. 将现有 fake Pack 素材发展为独立测试包/本地模块，通过真实配置入口加载，禁止测试直接注入宿主私有对象绕开插件 API。
2. 在宿主代码不变的条件下运行发现、导入、模拟候选、活动显示和结果读取；对内置 Pack 跑同一契约验证。
3. 从打包后的产物验证公共导出和依赖能解析，避免只在源码仓库相对路径下工作。
4. 记录三系统终端版本与中文、IME、滚轮、拖选、链接、退出恢复证据。实际产品 smoke 按现有显式准入执行，没有环境或授权时保留缺口，不自行产生费用。

出口：第三 Pack 只需包与配置；平台模拟、真实终端、真实 Runtime 三类证据分别可审查。对应 A11、A16、A18。

**完成（2026-09-08）。** `reprise-third-pack` 经 `plugins.json` 加载；发现/导入/目录/活动/CLI/TUI 不注入 Pack。pack-api 从 dist 解析。三平台证据分层，macOS/Linux 真终端 IME 仍为缺口。ADR：[第三 Pack 与平台证据](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md)。

## 9. M7：旧实现删除、规范生效与交付

1. 搜索所有旧调用者和依赖：重复 Host/transcript 写者、独立理解、强制账本守卫、Planner/Reporter 双会话、UI 内业务编排、静态唯一注册及旧活动画布。按调用证据删除，不按名称误删有效 helper 或历史 reader。
2. 删除迁移适配器和失效配置，保留必要旧记录只读兼容；新写路径只能有一个版本和一个所有者。
3. 将实际生效行为写入 product/architecture，更新对应 ADR；部分生效不能整份废止旧 ADR。全部目标落地后再按生命周期移动目标 ADR。
4. 同步各层 AGENTS 的实际依赖规则、README 使用示例、打包导出和贡献文档。检查 CLI 不加载 TUI 的要求与导入门禁是否一致；修改门禁必须附能使其失败的自动化反向用例。
5. 审核秘密检查、路径边界、进程关闭、旧历史、第三插件、默认离线测试和平台声明，不能因重构删除原有有效防护。
6. 逐项核对 A1–A18 与 TUI 验收。缺少语义评估/真实终端或产品证据时明确未关闭，不能只凭单元测试绿灯宣布全面完成。
7. 完成后把实施过程证据留在 MASTER/PR，已结束的计划按文档生命周期退出活跃导航；稳定设计归当前规范，不永久维护两套正文。

出口：公开检出无需本机 HTML 即可理解、构建、运行和扩展；模拟路径、文档、打包与实际支持声明一致。对应 A12 及整体验收。

**完成（2026-09-08）。** 删除 `productId === "codex"` 无名根映射与 `stalled.controller_completion_guard`；无名根绑定第一个 import Pack 或显式 `pack`。README/AGENTS/`reprise/pack-api`/`plugins.json` 与支持声明一致。A1–A18 机械路径见 MASTER 核对表。**未关闭**：TUI IME/滚轮/拖选与 macOS/Linux 真终端；Controller 真实模型 lane 已跑、五族代表未匹配；Runtime smoke 未授权。目标 ADR 仍为 proposed。ADR：[M7 收口与未关闭验收](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。

## 10. 验证实施方式

### 10.1 命令与证据

命令定义以 [package.json](../../package.json) 和[工程门禁](../engineering-gates.md)为准。以下是在当前仓库可用的执行方式，后续若修改脚本须同步示例。

```powershell
# 只修改文档
npm run verify:docs

# 源码修改后，针对本批测试之前先构建
npm run build
node --test dist/test/agent-host.test.js

# 每个完成的代码变更按仓库约定运行
npm run check

# TUI 渲染变化时生成并审阅帧，随后检查
npm run audit:tui
npm run audit:tui:check

# 所有改动均检查格式问题
git diff --check
```

定向测试例子应换成实际受影响的构建产物；新增测试由执行 Agent 按语义命名，不提前建立空测试文件。本计划不维护现有测试全集。

### 10.2 优先验证的失败类型

| 边界 | 最小有效验证方式 |
|---|---|
| Session | 模拟 provider 多轮调用，检查实际输入与持久化重建相同 |
| 存储 | 在提交边界注入失败，新进程只读重建，成功不得提前发布 |
| 恢复/隔离 | 临时目录内包含越界路径与链接，证明原始来源不被修改 |
| 投递 | Runtime 返回 unknown/晚到事件，证明没有重复消息或终态改写 |
| 场景 | 两个独立副本和移走来源目录后运行，比较初始指纹 |
| 对照 | 终止原进程后创建新 attempt，输入快照不随工作目录变化 |
| CLI | spawn 实际入口，解析 stdout/stderr/退出码，禁用交互输入 |
| 取消 | 第二进程调用真实端点，覆盖 owner 过期与完成竞态 |
| 插件 | 从安装/本地编译产物加载第三包，不改宿主完成闭环 |
| TUI | 事件回放验证投影，假终端验证按键，真实终端验证选区/IME |

### 10.3 验收证据归属

| 目标编号 | 主要实施步骤 |
|---|---|
| A1 | M1.1 |
| A2 | M1.2、M2.2、M3.1、M4 |
| A3 | M3.1–M3.2 |
| A4 | M4 |
| A5 | M2.2 |
| A6 | M1.2–M1.3 |
| A7 | M1.3、M2.4、M3.2、M4 |
| A8 | M1.4、M5.4 |
| A9 | M1.2、M2.4、M6.1–M6.2 |
| A10 | M1.3、M2.1 |
| A11 | M6.1、M6.4 |
| A12 | 各批同步、M7 |
| A13 | M5.1–M5.3 |
| A14 | M5.2 |
| A15 | M2.4、M6.2 |
| A16 | M6.3–M6.4 |
| A17 | M2.3、M4 |
| A18 | M1.4、M5.4、M6.3–M6.4 |
| TUI 验收 | M5.3–M5.5、M6.4 |

此表只映射实施位置，不复制验收语义或记录通过状态。完成证据写 MASTER。

## 11. 暂停、回退与下一 Agent 交接

遇到 provider 能力缺口、无法兼容的磁盘格式、平台权限无法满足或需要扩大产品范围时，保存调查证据和最小复现，说明受影响步骤。能独立推进的已授权步骤继续完成；不得偷偷增加 daemon、恢复执行或不可信插件隔离来绕过问题。

每批回退只撤销该批可识别的代码/配置改动，不删用户实验目录，不覆盖用户修改，不把已写新格式伪装成旧格式。写入新格式前必须有可读策略；降级运行应拒绝不支持的写入，保留原始数据。未经请求不使用破坏性 Git 命令恢复工作区。

交接信息保持简短且可执行：当前 M 步骤、已经切换的入口、仍在使用的适配器、实际验证结果、未关闭风险、下一条具体动作。不要用“基本完成”“只剩测试”代替证据；源码接通但验证未完成的步骤继续保持未关闭。

执行 Agent 的第一步是 M1.1：重新检查工作区与已安装 Pi 能力，确认唯一 Session 事实源及基线。不要从批量重命名目录、重画界面或删除所有旧测试开始。
