# 规划：Controller 源码审查后续修改

本文件是实施目标，不是当前规范。审查对象是已经落地的 Controller 主链路：[`experiment-controller-loop.ts`](../../src/application/experiment-controller-loop.ts)、[`controller-agent.ts`](../../src/agents/controller-agent.ts)、[`controller-briefing.ts`](../../src/application/controller-briefing.ts)、[`controller-queries.ts`](../../src/application/controller-queries.ts)、[`recovery-workspace-tools.ts`](../../src/infrastructure/recovery-workspace-tools.ts)。全面重构叙事仍见 [Controller 全面重构](./controller-full-refactor-plan.md)；本文只覆盖审查后仍与代码、文档或实验语义冲突的点。

当前规范仍以 [Controller 设计](../architecture/controller.md)、[实验条件](../architecture/controller-experiment-conditions.md) 和 accepted ADR 为准。规范与代码冲突时，以本文件列出的代码证据为准去改规范或改代码，不能把审查意见直接写成已生效能力。

## 完成判据

- 工具面：模型看到的工具名集合等于本轮真正可执行的集合；禁用的工具不出现在 schema 里。
- `edit` / `write` / `shell_exec` 的取舍有一份 accepted ADR，并与 `allowWrite`、`allowShell`、briefing `permissions.txt`、system prompt、架构测试同一变更落地。
- 若开放 `edit`/`write`：只作用于 `project/`（隔离副本），briefing / 事件日志 / Host 快照仍由 Host 写入；每次写入进入 Controller 用户操作审计，结果中可区分 Target 修改、Controller 修改、用户原始环境已有内容。
- `shell_exec` 默认不注册。若未来增加「用户在终端执行命令」实验模式，必须单独 opt-in，并把命令、网络迹象、文件变化记为 user-side intervention。
- 连续 Session 下，本轮 `changedPaths`、`requestId` 与 evidence callback 使用当前 request 的数据，不捕获 opening 闭包。用测试钉死：opening 后第一轮 steering 读取 `project/<本轮 changed path>` 必须能生成 `controller_observation`。
- opening 历史读取与 steering 候选观察的 evidence 语义写进规范：要么历史 `read` 产生 request-scoped evidence，要么明确 opening 不要求引用这些读取。
- `SteeringContext.historicalUserTurns` 与 briefing `history/user-inputs/` 不再双重来源：删除字段，或从 `TaskCase.transcript` 填充并写明是否进入模型输入。
- Host snapshot 中的 `current.summary` / `trajectory.summary` 不比 `current-user-view.md` 多出判断性工作区事实，或降级为不进模型可见输入的 Host 内部数据。
- `allowModelText=false` 的隐私边界写清：关闭的是正文，还是连会话结构（id、role、bytes、顺序）一起关。
- `ControllerAgent.release` 在 loop 结束路径上可等待 session close，审计事件与 run outcome 顺序稳定。
- `permissions.txt` 标明历史推断或改为当前 runtime launch config 快照。
- `npm run check` 通过。同批更新实验条件 §4、[validation Capability](../architecture/validation.md)、相关 ADR。

## 不在本批

- 重做 Pi Session / 结构化输出 / opening 先理解再 `send` 的主链路。
- Comparison、Recovery 的工具面（只在三角色工厂契约被改时做最小同步）。
- 容器级隔离、语义沙箱、未来信息检测、第二审查 Agent。
- 为「相信模型智力」而放开 briefing 目录写入或 CandidateRun 状态机。

---

## 审查总判

主链路成立：每个 CandidateRun 独立 Session；opening 在 `created` 上先 `work` 再结构化 `send`；steering 只在 `awaiting_controller`；briefing 在 replica 外；`project/` 只读挂载隔离副本；发给候选的唯一用户输入仍是信封 `message`；evidence ref 有 run ownership 检查。

下面十条是文档、工具面、数据模型和硬边界之间的缝，不是状态机写错。

实施前必须拍板的实验语义：

> Controller 是「模拟真实用户协作」，还是「测量候选独立完成任务」？

该选择决定 `edit`/`write` 是否进入工具面。`shell_exec` 两种目标下都建议默认关闭。在 ADR 落地前，代码保持现有工厂调用，不把讨论稿当成已授权能力。

---

## 1. 工具面：共享七件套、注册集合、有效能力三层不一致

