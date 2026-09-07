# Reprise 文档

`product/` 和 `architecture/` 描述当前实现；`decisions/accepted/` 记录已经生效的长期选择；`plan/` 只记录尚未实施的目标；`research/` 不定义实现。目录、命名与迁移规则见[文档结构与路径约定](./documentation-structure.md)。

## 当前规范

1. [产品定义](./product/overview.md)
2. [架构总览](./architecture/overview.md)
3. [持久化与崩溃一致性](./architecture/persistence-and-crash-consistency.md)
4. [Product Pack 兼容性](./architecture/product-plugin-compatibility.md)
5. [CandidateRun 结果与终止协议](./architecture/run-outcome.md)
6. [TUI](./product/tui.md)
7. [工程门禁](./engineering-gates.md)

## 已确认的重构目标

- [Session / harness / workflow 架构重构规划](./plan/reprise-architecture-redesign.md)
- [TUI 阅读与交互规划](./plan/reprise-tui-design.md)
- [目标决策提案](./decisions/proposed/2026-09-07-reprise-session-harness-workflow.md)
- [文档处置清单](./plan/documentation-reconciliation-for-session-harness-workflow.md)

目标设计尚未取代当前规范。实现每个迁移批次时，先同步相关架构文档和 ADR，再移动被替代材料。

## 工程与治理

- [贡献指南](./CONTRIBUTING.md)
- [安全政策](./SECURITY.md)
- [任务 brief 模板](./plan/task-brief-template.md)
- [真实 Runtime smoke 闸门](./codex-smoke-gate.md)
- [稳定进度入口](./progress/MASTER.md)
- [决策记录目录](./decisions/)

`docs/.local/` 保存已完成计划、一次性审查和本机运行记录，不受版本控制，也不能作为当前依据。`tui-audit/frames/` 是受控的 CI 快照基线。
