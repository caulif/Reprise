# AGENTS.md — 内部 Agent

修改角色前读[职责与提示词归属](../../docs/architecture/overview.md)，按其中链接定位当前专题与唯一可执行文本源。

请求与输出类型随各角色定义；共享 Session、工具与审计端口见 [Host 类型](../infrastructure/agent/types.ts)，执行入口见 [AgentHost](../infrastructure/agent/host.ts)。模型输入与事件回放约束见[持久化规范](../../docs/architecture/evidence-and-comparison.md)。