### 代码事实

工作区工厂 [`recoveryTools()`](../../src/infrastructure/recovery-workspace-tools.ts) 始终注册 `ls` `read` `grep` `find` `edit` `write`，仅当 `allowShell: true` 追加 `shell_exec`（实现为 PowerShell/Bash 封装）。

[`controllerDecisionTools()`](../../src/application/experiment-controller-loop.ts) 当前调用：

- `allowWrite: () => false`
- `allowShell: true`
- `shellCwd: input.environment.root`（隔离副本根）
- `denyDestructiveOnPrefix: [CONTROLLER_PROJECT_MOUNT]`（`project`）
- `mounts: { project: replicaRoot }`

`map` 并不删除工具。`tool.name !== "read" && tool.name !== "shell_exec"` 只表示这两项被包一层 `onCompleted` 以写 observation artifact；其余工具原样保留。

架构测试 [`test/core/architecture.test.ts`](../../test/core/architecture.test.ts) 要求 Controller 工厂选项下工具名等于七件套，并断言 loop 含 `allowShell: true` 与 `allowWrite: () => false`。

因此当前模型可见工具是 **七个名字**。有效执行能力是：

| 工具 | 注册 | 执行 |
|---|---|---|
| ls / read / grep / find | 是 | briefing 根 + `project/` |
| edit / write | 是 | 一律 `write_denied: path is outside the Host write policy.` |
| shell_exec | 是 | cwd 在隔离副本；净化环境；命令文本匹配拦截凭据名、只读 mount 破坏性动词；**不是语义沙箱** |

system prompt（[`controller-system-prompt.txt`](../../test/snapshots/controller-system-prompt.txt)）只写 `read/ls/grep/find`，与注册集合不一致。INDEX 写 `project/` 只读、`controller.writes=denied`。

审查里「随后只保留五工具、shell 被排除」与当前代码不符。有效只读观察确实是四个读工具；写被拒；shell **已打开**。后续修改必须按这张表改，不能按「已经没有 shell」来规划。

### 文档漂移

仍写「Controller 使用七个工具 / 工作区七件套」，并把 `powershell` 的 cwd、环境净化写成 Controller 能力的一部分：

- [实验条件 §4](../architecture/controller-experiment-conditions.md)
- [validation Capability](../architecture/validation.md)
- [七工具决策](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)（`edit`/`write` 仍注册、`allowWrite` 恒 false）
- [角色副作用](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)
- [环境](../architecture/environment.md)（三角色复用工厂；Controller 与 Comparison 显式 `allowShell: true`）

文档应区分三层，而不是混用「七工具」：

1. **共享基础集合**：工厂能提供的名字。
2. **角色注册集合**：本轮发给模型的名字。
3. **角色写/执行策略**：`allowWrite` / `allowShell` / mount 拒写。

### 目标

工具列表即模型本轮可调用的能力。禁用的工具不注册。这与 [Recovery 可见能力](../decisions/accepted/2026-09-10-recovery-visible-capability-and-readiness-gates.md) 对 `shell_exec` 的规则同一原则。

---

## 2. 待拍板：Controller 要不要 `edit` / `write`

### 两种实验目标

| 目标 | `edit`/`write` | 理由 |
|---|---|---|
| 模拟真实用户协作 | 允许，仅 `project/` | 真人会改配置、整理产物、补文档、按候选结果做人工修改 |
| 测量候选独立能力 | 禁止 | Controller 会变成第二个执行 Agent，最终比较混入用户侧修改 |

「给全部七个工具、相信模型智力」把安全边界交给 prompt。本模块既有约束（不得写用户源目录、不得改状态机、不得调用 Target 工具）是靠不给予能力和 Host 校验，不是靠自觉。见 [validation Capability](../architecture/validation.md)。智力不能替代工具面。

### 建议权限划分（协作目标下）

| 工具 | Controller |
|---|---|
| ls / read / grep / find | 允许；briefing 根 + `project/` |
| edit / write | 允许；**仅** `project/` 相对路径；写入必须进 Controller 用户操作审计 |
| shell_exec | **默认不注册** |

必须继续禁止写入：

- briefing 根（INDEX、permissions、current-user-view、history、run/turns、manifest）
- 事件日志、artifact store、Experiment / CandidateRun 控制文件
- 用户源目录（隔离副本之外）

