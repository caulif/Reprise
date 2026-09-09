# Agent 职责与提示词维护

本文维护当前角色边界与 prompt 的代码入口，不复制可执行 prompt。目标 Session 安排见[重构规划](../plan/reprise-architecture-redesign.md#4-三个角色与业务检查)，迁移差异见[文档迁移表](../plan/documentation-reconciliation-for-session-harness-workflow.md)。

## 角色归属

| 角色 | 当前规范 | 可执行定义 |
|---|---|---|
| Recovery | [环境与恢复](./environment.md) | [Recovery Agent](../../src/agents/recovery-agent.ts)与[工作集](../../src/agents/recovery-working-set.ts)；一次准备一个 Session、三轮委托，见[自主三轮循环](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md) |
| Controller | [协作行为](./controller.md)与[实验条件](./controller-experiment-conditions.md) | [Controller Agent](../../src/agents/controller-agent.ts)；连续 Session 先自由理解再决策，见[先理解再按视图决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md) |
| Comparison | [对照](./comparison.md) | [Comparison Agent](../../src/agents/comparison-agent.ts)；一次 attempt 一个 Session、四轮委托，见[可分享比较卡](../decisions/accepted/2026-09-09-comparison-shareable-task-card.md) 与[单 Session](../decisions/accepted/2026-09-08-comparison-single-session.md) |

候选 coding agent 是 Product Pack 控制的外部产品，不是第四个内部模型角色。共享执行机制见 [AgentHost](../../src/infrastructure/agent/host.ts)，产品协议不进入内部角色。

## 提示词与权限

Recovery 的 prompt、三轮编排和发布判断见[起点恢复目标](../plan/recovery-initial-environment.md)。System Prompt 只承载稳定规则；任务资源、轮次动作和输出契约由对应 turn 与 Host 请求提供。

每个角色明确目标、可用证据、工具权限、输出和停止条件。历史会话与产物属于任务数据，不因为包含指令句就获得新的系统权限。原始用户语句用于理解目标、授权和协作习惯；历史助手的事后发现不是模拟用户起点先验。

工具注册、路径边界与机械校验由 Host 执行，Recovery 在工作副本内自主调查、清理、恢复和重建。Recovery 可在 `.reprise/recovery-work/` 留下临时记录，Agent 自己判断是否迁移必要内容；封存前清理该目录。Recovery 业务结论为 `ready` 或 `blocked`，Host 不另设证据评分。

修改 prompt 时修改上述代码中的唯一文本源，并同步对应角色规范和 ADR；文档只保留语义约束及短例子，不建立另一份“推荐 prompt”。回归检查应能暴露权限扩大、输入遗漏或输出边界变化；纯字符串相等不能代替行为检查。Controller 模拟用户语义的机械合同 lane 与仓库外真实模型能力 lane 分开报告，见 [协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)；不声称模拟测试证明与真人一致。

