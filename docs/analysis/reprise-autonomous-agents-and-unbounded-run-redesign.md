# Reprise：自主 Agent、无总预算运行与自由证据产物讨论稿

日期：2026-08-12
状态：讨论稿；本文确定修改方向，不直接改动实现。

## 结论与既定方向

上一版讨论把“受控访问”和“专用工具/完整 JSON 输出”绑在了一起，这是错误的。Reprise 的目标是让 Agent 在隔离且可审计的环境中自主工作，而不是把 Recovery 和 Comparison 变成填表器。

本轮应修正的不是“让 Luna 更好”，而是让 Harness 如实运行、如实归因，并让 Recovery 与 Comparison 用自然的 Agent 工作流处理证据。以下方向已由既有架构和本轮要求确定，不再作为产品决策反问：

- 本次候选应显示为 **未完成、证据有限**；不得把 10 分钟的 Harness 超时写成候选质量差。
- Candidate、Recovery、Controller、Comparison 默认均**不设总工作预算**。用户取消、原生 Runtime 结束、不可恢复的 Runtime 故障仍然有效。
- 内部 Agent 优先使用隔离工作目录中的 **shell 与基础文件能力**（列目录、搜索、读取、受限写入、运行已有检查）。只有基础能力无法安全或确定性完成时，才增加一个窄的专用工具；不预先建立 tool catalog、语义检索、任意路径工具或展示框架。
- Recovery 和 Comparison 的主要交付是可读、可审计的自由文本产物（Markdown）；不要求模型返回完整 JSON。宿主保留必要的确定性事实、操作审计和极少机器元数据，不能把它们误称为 Agent 的完整结论。
- Controller 是状态机的驱动者，保留最小机器可读的 `send | done | stop` 决策信封；其给用户的消息和理由仍是自由文本，且可以主动读取证据。
- 三个内部 Agent 都应有完整职责与主动调查空间。输出协议只服务宿主的边界和生命周期，不压缩其判断能力。
- Agent 自由文本和报告固定标签均默认跟随 `TaskCase` 初始任务的主要语言。
- 产品决定以 `docs/architecture/` 与 `docs/product/` 的既有设计为准；实现只补齐偏差，不新造评分体系、向量库、MCP 服务或通用 Agent 框架。

相关既有设计：[Comparison](../architecture/comparison.md)、[Controller 实验条件](../architecture/controller-experiment-conditions.md)、[运行结果](../architecture/run-outcome.md)、[TUI](../product/tui.md)。本次真实运行的事实见[前一份复盘](reprise-real-run-analysis-and-report-redesign.md)。

---

## 1. 运行归因：候选未完成，不等于候选表现差

### 已发生的事实

本次 `run-60f7fa06-1ea8-494f-8d98-49b3a7e7da3a` 中，Candidate 在第一轮继续进行 METR 资料检索时被中断：

1. trace `seq 953` 仍显示 Candidate 在执行；
2. `seq 956` 记录 `run.stop_requested`，代码为 `limit.turn_timeout`；
3. `seq 960` 的 Codex turn 以 `interrupted` 结束，耗时 `599998ms`；
4. 之后才有 `seq 968 controller.started`，且不存在 `controller.decision`。

正确因果链是：**TUI bridge 注入了 10 分钟单轮上限，Candidate 未自然结算，Controller 从未得到可继续协作的 `waiting_input` 或正常结算点。** Controller 不是候选未完成的原因；本次也不能据此比较 Luna 与 baseline 的任务能力。

`RunOutcome.task.status = not_assessed` 已表达“没有形成有效任务判断”。报告还应将 `termination = limit.turn_timeout` 和“证据有限”并列展示，不能渲染为失败、较差或隐含排名。

### 根因

`src/application/codex-tui-workflow.ts` 当前无条件传入：

```ts
{
  wallClockMs: 30 * 60_000,
  maxTargetTurns: 4,
  maxModelCalls: 3,
  turnTimeoutMs: 10 * 60_000,
  heartbeatTimeoutMs: 60_000,
  maxConsecutiveNoProgress: 1,
}
```

其中 `turnTimeoutMs` 直接造成这次中断；其余墙钟、turn、模型调用和无进展阈值同样会提前停止正常推进的候选。

### 修改原则

1. 将 Target 的 `RunPolicy` 自动终止字段改为可选，生产 TUI 默认不填：`wallClockMs`、`maxTargetTurns`、`maxModelCalls`、`turnTimeoutMs`、`maxConsecutiveNoProgress` 均不再自动停止运行。
2. Candidate 正常等待由 Runtime 原生生命周期决定：收到 `waiting_input` 才交给 Controller；收到原生完成才结束；原生失败才记录 `failed.runtime`。
3. heartbeat 继续记录失联诊断，但不把仍有明确活动的长任务当作超时停止。Runtime 状态无法确认时进入已有故障或 `uncertain` 语义，不能伪造任务失败。
4. 保留用户显式取消、进程退出、不可恢复 Runtime 失败以及隔离/权限边界；不限预算不等于绕过安全边界。
5. 历史数据仍可展示 `limit.*`；新默认流程不再产生这些自动停止。未来若 UI 提供显式限制，必须记录为用户配置而非安全默认值。

