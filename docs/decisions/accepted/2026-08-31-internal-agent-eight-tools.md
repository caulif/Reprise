# 决策：三个内部 Agent 共用八工具名与写策略

状态：accepted

## 问题

Recovery 已注册 Pi 工作区七件套加 `read_observation`。Controller 只有分页观察；Comparison 用 `read_artifact` 与 `write_comparison_report`。专用工具与工作区文件两套读法冲突；少注册写工具并不能代替 Host 写策略。

## 决定

三个角色都注册同一组名字：`read`、`ls`、`grep`、`find`、`edit`、`write`、`powershell`、`read_observation`。Windows 不注册 `bash`。差异只在工厂参数：根目录、挂载、允许写入的路径、预算。禁止靠少注册工具代替策略。

Comparison 报告沙箱的 `candidate/` 是现有隔离副本的只读挂载（路径映射 + 拒写，不拷贝、不建 junction）；只允许 `write` 沙箱根 `report.html`，Host 再拷到实验根。Controller 的 cwd 是隔离副本，有界写；发给候选的唯一用户输入仍是信封 `message`；不得调用 Target Runtime、不得写用户源目录。Recovery 仍只写 staging。

删除 `read_artifact` 与 `write_comparison_report`。

## 备选方案

**Controller / Comparison 只给读四件套。** 基础 Agent 能力不完整，与 Recovery 工具名不对齐。

**拷贝候选树进 Comparison 沙箱。** 大副本双份；fingerprint 真相仍在隔离根。

## 影响

[`controller-experiment-conditions.md`](../../architecture/controller-experiment-conditions.md) §4、[`validation.md`](../../architecture/validation.md)、[`comparison.md`](../../architecture/comparison.md)、[`overview.md`](../../architecture/overview.md) 中「只读、不提供 shell」改为写策略与状态机边界。Environment §7.1 的 Recovery 八工具句保持，并适用于同一组名字。

## 验证

架构测试：三角色工具名集合相等；`write candidate/...` 失败；源码不再注册已删工具名。