隔离副本上的写入不触及原始用户目录，路径边界、符号链接检查、受控写入审计已存在于工作区工厂。风险主要是 **实验语义**，不是把文件写回用户机器：

- Controller 可能替候选完成任务；
- 候选结果被 Controller 改过再继续；
- 对照阶段无法区分谁改了文件。

因此开放写入的前提是结果与 trace 能分开：Target 修改、Controller 修改、基线已有内容。

### 为什么默认仍关 `shell_exec`

`edit`/`write` 是文件级、可审计的用户动作。`shell_exec` 额外带来构建、测试、脚本、网络、任意副作用，使 Controller 接近第二个 Agent Runtime。即便 cwd 锁在副本、环境已净化，一条 `npm test` 或间接写文件也会模糊实验边界。

当前代码已经 `allowShell: true` 且 `shellCwd` 为 replica 根。`denyDestructiveOnPrefix` 只对命令文本里出现 `project` 或 mount 绝对路径、且匹配一组破坏性动词的情况拒绝；相对路径修改（cwd 已在副本内）可以绕过这段匹配。这比「只读 Controller」声明更宽，也比「给用户编辑权」更接近第二 Runtime。

建议：

- 默认不注册 `shell_exec`；
- 需要模拟「用户在终端执行命令」时单独实验模式；
- 该模式必须把 shell、网络迹象、文件变化计入 Controller activity，并在结果中标记 user-side intervention。

独立能力目标下：四个读工具即可，不要为了对齐七件套而注册写工具和 shell。

### 落地时要改的契约点

- `controllerDecisionTools()` 的 `allowWrite` / `allowShell`
- `permissions.txt` 的 `controller.writes` / `controller.project`
- `CONTROLLER_SYSTEM_PROMPT` 与 INDEX 文案（「只读」不再适用于协作目标）
- [七工具决策](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)、[角色副作用](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)：旧决定不能改成相反内容，新 ADR 替代被推翻的条款并冻结旧文
- `test/core/architecture.test.ts` 对 `allowWrite: () => false` 与 `allowShell: true` 的源码断言
- 若开放写：`onControlledWrite` / 新 artifact kind，避免与 Recovery 的 `recovery.md` 通道混名

---

## 3. 只读策略若保留，必须在注册阶段丢掉 `edit`/`write`

当前只给 `allowWrite: () => false`，模型仍看到 `edit`/`write` 的 schema 与描述，调用后才得到 `write_denied`。后果：

- 浪费调用与上下文；
- 模型能力快照与真实能力不一致；
- `controller.requested` 的 `toolSetVersion` 无法表达「名为七个、实为四个读工具」。

独立能力目标或过渡期：工厂过滤掉 `edit`/`write`（以及 `shell_exec`）。不要注册后再拒绝。

协作目标：注册 `edit`/`write`，但 `allowWrite` 只对 `project/` 下相对路径为真，briefing 相对路径为假。工具描述写明可写范围，避免模型去改 INDEX。

---

## 4. `historicalUserTurns` 与 briefing 文件双重来源

[`steeringContextFrom`](../../src/application/experiment-controller-loop.ts) 固定：

```ts
historicalUserTurns: []
```

真实历史用户句在 briefing：

- `history/user-inputs/INDEX.tsv`
- `history/user-inputs/{id}.txt`
- `history/initial-input.txt`
- `history/transcript/{id}.txt`

类型 [`SteeringContext.task.historicalUserTurns`](../../src/agents/controller-agent.ts) 仍宣称有历史 turn。停止条件文档也仍提到「不是用完 `historicalUserTurns`」。

模型可以靠 prompt 读文件工作。任何按该字段做重建、审计、测试夹具的下层会得到空数组。这是数据模型问题，不是缺测试。

二选一，不要并存：

1. **删除字段**（及所有「队列打完」表述），历史输入的唯一模型入口是 briefing 文件；`controller.requested` snapshot 用 `fileDigests` 证明可见范围。
2. **从 `TaskCase.transcript` 填充**，并写明：是否进入模型可见 JSON。若填充但不进 prompt，须标成 Host 内部索引，避免再次把全文塞进 `SteeringContext`（已被 [路径 briefing](../decisions/accepted/2026-09-03-controller-path-briefing.md) 否决）。