这是一处共享根因修复：调整 `CandidateRunPolicy`、`CandidateRun` 和 TUI workflow 的默认装配，而不是用报告文案掩盖中断。

---

## 2. 工具模型：先给 Agent 一个受控 shell，而不是一串报告工具

成熟 Coding Agent 的价值不来自大量语义化工具名，而来自少量稳定原语：在明确工作目录中看文件、搜索内容、执行命令、读取输出、编辑文件，并将动作展示为可展开过程。Reprise 应采用同样的取舍。

### 基础环境，而非 Comparison 专用工作台

每个内部 Agent 拥有与职责相称的隔离目录和基础能力：

| Agent | 可见工作区 | 基础能力 | 写入范围 |
| --- | --- | --- | --- |
| Recovery | Harness staging 与恢复输入 | shell、文件搜索/读取、受限写入、执行已有恢复/检查命令 | 仅 Harness staging 和其工作笔记 |
| Controller | 原始会话的只读导出、当前候选 trace/artifact 的只读导出、自己的会话笔记 | shell、搜索、读取；必要时写自己的笔记 | 不写 Candidate workspace、不执行目标任务 |
| Comparison | baseline、candidate、trace、artifact、workspace scope 的只读导出和自己的报告目录 | shell、搜索、读取、标准 diff、受限写报告 | 仅自己的报告目录；不改实验事实 |

这里的“shell”不是任意主机 shell：Host 为每个 Agent 设置 cwd、只读/可写根目录、环境变量、网络和子进程策略，并审计命令、退出码、读取范围与输出截断。Agent 通过 `find`/`rg`/`cat`/`git diff --no-index` 或平台等价的基础工具完成探索；没有理由为了“读 trace”“列 artifact”“比较文本”各造一个专用 API。

稳定索引文件可作为普通只读文件放入工作区，例如 `transcript/index.json`、`trace/events.jsonl`、`artifacts/manifest.json`、`workspace-scope.json`。Agent 自己决定先看哪个、再打开哪一段。大文件由 Host 作确定性的按行/字节切片或只读投影，防止把无关原文塞进模型上下文；这属于文件系统边界，不是又一套模型工具。

### 何时才增加专用工具

只有基础 shell/文件能力无法满足且专用能力能**明显缩小权限或提高确定性**时才增加，例如：

- 二进制 artifact 的安全预览；
- 需要基于 content hash 的确定性结构化 diff；
- 必须跨受限存储读取、且不能安全投影为文件的事实。

新增前必须能回答：基础 shell 具体哪里不够、该工具比文件投影少开放了什么权限、如何审计。否则不加。特别地，不加入任意路径读取、任意 shell、写 Candidate workspace、GUI 自动化、网络浏览、向量搜索或“为报告准备”的一组虚构工具。

---

## 3. Recovery 与 Comparison：自由产物，不是完整 JSON

### 为什么全量结构化输出不合适

Recovery 的价值在于理解当前环境、做/建议最小恢复、核验结果并留下可追溯记录；Comparison 的价值在于探索过程和产物、自主判断哪些差异值得人看。它们都不是固定字段可以穷尽的任务。要求模型只返回 `status/proposedSteps/evidenceRefs` 或 `summary/observations/limitations` 会造成三个坏结果：

1. 模型被诱导填模板而不是调查环境或差异；
2. 任何不符合 schema 的有价值结论都会被丢弃，退化为 fallback；
3. Renderer 被迫假设所有比较都有同样的 section taxonomy，最终形成“运行账单”。

结构化数据应由 Host 从确定性来源产生：运行状态、终止原因、fidelity、模型身份、时间、命令审计、文件 hash、读取/写入范围和权限结果。Agent 的解释、恢复过程、比较叙事和取舍应保持自由文本。

### Recovery Agent

**职责。** Recovery 是隔离实验环境的恢复执行 Agent。它基于 staging、线索、环境指纹和已有 playbook，自主调查缺失条件，复用已有恢复命令/脚本，执行最小必要变更，并以实际命令和文件证据核验能够核验的部分。它可判断环境无法可靠准备，并停止升级猜测。

**产物。** Recovery 在自己的工作笔记/实验目录写一份 Markdown 记录，例如 `recovery.md`。内容不要求固定章节；自然应包括它实际做了什么、发现了什么、哪些检查通过/未通过、哪些限制仍在，以及对应的命令输出或文件路径。Host 另行持久化确定性 `RecoveryOutcome`（是否可启动、变更范围、命令审计、异常）供状态机使用，但不试图把自然语言报告解析成完整 JSON。

