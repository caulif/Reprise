# 决策：Controller 按真实用户协作开放 project 写入，不注册 shell

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。 本文相关条款已由[后续决定](2026-09-12-controller-unrestricted-read-and-shell.md)替代，未涉及的内容仍需按当前事实核对。


状态：accepted
日期：2026-09-10

## 问题

Controller 实验语义是模拟原用户协作，不是测量候选独立完成任务。工作区工厂却把 `edit`/`write` 注册后一律拒绝，又把 `shell_exec` 发给模型。文档仍写七件套与 `project/` 只读。模型看见的工具名与可执行能力不一致；连续 Session 若捕获 opening 的 `changedPaths`，后续转向读取无法记入 evidence。

## 决定

Controller 模拟真实用户协作：

- 注册且可执行：`ls`、`read`、`grep`、`find`、`edit`、`write`。
- 不注册 `shell_exec`。需要「用户在终端执行命令」时另开实验模式，并把命令、网络迹象和文件变化记为 user-side intervention。
- `edit`/`write` 只允许相对路径第一段为 `project` 且其后仍有路径分量。briefing 根、事件日志、Host 快照由 Host 写入。
- `project/` 挂载对 Controller 可写；写入走受控 journal，并各写一条 `controller.workspace_write`。`changed-paths.txt` 仍是隔离副本相对起点的文件系统差分；`run/controller-writes.jsonl` 列出 Controller 写入，结果中可区分 Target 差分、Controller 写入、基线已有内容。
- 发给模型的工具名集合等于本轮可执行集合。禁用的工具不出现在 schema。
- opening 与 steering 读取 `history/`、INDEX、permissions、replay、当前用户视图等 briefing 材料时，产生 `controller.observation_read` 且 `source=briefing_read`，可被当轮 `evidenceRefs` 引用。steering 读取本轮 `project/<changed path>` 或最新 turn 的 `visible.txt`/`events.jsonl` 时 `source=workspace_read`。
- `SteeringContext.task` 不再包含 `historicalUserTurns`。历史用户句只存在 briefing 文件，不进模型 JSON。
- Host 放进 snapshot 的 `current.summary` / `trajectory.summary` 只指向用户视图文件，不内联命令数、路径数或 workspace evidence 状态。
- `privacy.allowModelText=false` 关闭正文（写成 `[REDACTED]`），仍保留 outline 的 id、role、顺序和字节数。
- `ControllerAgent.release` 等待 session `close`，再返回。
- `permissions.txt` 标明候选字段是历史会话推断，不是本次 runtime launch 授权证明。

本决定取代 [Controller 七工具](./2026-09-03-controller-seven-workspace-tools.md) 中「`edit`/`write` 仍注册且 `allowWrite` 恒 false」的条款，[角色副作用](./2026-09-08-role-side-effect-ownership.md) 中「Controller `allowWrite` 恒为否、隔离副本只读挂载」的条款，[八工具](./2026-08-31-internal-agent-eight-tools.md) 中「Controller 的 `project/` 只读」的条款，以及 [Recovery 可见能力](./2026-09-10-recovery-visible-capability-and-readiness-gates.md) 中「Controller 在工厂调用里显式打开 shell」的条款。不注册 `read_observation`、发给候选的唯一用户输入仍是信封 `message`、不得改 CandidateRun 状态机、不得写用户源目录，继续有效。Comparison 仍可显式打开 `shell_exec`。

## 备选方案

**继续只读并注册写工具。** 模型浪费调用；能力快照撒谎。

**给 Controller 全部七工具含 shell。** Controller 接近第二个 Runtime，实验边界模糊。

**测量候选独立能力、四个读工具。** 与「模拟真实用户协作」的产品目标不符。

## 影响

[实验条件](../../../architecture/execution.md#controller-时机与权限) §4–5、[Controller 设计](../../../architecture/execution.md)、[validation Capability](../../../architecture/overview.md#不变量)、[环境 §7.1](../../../architecture/recovery.md#隔离边界)。

## 验证

- `test/core/architecture.test.ts`：Controller 工厂名为六件套、无 `shell_exec`、无 `allowShell: true`。
- `test/application/controller-briefing.test.ts`：`project/` 可写、briefing 拒写；permissions 含历史推断声明。
- `test/application/controller-tools.test.ts`：opening 历史 `read` 记 `briefing_read`；bindings 上的 `changedPaths` 更新后 `project/<path>` 记 `workspace_read`；反向：`INDEX.md` 的 `write` 红。
- `test/application/agent-host.test.ts`：`release` 之后同一 runId 新建 session。
- `test/core/store.test.ts`：畸形 `controller.workspace_write` 拒收。
- `npm run check`。
