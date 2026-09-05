# Controller 路径 briefing 落地

状态：计划。按 [用户模拟讨论稿](./controller-user-simulation.html) 与已锁定选择改代码。设计结论不在本文重复；本文只写仓库里改什么、顺序、验收。

已锁定：[协作装配](./host-controller-collaboration.md)。规范：[Controller 七工具](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)、[路径 briefing](../decisions/accepted/2026-09-03-controller-path-briefing.md)。

## Goal

Controller 的默认模型输入不再是内联历史用户全文与 `baseline.finalMessage` 的 `SteeringContext` JSON。每个 CandidateRun：Host 在 **Target 不可见** 的目录写入 briefing 文件；每次 `append` 含固定决策说明与 **INDEX.md 全文**；Controller 用工具自读原文；仍输出校验过的 `send` / `done`。同一 run 共用一个 Pi session。Host 不因本轮零 `read` 拒绝 `done`。

## 现行代码锚点

| 行为 | 位置 |
|---|---|
| 开场 / 结算后循环 | `src/application/experiment.ts` `runControllerLoop`、`deliverOpening`、`deliverSteering`、`requestControllerDecision` |
| 试卷装配 | `src/application/controller-briefing.ts`；`experiment.ts` `steeringContextFrom`、`controllerRequestSnapshot` |
| 观察 | `inspectRun`（`src/application/experiment-inspection.ts`）写入 `run/turns/` |
| 工具 | `controllerDecisionTools`：`recoveryTools(briefingRoot)` + `project` 挂载；不注册 `observationTools` |
| session 与 append 正文 | `ControllerAgent.decide` 传 `promptContent`；`pi-agent-host.ts` `promptBody` 有 `promptContent` 则不用 `JSON.stringify(context)` |
| 提示词 | `CONTROLLER_SYSTEM_PROMPT`；快照 `test/snapshots/controller-system-prompt.txt` |
| 夹具 | `test/controller-briefing.test.ts`、`test/controller-full-session-judgment.test.ts`、`test/agent-host.test.ts` |

`promptBody` 被 Recovery / Controller / Comparison 共用。Controller 若改为「INDEX + 决策段」，不要把另两角的 JSON 试卷一并拆掉。在 `AgentSessionRequest` 上增加可选 `promptContent: string`（或按 `role` 分支），仅 Controller 走新正文。

## 目标磁盘布局

路径建议：`{experimentRoot}/runs/{runId}/controller-briefing/`（与 `events.jsonl` 同实验、按 run 隔离）。**禁止**写在 `environment.root`（隔离副本）内。

```text
controller-briefing/
  INDEX.md
  history/
    initial-input.txt
    outline.tsv
    transcript/
      {messageId}.txt          # 单条原文；privacy 与 TaskCase 一致
  project-root.txt             # 隔离副本绝对路径，一行
  replay.txt                   # sourceRootKind、historicalCwd（可空）、isolation 一句
  run/
    sent-user-messages.jsonl   # 本 run 已 submit 的用户句
    turns/{NNNN}/
      visible.txt
      events.jsonl             # 该回合规范化事件摘录（allowModelText）
      changed-paths.txt
  THIS-TURN.txt                # 开场：空或不存在；结算后一行相对路径 turns/NNNN
```

INDEX.md 由 Host 确定性生成，含上列相对路径、最新 `NNNN`、outline 列含义。不含任何用户/助手消息正文，不含 `finalMessage`。

`outline.tsv` 列：`id`、`role`、`bytes`、`after_first_deliverable`（`0`/`1`）。助手与工具行不写正文。

### 首次交付边界（纯函数，进 ADR）

对冻结 transcript 按顺序扫描。一条用户消息的 `after_first_deliverable=1` 当且仅当：在该消息之前，已出现至少一次（工作区写入类历史事件）或（role=assistant 且可见文本非空）。规则必须有单元测试；不调用模型标注。

### 本回合文件

`NNNN` 从 1 递增，与已结算候选回合一一对应。`visible.txt` 来自该回合对用户可见的助手文本（与 TUI 可见过程同一事实源，受 `allowModelText`）。`changed-paths.txt` 来自 `inspectRun` 的 `changedPaths`。开场不写 `turns/`。

## 工具面

Comparison 已有 `mounts: { candidate: replica }`。Controller 对齐：

- `recoveryTools` 的 `root` = `controller-briefing/`（只读：`allowWrite` 恒 false，Host 独占写入）。
- `mounts.project`（名称在 ADR 写死）= 隔离副本，只读。
- `powershell`：cwd 锁在 `project` 挂载根，净化环境、有界 stdout；禁止 briefing 根上起 shell。
- `homeRoot` 保持实验下 `.reprise-controller-home`，勿放进副本。