**提示词要点。**

```text
你是 Reprise 的隔离实验环境恢复执行 Agent。目标是让候选在授权的 staging 中尽可能接近原任务所需环境，并留下可审计的事实。主动检查提供的线索、环境和已有脚本；优先复用现有命令与配置，用最小变更恢复条件，并在允许的范围内运行直接相关的检查。不要猜测不可验证的状态，也不要扩大到用户原工作区或全局配置。将你的工作过程、实际证据、未解决限制和结论写入 Markdown；不必套固定章节。宿主会独立记录命令、文件变更和启动结果。除代码、命令、标识符和用户指定文本外，使用初始任务的主要语言。
```

Recovery 可以执行后的核验；先前“不得声称验证”的限制应删除。它不能擅自扩大权限、写用户原项目或把一次命令执行伪装成未发生的外部状态恢复。

### Comparison Agent

**职责。** Comparison 是只读的比较研究 Agent。它先自主看任务目标、baseline、候选过程、文件/工件、命令结果、限制与运行条件，再选出少量真正改变用户判断的差异。它不做隐藏 winner 评分，不需要凑足栏目，也不改写 Runtime/RunOutcome/fidelity 事实。

**产物。** Comparison 写一份 Markdown 报告，例如 `comparison.md`。内容自由：可以是叙事、按重要性组织的差异、简短表格、链接到 artifact/trace 的证据入口，或在证据不足时只说明不可比较的原因。要求的是每个实质判断能指向来源，而不是每段都塞入 `evidence` 数组。Host 将 Markdown、引用到的相对路径/稳定 event id、读取审计和确定性运行摘要一起保存；Renderer 原样安全渲染 Markdown，并在旁边固定呈现事实卡片。

**提示词要点。**

```text
你是 Reprise 的只读比较研究 Agent。目标不是填模板或选出赢家，而是自主调查 baseline、候选过程、工件、命令结果、运行条件与限制，写出少量最能改变用户判断的差异。先用基础 shell 和文件检索查看索引，再按证据需要深入。低价值的重复工具调用不要展示；完成机会不足、运行中断或任务为 not_assessed 时，明确它们是证据限制，绝不能推断为模型能力较差。每个实质判断要紧邻可追溯的文件、event id、命令输出或 artifact 引用；没有证据就不说。不得捏造事实、工件或数值，不得修改任务判断、终止原因或 fidelity。把报告写成面向用户的 Markdown，不必遵从固定章节。除代码、命令、标识符和用户指定文本外，使用初始任务的主要语言。
```

Comparison 可以自己选择只写一项差异，或者明确“本次不能比较”；报告的长度由证据决定，不由模板决定。

### Controller Agent

Controller 与以上二者不同：它必须让 orchestrator 知道要不要发送消息、发什么、或结束运行。因此只保留最小机器决策信封 `send | done | stop`，不要求更多 JSON 报告字段。它可以在信封中放自由文本消息和理由，并通过基础只读 shell 查看完整原始会话、自己的候选轨迹与导出证据。

**提示词要点。**

```text
你是 Reprise 的用户协作 Controller。目标是在不改变原用户目标、已知事实、偏好和权限的前提下，主动帮助当前候选推进任务。先理解原始会话、当前候选轨迹、环境/工件证据和你先前发送的消息；按需要在受控只读工作区中检索完整原始会话和证据。原会话是事实来源，不是照抄剧本。选择此刻最有价值的动作：继续、澄清、纠正、提供原用户本已知道的信息、要求验证，或在已满足、无进一步价值、需要真实用户决定时结束。不得执行目标任务，不得把后续发现说成原用户原本知道，不得虚构权限或权威。除代码、命令、标识符和用户指定文本外，使用初始任务的主要语言。最后仅返回宿主所需的 send、done 或 stop 决策信封；其中消息和理由保持自然语言。
```

不同 Candidate 只能读取同一不可变原始会话与自身轨迹，不能读取其他候选或 Comparison 结论。

---

## 4. Comparison 的展示：Agent 选内容，宿主固定事实

TUI 面向人，显示高信息密度时间线并渐进披露；Comparison 面向结束后的阅读，应比 TUI 能看更多原始证据，但不必把所有过程倒回用户面前。

最终 HTML 由两部分组成：

1. **宿主事实卡片。** 任务、模型身份、RunOutcome、终止原因、fidelity、时间、成本、环境和清理状态。这些由持久化事实确定性生成，不能被 Agent 篡改。
2. **Agent 比较正文。** 安全渲染 `comparison.md`；内容、组织方式、重要性排序和引用选择均由 Comparison 决定。用户可点击到原始 trace、artifact、workspace diff 和命令审计。

