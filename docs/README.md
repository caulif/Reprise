# Reprise 文档

当前实现在 `product/` 与 `architecture/`；尚未落地的目标在 `plan/`；选择理由在 `decisions/`。开始任务先确认是修复当前行为还是实施计划，不要按文件修改时间选择规范。

## 按模块阅读

| 模块 | 当前规范 | 入口 |
|---|---|---|
| 产品与安全口径 | [产品定义](./product/overview.md) | [TUI](./product/tui.md) |
| 跨模块生命周期 | [架构总览](./architecture/overview.md) | [角色与 prompt](./architecture/agent-roles-and-system-prompts.md) |
| 持久化与 CandidateRun | [持久化](./architecture/persistence-and-crash-consistency.md) | [结果与终止](./architecture/run-outcome.md) |
| Recovery / 环境 | [环境](./architecture/environment.md) | [Git sink catalog](./decisions/accepted/2026-09-11-git-sink-catalog.md) |
| Controller | [Controller](./architecture/controller.md) | [实验条件](./architecture/controller-experiment-conditions.md) |
| Comparison | [对照](./architecture/comparison.md) | [Host 区域与直接 HTML](./decisions/accepted/2026-09-13-comparison-host-zones-and-direct-html.md) |
| Product Pack / 平台 | [Pack 契约](./architecture/product-plugin-compatibility.md) | [本机平台](./architecture/cross-platform.md) |
| 工程 | [贡献](./CONTRIBUTING.md) | [门禁](./engineering-gates.md) |
| 文档维护 | [文档结构](./documentation-structure.md) | [文档指令](./AGENTS.md) |
| 进度与目标 | [MASTER](./progress/MASTER.md) | [架构目标计划](./plan/reprise-architecture-redesign.md) |

## 权威与迁移

product/ 与 architecture/ 描述当前实现的规则；plan/ 拥有尚未关闭的真终端与 Runtime 证据，见[平台矩阵](./plan/2026-09-08-platform-evidence-matrix.md)、[走查修复](./plan/2026-09-08-fe4220-run-remediation.md) 与[进一步审查](./plan/2026-09-08-further-architecture-refactoring-review.md)。所有权决策见[Session harness workflow](./decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)。已落地规则以 accepted ADR 与 architecture/ 为准。

每个批次在同一变更中更新代码、规范、相关 ADR 与证据。通过[迁移差异表](./plan/documentation-reconciliation-for-session-harness-workflow.md)判断哪些旧决定需要被替代。不要在修文档时宣布功能已实现，也不要因旧 ADR 存在而重新讨论已确认目标。

目录边界和维护规则由[文档结构](./documentation-structure.md)拥有；运行进度只记在 MASTER。决策目录可搜索，不在这里手工复制所有 ADR 标题。HTML 是本机非权威草图，公开检出只靠 Markdown 即可理解设计。