---

## 5. Opening 读取历史材料不进 evidence catalog

`read` 的 `onCompleted` 在写入 observation 前要求：

```ts
const turns = input.store.events(input.runId)
  .filter((event) => event.type === "runtime.turn_settled").length;
if (!turns || !(changed || ...)) return;
```

Opening 时 `turns === 0`，因此第一次理解阶段读取的历史用户输入、助手输出、permissions、replay **不会**生成 `controller_observation`，也不会进入本轮 `evidenceCatalog`。

`validateControllerDecision` 只允许引用 catalog 里的 ref。opening 允许 `send` 且不要求 evidence；模型不能在 opening 信封里引用它刚读过的历史文件。这与「判断应可追溯到读取证据」不完全同构。

二选一：

1. **Opening 历史读取也落 request-scoped evidence**（例如 `source: "briefing_read"`），校验允许 opening 引用这些 ref；catalog 仍做 run ownership 检查。
2. **明确分层**：`evidenceRefs` 只表示本候选轨迹上的观察；历史 briefing 是 Host 提供的输入，不要求也不允许当作 observation evidence。规范、`ControllerDecision` schema 注释、实验条件 §5 一起改。

不要维持「能读但不能引用」的静默行为。

Steering 侧现行规则仍合理：只把「本轮 `project/<changedPath>`」或最新 turn 的 `visible.txt` / `events.jsonl` 记为 workspace_read。历史文件在 steering 再读是否进 catalog，与 opening 选项保持同一分层，避免两套 provenance。

---

## 6. 用户可见表面 vs 摘要先于原文

[`inspectRun()`](../../src/application/controller-queries.ts) 先算 `currentSummary`、`trajectorySummary`、`turnVisibleText`、`userView`。[`writeSettledTurnBriefing()`](../../src/application/controller-briefing.ts) 再写 `current-user-view.md`、`run/turns/NNNN/visible.txt`、event-index、changed-paths。

system prompt 要求先读 `current-user-view.md`。Host **不强制**该 `read`，也不阻止模型仅凭摘要 `done`。

[`controllerRequestSnapshot`](../../src/application/controller-briefing.ts) 把 `current`、`trajectory`、`evidenceCatalog` 放进 `controller.requested`。Pi 侧若把 snapshot 字段投影进模型输入，摘要会先于用户视图到达。摘要含：

- Observed commands 条数
- changed paths 条数
- rejected approvals
- workspace evidence 状态

这些不一定是用户在产品 UI 里直接看到的内容。

若「只能依据用户当前可见表面」是硬边界：

- `currentSummary` / `trajectorySummary` 不得包含比 `current-user-view.md` 更多的判断性事实；或
- 这些字段只留在 Host / 事件日志，不进模型可见 snapshot；工作区命令与路径改由按需 `read` `changed-paths.txt` 获得。

若只是软引导：规范写明「prompt 要求先看视图，Host 不强制」，并接受模型可以摘要直接决策。不要口头硬边界、实现软边界。

相关：[唯一用户视图入口](../decisions/accepted/2026-09-10-controller-current-user-view.md)、[可见表面与 Git sink](./2026-09-10-visible-surface-and-git-sink.md)。

---

## 7. `allowModelText=false` 只关正文，不关结构

[`writeOpeningBriefing()`](../../src/application/controller-briefing.ts) 把历史正文写成 `[REDACTED]`。仍会写出：

- `history/outline.tsv`：id、role、bytes、`after_first_deliverable`
- 用户输入顺序与 `INDEX.tsv`
- assistant/user 相邻关系（`related` 列）
- transcript 相对路径
- `run/turns/*/event-index.tsv` 的事件类型序列

这不泄露正文，但泄露会话拓扑和消息长度。当前实现把 `allowModelText` 当正文开关。文档若暗示「关闭模型文本后 Controller 看不到历史」，是错的。

目标：在 [产品隐私](../product/overview.md) 或实验条件中写明三档（名称以 ADR 为准）：

1. 允许正文；
2. 红acted 正文 + 保留结构（现状）；
3. 结构也不可见（若产品需要，另做，不与第 2 档混称）。

---

## 8. `release` 不等待 session close

