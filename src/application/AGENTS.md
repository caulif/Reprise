# AGENTS.md — 应用编排

先按[架构总览](../../docs/architecture/overview.md)定位编排边界；角色定义与 Host 装配入口见 [harness-agents.ts](harness-agents.ts)。

候选生命周期读[运行结果规范](../../docs/architecture/run-outcome.md)，对照 [CandidateRun](candidate-run.ts)、[状态机](../core/state-machine.ts)与 [Runtime 端口](../core/runtime.ts)；日志与发布顺序读[持久化规范](../../docs/architecture/persistence-and-crash-consistency.md)。恢复与报告分别由[环境专题](../../docs/architecture/environment.md)和[对照专题](../../docs/architecture/comparison.md)拥有。