相对路径：`.` / `history/...` 读 briefing；`project/...` 读副本。INDEX 与 prompt 写明这两套前缀。

Controller **不**注册 `read_observation`，不留同名空壳。历史与本 run 原文只通过 briefing 上的 `read` / `ls` / `grep` / `find`。Recovery / Comparison 的八工具不变。见 [Controller 七工具](../decisions/accepted/2026-09-03-controller-seven-workspace-tools.md)。

`test/architecture.test.ts` 改为：Controller 名集合 = 七个工作区工具；Recovery 仍为八个。TUI 若把 Controller 的 `read_observation` 当画布事件，改为投影 `read`（`test/agent-activity-canvas.test.ts`）。

有界写：Controller 仍不得写用户源目录；briefing 与 `project` 均拒写。`edit` / `write` **仍注册**，`allowWrite` 恒 false。需要在副本里做有界核对时，第一版也不开放写入。若现有测试依赖 Controller 写副本，在 ADR 写明改为只读。

## 每次 append 的模型可见正文

system prompt：角色、知情/开口、信封、两套路径前缀、以磁盘为准不以 compact 摘要为准、开场禁止 `done`、`satisfied` 前应读 `THIS-TURN` 与 `project` 产物（Host 不执法）。

用户消息（`promptContent`）仅：

1. 开场或结算后的固定决策段（短、版本随 prompt hash）。
2. INDEX.md 全文。
3. 可选一行：`briefingRoot=` 与 `phase=opening|steering`（路径，非正文）。

禁止：`historicalUserTurns` 数组、`baseline.finalMessage`、整份 transcript、整份 `SteeringContext`。

`decide()` 仍需要：`runId`、`runState`、`phase`、`requestId`、`privacy.allowModelText`、evidence catalog（若还用 `evidenceRefs`）。这些留在类型里供 Host/校验，**不** `JSON.stringify` 进 prompt。

开场决策段：读 `history/initial-input.txt`、`project-root.txt`、`replay.txt`；需要口吻再读 `outline.tsv` 与 `after_first_deliverable=0` 的用户 `transcript/*.txt`；禁止把 `after_first_deliverable=1` 的句子写入第一句；必须 `send`。

结算后决策段：读 `THIS-TURN.txt` 指向的目录与 `project` 当前产物；历史用于判断停或改，不按序发送；可 `send` 或 `done`。

## `controller.requested`

`snapshot` 存：`phase`、`promptContent`（即 INDEX + 决策段）、`briefingRoot`、所列文件的 `path → sha256`（对 INDEX 引用到的文件；`transcript/` 可按目录 merkle 或逐文件）。`inputDigest` = 该对象的 hash。隐私：`allowModelText=false` 时文件已是红acted，snapshot 不另开洞。

体积过大则 snapshot 只留 digest + artifact ref，artifact 用 `writeAtomic` 写在 run 目录。

## 循环改动（`experiment.ts`）

1. `deliverOpening` 前：创建 briefing 目录，写 history（从 `TaskCase`）、INDEX、`project-root.txt`、`replay.txt`。
2. `requestControllerDecision`：更新 INDEX → persist requested → `decide`（不再 `steeringContextFrom` 的用户全文）。
3. `deliverSteering`：`inspectRun` 后写 `turns/NNNN/`、更新 `THIS-TURN.txt` 与 INDEX，再 decide。
4. `submit`/`start` 成功后追加 `run/sent-user-messages.jsonl`。
5. 墙钟、重复 `send` 文本、开场必须 `send`：保留。
6. `controllerCalls >= policy.maxModelCalls`：本计划 **阶段 5** 解绑；阶段 1–4 可暂留，避免与 briefing 抢同一 PR 的语义。解绑时 Controller 改看 `AgentBudget.maxCalls`（未设则不截断），`maxModelCalls` 只限 Target。

同一 `ControllerAgent` session：`createSession` 仍按 `runId` 缓存。工具在 create 时闭包 briefing 根与副本根；之后只更新磁盘文件。

## 提示词与夹具

重写 `CONTROLLER_SYSTEM_PROMPT`：删除「每轮 JSON 字段说明书」里对 `historicalUserTurns` / `baseline.finalMessage` 作为默认输入的描述；改为文件地图。保留：不泄漏实验、不执行目标任务、高影响授权、`blocked`、开口语言、可见过程段。

更新 `test/snapshots/controller-system-prompt.txt`。

夹具（`npm run build` 后 `node --test` 读 `dist/`）：