[`ControllerAgent.cancel()`](../../src/agents/controller-agent.ts) 等待 `session.cancel`，再删 `#sessions` / `#toolCallbacks`。这与「取消要落到事件」一致。

`release()`：

```ts
void pending.then((session) => session.close()).catch(...)
this.#sessions.delete(runId);
```

不等待 `close()`，也不等待 in-flight request。`runControllerLoop` 在 `finally` 里调用 `release`。调用方若立刻放 store 或退出进程，可能出现 `agent.session_completed` 晚于 run finished，审计顺序不稳定。

目标：loop 的结束路径 `await` 关闭（`release` 改为 async，或另提供 `close`）。取消路径保持现有等待。空 `catch` 继续只吞「session 创建已失败、decide 已经抛出」这一种情况。

---

## 9. 连续 Session 与 per-request 工具闭包

`#sessionFor()` 只在第一次 `decide` 创建 session，并把当时的 `tools`（含 `execute`）交给 Host。后续 `decide` 传入的新工具对象不会替换 session 内的 `execute`。

缓解已经存在：每次 `decide` 先把 `#toolCallbacks` 设成当前 `tools` 的 `onCompleted`；session 包装器只按 `runId` 查找。因此 **observation artifact 使用的 `changedPaths` / `requestId` 走的是本轮 callback**，不是 opening 那一次 `onCompleted` 闭包。

仍成立的风险：

- `execute` 永远是 opening 那一次 `recoveryTools()` 的实现。今天选项（root、mounts、`allowWrite`）跨轮不变，所以读路径仍可用。一旦 `allowWrite`、mount、cwd 按轮变化，session 内工具不会跟上。
- 若 Host 直接调用原始 tool 对象上的 `onCompleted` 而不走包装器，才会退回 opening 闭包。需要用测试锁定 Host 实际调用的是包装器。
- `controllerDecisionTools(…, packed.observation.changedPaths)` 每轮重建，却把 `changedPaths` 写进 `onCompleted` 而不是 `execute`。注释应写清：依赖 `#toolCallbacks` 换绑；不要有人「优化」掉这层查找。

建议的稳妥修复（即使回调已经换绑，也避免下次改坏）：

- 工具 callback 不捕获 opening 的 `changedPaths`，改为从当前 request/run 状态读取（例如 `inspectRun` 最新结果、或 Host 在 request 上挂的 turn metadata）；或
- 每轮更新 session 工具的 turn metadata；或
- 「是否属于当前 turn」的判断移到 Host，使用当前 request 动态数据。

反向用例：opening 后第一轮 settlement 的 `changedPaths` 非空，Controller `read project/<path>` 必须产生 `controller.observation_read` 与 artifact。若只在 opening 空 `changedPaths` 下读同一路径，不得误用旧空列表把 artifact 丢掉。

---

## 10. `project/` 可读范围宽于「用户可见文件」

`project/` 是整个 isolated replica 的只读 mount。`ls`/`find`/`grep`/`read` 没有代码级白名单「仅用户可见路径」。限制来自：

- system prompt（先看当前用户视图，按需再读用户可访问材料）
- briefing 中的 permissions 与 INDEX
- 产品 projection 生成的 `current-user-view.md`

Controller 可以读取副本里用户未必在 UI 看到的文件（内部配置、隐藏目录、工具缓存等），只要文件在 replica 内。

文档「真实用户本来就能看见的证据」与实现「整个隔离副本只读」不一致。

目标二选一并写进实验条件 §4：

1. **承认宽只读**：副本即用户工作区；UI 未展示不等于用户不能打开文件。prompt 仍引导先看视图。
2. **收窄**：Host 按 Pack 声明的可见根或 git 跟踪文件限制 `read`/`grep`；代价是漏掉真人本来会用资源管理器打开的文件。

默认建议承认宽只读，因为「用户可见表面」已经由 `current-user-view.md` 承担；工作区文件是第二层、按需的用户能力。不要继续写「只能看见 UI 表面」同时又挂载整棵树。

---

## 11. `permissions.txt` 是历史推断，不是当前 runtime 授权证明

[`historicalCandidatePermissions()`](../../src/application/controller-briefing.ts) 从 `taskContext` 与 `historicalEvents` 抽 sandbox / permissionMode / approvalPolicy / network，再用 `candidateWrites()` 映射 `allowed | workspace | denied | unconfirmed`。