这使用户既能看见“候选在 10 分钟被 Harness 中断”的硬事实，也能读到 Agent 自主选择的解释；没有落入固定 `<li>`、`summary`、`limitations` 模板。若 Comparison 因 provider 故障未生成，页面显示明确的“比较叙事不可用”，仍展示宿主事实卡片，而不是伪造 fallback 比较。

---

## 5. 语言：模型文本与固定 UI 同时跟随任务

在 system prompt 中加入语言规则能解决 Recovery/Comparison Markdown、Controller 消息和理由，但不能解决 HTML 固定标签。当前 `src/report/comparison-report.ts` 固定输出 `lang="en"`、`Reprise comparison`、`Task`、`Baseline`、`Comparison`、`Candidate runs`、`Artifacts` 等英文。

最小正确方案：冻结 `TaskCase` 时从初始任务确定一次 `displayLocale`（优先已有语言 metadata；没有时做简单、确定性的主语言检测），并传入报告 projection。Renderer 用它选择 `<html lang>` 和固定标签；模型不控制页面壳。代码、模型名、状态码和 evidence id 保持原样。

初始任务为中文时，Agent 产物和报告均中文；任务为其他语言时同理。无需新增 locale 选择流程。

---

## 6. “不限预算”的完整含义

默认不设的是**自动终止的总量预算**：Candidate 的墙钟、turn、模型调用、单轮等待和无进展计数，以及三个内部 Agent 的调用数、token、成本，都不应在默认流程中结束工作。

仍然存在的边界必须准确区分：

- 用户随时可以显式取消；
- Runtime 原生 `completed`、`waiting_input`、失败、进程退出仍决定生命周期；
- Provider/网络暂时不可用时记录和恢复错误，不把通信阈值伪装成任务完成或模型失败；
- 单次 shell 命令可有非零退出码、输出截断和可中断的执行保护；这只记录该操作的事实，不构成总预算，也不应自动给正常 Candidate 判失败；
- 隔离 workspace、授权、隐私、artifact 范围和清理规则不因不限预算而放松。

配置和事件中应区分“未设置上限”与“用户明确设置且耗尽”；不要再用一个虚假的默认数字让 UI 显示“预计上限 30 分钟”。

---

## 7. 最小实施顺序与验收

遵循 Ponytail 原则，先修共享根因，再将已有 trace/artifact/store 投影为普通文件；不新建通用编排层、MCP、评分系统或工具框架。

1. **运行生命周期。** 令 `RunPolicy` 自动终止字段可选，删除 TUI 硬编码默认值；调整 `CandidateRun` 对长时间正常执行、原生等待和终止原因的处理。
2. **Agent 工作目录。** 复用现有隔离 workspace 与 artifact store，为 Recovery、Controller、Comparison 生成各自最小的 cwd、只读投影/可写报告目录与命令审计；先使用已有 shell/filesystem adapter。
3. **自由产物与 prompts。** 删除 Recovery/Comparison 的完整 JSON schema 依赖及“schema 不合即丢弃”fallback；改为保存 Markdown 产物和 Host 事实。Controller 仅保留状态机需要的最小决策信封。更新三个 prompt。
4. **报告与语言。** Renderer 固定呈现事实卡片并安全渲染 Comparison Markdown；在 `TaskCase`/projection 传递 locale，替换英文壳。
5. **真实复跑。** 用同一会话在默认无限制配置下完整运行，避免人为停止；检查 Recovery 实际操作与记录、Controller 在原生 `waiting_input` 后的 decision，以及 Comparison 的证据引用与自由组织。

验收不以“某模型胜出”为条件，而以事实链正确为条件：

- 正常运行超过 10 分钟不会出现默认的 `limit.turn_timeout`；
- Recovery 能在授权 staging 中用基础命令恢复并记录实际证据，不再被 JSON 模板限制；
- Controller 只在 Candidate 原生可交互边界介入，并可在只读工作区访问完整原始会话；
- Comparison 能使用基础 shell/文件自主调查，生成可读 Markdown；实质判断均可追溯，且不要求固定栏目；
- `not_assessed` 被渲染为未完成/证据有限，不附会成质量结论；
- 中文任务生成中文 Agent 产物、中文 HTML 标签和正确 `lang`；
- 没有新增依赖、MCP、任意主机路径读取、任意网络浏览、全量 transcript 注入或全局配置写入。

## 8. 本轮讨论的收束

上述不是待定产品方案，而是根据现有设计和本轮要求应实施的修正。后续讨论应集中在已有 shell/filesystem adapter 的权限模型、工作目录投影形式，以及真实复跑后的证据质量；不再回到“是否固定 Comparison 模板”“是否让 Recovery/Comparison 只交 JSON”或“是否默认设预算”的已决问题。