| 用例 | 期望 |
|---|---|
| 开场 `promptContent` | 不含交付后用户标记句；含 INDEX；含 `initial-input` 路径 |
| briefing 根 | 路径前缀不是 `environment.root`；副本内无 `INDEX.md` |
| INDEX | 列出 `history/transcript/` 与 `project` 前缀 |
| 浅交付 + 历史上交付后用户改稿 | 不断言必须 `done`；可断言 fake caller 收到的正文不含后文全文 |
| 零 `read` 的 `done/satisfied` | Host 仍 `settleController` |
| outline | 给定 transcript 的 `after_first_deliverable` 列与纯函数一致 |
| 工具 | `read history/...` 成功；`read` 副本须走 `project/`；写 `project` 失败；Controller 工具名不含 `read_observation` |
| requested digest | INDEX 或 `turns/0001/visible.txt` 变化则 digest 变 |

删除或改写依赖「briefing 内联 followups」的断言（`controller-full-session-judgment.test.ts` 等）。

反向：若增加「副本内不得出现 INDEX.md」门禁，同 PR 必须有一份会失败的自动化用例。

## 文档

同一次（或紧随可合并的）变更：

- accepted ADR：briefing 目录与副本隔离、INDEX 进 append、一个 session、Host 不因零 read 拒 `done`、首次交付规则、Controller 工具 cwd/mount、**Controller 七工具无 `read_observation`**、`promptContent` 与 requested digest、（阶段 5）预算解绑。将 proposed 七工具记录移入 `accepted/`。
- `controller.md`：试卷改为路径 + INDEX；删「每轮完整 historicalUserTurns」。
- 实验条件 §5：完整可访问 = briefing 文件 + 工具；§4 工具根；§6 与代码一致（阶段 5）。
- `agent-roles-and-system-prompts.md` 中 Controller 输入描述。
- 讨论稿保持非规范；计划做完后按文档迁移规则移入 `docs/.local/` 或保留并改链到架构。

## 落地顺序

每阶段可单独 `npm run check`。不要先改 Comparison/Recovery 试卷。

1. **纯函数与写盘**：`outline.tsv`、INDEX 生成、briefing 目录创建、单测。尚不接循环。
2. **工具**：Controller 只装配 `recoveryTools`（briefing 根 + `project` 挂载、拒写、powershell cwd 在 `project`）。**不**注册 `observationTools` / `read_observation`。架构测试：Controller 七名、Recovery 八名。
3. **循环 + promptContent**：开场/结算写盘、`promptBody` 分支、system prompt、requested snapshot。去掉默认 JSON 用户全文。
4. **夹具与 snapshot**；TUI Controller 画布不再把 `read_observation` 当该角色的观察工具。
5. **预算解绑**（可另 PR）：`RunPolicy.maxModelCalls` 不再截断 Controller。

阶段 2 不再迁就八工具「名集合相等」。空壳 `read_observation` 不做。

## 不做

- 不按历史下标 `send`。
- 不把 briefing 或 INDEX 写入隔离副本。
- 不每轮新建 Controller session。
- 不因零 `read` 或未用历史用户句拒绝 `done`。
- 不 Host 投递冻结 `initialInput`。
- 不把 `finalMessage` / transcript 贴进 append。
- 不改 CandidateRun 状态机与 Target 只收用户句。
- 不引入人格抽取 Agent 或第二审查 Agent。
- 不在本计划重做 Comparison 报告。
- 不为 Controller 保留 `read_observation`。

## 风险

- 模型不读文件就 `done`：接受（已锁定）；用夹具防回归到「JSON 里已有后文」。
- Windows 路径与 `project/` 挂载：按现有 `pathIn` / mounts 实现，测试用短路径。
- 长 transcript 文件数：一消息一文件；INDEX 只列目录不列全部 id 时，须在 INDEX 写「按 `outline.tsv` 的 id 读 `transcript/{id}.txt`」。
- `allowModelText=false`：文件写红acted 占位，与现行观察工具同一策略。

## Rollback

revert 该主题 commits。磁盘多出的 `controller-briefing/` 可忽略；旧 experiment 无该目录。不改 `events.jsonl` schema 版本则旧日志仍能重放；若 `controller.requested.snapshot` 形状变了，重放只校验 checksum，报告不依赖旧 snapshot 字段。若必须同 PR 改 snapshot schema，RunManifest / 文档注明新字段可选。

## Done means

- `npm run check` 退出 0（含改代码后的 `build`）。
- 仅文档阶段则 `npm run verify:docs`。
- 上表夹具均在 `dist/` 上通过。
- 存在 accepted ADR（含 Controller 七工具）；架构测试：副本无 briefing 文件；Controller 工具名不含 `read_observation`。