[权限快照决策](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md) 已要求缺失标 `unconfirmed`。仍可能：历史字段是 `workspace`，当前 Pack launch config 不同，Controller 按 `permissions.txt` 预判候选能力。

system prompt 写「权限由 Host 按历史会话的有效设置固定」。INDEX 写「candidate runtime uses Host-fixed historical session settings」。代码没有把「已解析的本次 CandidateRun launch config」写进该文件。

目标二选一：

1. **保持历史条件摘要**：文件头写明「historical session inference, not this run's launch grant」；`candidate.source=historical_session` 不够，需要一句不可忽略的不确定性。
2. **改为本次 runtime 快照**：从已解析 Pack/runtime launch config 生成；与历史不一致时单列 mismatch，供 Controller 当观察而不是当授权。

消息仍不得扩大权限；实际执行权限继续由 Host/Runtime 强制。本条只解决 Controller **以为**候选能做什么。

---

## 建议实施顺序

1. **拍板实验语义**（协作 vs 独立能力），写出 ADR：工具注册集合、`project/` 写范围、shell 默认关、审计如何区分 Controller 写入。
2. **工具面与文档对齐**：注册集合 = 模型可见集合；改 architecture 测试与实验条件 §4；废止「七工具但写全拒」若与 ADR 冲突的条款。
3. **连续 Session 的 changedPaths / request 绑定**：加反向测试；必要时把判断移出 opening 闭包。
4. **opening evidence 分层** 与 **`historicalUserTurns` 单一来源**（可同一批次，都是输入/provenance 模型）。
5. **摘要 vs 用户视图**：按是否硬边界改 snapshot 或改规范措辞。
6. **`release` 等待 close**；**`allowModelText` 隐私档位**；**permissions 来源声明**。可并行，但各自要有测试或文档锚点。

优先级上，工具面过滤/授权与 changedPaths 绑定会直接改变模型行为；文档七工具、双重历史字段、permissions 措辞改变可解释性。`release` 时序在短跑中少见，但事件日志完整性需要它。

---

## 需要同批改动的规范入口

不要复制工具名清单到多份正文。改完后只在实验条件 §4 保留角色注册规则，其余给相对链接。

| 文件 | 角色 |
|---|---|
| 新 ADR `docs/decisions/accepted/` | 工具面与实验语义；替代七工具决策中「edit/write 注册但恒拒写」等被推翻条款 |
| [实验条件 §4](../architecture/controller-experiment-conditions.md) | 注册集合、写范围、shell、cwd |
| [Controller 设计](../architecture/controller.md) | 无界 shell、只读观察、摘要 vs 视图 |
| [validation](../architecture/validation.md) | Capability 不再写死「七个工具名 + 隔离副本只读」除非 ADR 仍如此 |
| [环境](../architecture/environment.md) | 「Controller 显式打开 shell」一句 |
| [七工具决策](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md) | 移入 superseded 或注明仍有效范围 |
| [角色副作用](../decisions/accepted/2026-09-08-role-side-effect-ownership.md) | `allowWrite` 恒否若被推翻 |
| [权限快照](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md) | permissions 来源 |
| [路径 briefing](../decisions/accepted/2026-09-03-controller-path-briefing.md) | `historicalUserTurns` 不再内联之后的字段命运 |

---

## 验证思路

- 架构测试：断言 Controller 实际 `recoveryTools(…).map(name)` 等于 ADR 规定集合；禁止「源码里写了 `allowShell: true` 但产品语义已关」这类字符串门禁与行为脱节。
- 反向：独立能力模式下工具列表出现 `edit`/`write`/`shell_exec` 必须红；协作模式下对 `INDEX.md` 的 `write` 必须红，对 `project/foo` 的 `write` 必须落审计事件。
- opening：`turns=0` 时读 `history/user-inputs/` 按 ADR 要么产生 evidence，要么决策校验明确不要求。
- steering：第一轮非空 `changedPaths` 的 `read project/…` 必须 `commitArtifact`。
- `historicalUserTurns`：类型与 snapshot 不再出现恒空数组，或测试证明 transcript 已填充。
- `release`：loop finally 之后 store 中存在对称的 session 完成事件（具体事件名以 Host 实现为准）。
- `npm run check`。只改文档时 `npm run verify:docs`。
