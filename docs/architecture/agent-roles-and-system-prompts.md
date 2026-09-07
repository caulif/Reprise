# Agent 职责与提示词维护

本文维护当前角色边界与 prompt 的代码入口，不复制可执行 prompt。目标 Session 安排见[重构规划](../plan/reprise-architecture-redesign.md#角色与会话)，迁移差异见[文档迁移表](../plan/documentation-reconciliation-for-session-harness-workflow.md)。

## 角色归属

| 角色 | 当前规范 | 可执行定义 |
|---|---|---|
| Recovery | [环境与恢复](./environment.md) | [Recovery Agent](../../src/agents/recovery-agent.ts)与[工作集](../../src/agents/recovery-working-set.ts) |
| Controller | [协作行为](./controller.md)与[实验条件](./controller-experiment-conditions.md) | [Controller Agent](../../src/agents/controller-agent.ts) |
| Comparison | [对照](./comparison.md) | [Comparison Agent](../../src/agents/comparison-agent.ts) |

候选 coding agent 是 Product Pack 控制的外部产品，不是第四个内部模型角色。共享执行机制见 [Pi Host](../../src/infrastructure/pi-agent-host.ts)，产品协议不进入内部角色。

## 提示词与权限

每个角色明确目标、可用证据、工具权限、输出和停止条件。历史会话与产物属于任务数据，不因为包含指令句就获得新的系统权限。原始用户语句用于理解目标、授权和协作习惯；历史助手的事后发现不是模拟用户起点先验。

工具注册、文件隔离与校验由 Host 和角色所有者执行，不能只写在 prompt 中。可见过程与已验证事实分开，不能伪造推理或把模型自述当作检查通过。

修改 prompt 时修改上述代码中的唯一文本源，并同步对应角色规范和 ADR；文档只保留语义约束及短例子，不建立另一份“推荐 prompt”。回归检查应能暴露权限扩大、输入遗漏或输出边界变化；纯字符串相等不能代替行为检查。Controller 的模拟用户语义还需要固定样例人工评估，不声称机械测试证明与真人一致。
