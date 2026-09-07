# 决策：Controller 只注册工作区七工具，不注册 read_observation

状态：accepted
日期：2026-09-03

## 问题

八工具决策曾要求 Recovery、Controller、Comparison 注册同一组八个名字，其中 `read_observation` 分页读冻结 transcript 与本 run 事件。Controller 的原文改为 Host briefing 文件 + `read` 之后，再注册 `read_observation` 会形成第二套入口。

## 决定

- Controller 只注册：`read`、`ls`、`grep`、`find`、`edit`、`write`、`powershell`。不注册 `read_observation`，不保留同名空壳。
- Recovery 与 Comparison 的工作区工厂同样是这七个名字。冻结历史走观察文件，见 [工作集与观察文件](./2026-09-07-recovery-working-set-and-observation-files.md)。
- 历史会话与本 run 回合原文只存在 briefing 目录；Controller 用工作区读工具读取。`edit` / `write` 仍注册，`allowWrite` 恒 false。
- 架构测试：三角色工作区工具名集合等于上述七个。

## 备选方案

**三角色仍八个名字，Controller 的 `read_observation` 返回「改用 read」。** 模型可继续调用无效入口。

**三角色都去掉 `read_observation` 且不物化观察文件。** 工作区看不到冻结会话；该方案已由观察文件取代。

## 影响

[八工具决策](./2026-08-31-internal-agent-eight-tools.md) 对 Controller 不再要求第八个名字。[路径 briefing](./2026-09-03-controller-path-briefing.md)。[实验条件](../../architecture/controller-experiment-conditions.md) §4。

## 验证

- `test/architecture.test.ts`：三角色工作区装配不含 `read_observation`。
- Controller system prompt 写明没有 `read_observation`。
