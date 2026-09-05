# Host 与 Controller 协作装配

状态：计划。循环、信封、开场必须 `send`、Host 不按序投递历史用户句——不变。默认输入改为路径 + INDEX.md。

相关：[用户模拟讨论稿](./controller-user-simulation.html)、[路径 briefing 落地](./controller-path-briefing.md)、[Controller 设计](../architecture/controller.md)、[实验条件](../architecture/controller-experiment-conditions.md) §5–7、[按验收习惯停](../decisions/accepted/2026-09-03-controller-stop-on-acceptance-habits.md)。

改仓库的步骤、磁盘布局、工具挂载、夹具与阶段以 [路径 briefing 落地](./controller-path-briefing.md) 为准。本文只锁产品选择。

## 已锁定

| 项 | 决定 |
|---|---|
| 材料形态 | Host 写 `controller-briefing/`；append 含固定决策段与 **INDEX.md 全文**；不含 transcript 正文、不含 `baseline.finalMessage` |
| Pi session | 每个 CandidateRun **一个** Controller session；结算后对该 session `append` |
| `done` | 仅 prompt 要求先读本轮输出与项目产物；Host **不**因零 `read` 拒绝 `done` |
| 工具 | 只注册工作区七件套；**不**注册 `read_observation`，不留空壳。Recovery / Comparison 仍为八工具 |

## 判断

现行缺口是每轮 JSON 内联 `historicalUserTurns` 与 `baseline.finalMessage`，和开口写在同一次生成里。实验条件的「完整可访问」应落实为磁盘原文 + 工具。

## 不做

- 不按历史下标强制 `send`。
- 不因未读文件或未用后续用户句拒绝 `done`。
- 不恢复 Host 投递冻结 `initialInput`。
- 不把历史或本 run 观察文件放入隔离副本。
- 不每轮新建 Controller session。
- 不把 transcript / `finalMessage` 贴进 append。
- 不让 Controller 执行目标任务或把历史助手实现写进用户句。
- 不引入第二审查 Agent。
- 不为 Controller 注册 `read_observation`（含空壳）。
