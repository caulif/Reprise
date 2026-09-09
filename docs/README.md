# Reprise 文档

当前实现规范与重构目标分开维护。开始任务先确认是在修复现有行为，还是实施一个已确认迁移批次；不要按文件修改时间选择规范。

## 按任务阅读

Recovery 需求与实施差异见[起点恢复目标](./plan/recovery-initial-environment.md)，当前行为仍以环境规范和代码为准。

| 要做什么 | 先读 | 再读 |
|---|---|---|
| 使用与配置 | [产品定义](./product/overview.md)、[TUI](./product/tui.md) | [支持](./SUPPORT.md)、[真实调用准入](./codex-smoke-gate.md) |
| 理解代码边界 | [架构总览](./architecture/overview.md) | [技术基线](./architecture/technology-selection.md)、[角色与 prompt 入口](./architecture/agent-roles-and-system-prompts.md)、[基座 Host](./decisions/accepted/2026-09-09-agent-foundation-host.md) |
| 修改存储或运行 | [持久化](./architecture/persistence-and-crash-consistency.md) | [结果与终止](./architecture/run-outcome.md)、[环境](./architecture/environment.md) |
| 修改模拟用户或对照 | [Controller](./architecture/controller.md)、[Comparison](./architecture/comparison.md) | [实验条件](./architecture/controller-experiment-conditions.md)、[验证边界](./architecture/validation.md) |
| 重构 Controller Agent | [Controller 重构实施参考](./plan/controller-agent-reconstruction.md) | [Controller 架构](./architecture/controller.md)、[实验条件](./architecture/controller-experiment-conditions.md) |
| 全面重构 Controller | [全面重构计划](./plan/controller-full-refactor-plan.md) | [重构实施参考](./plan/controller-agent-reconstruction.md)、[Controller 架构](./architecture/controller.md) |
| 阅读比较卡与 Controller 编排 | [对照](./architecture/comparison.md)、[Controller](./architecture/controller.md) | [可分享比较卡](./decisions/accepted/2026-09-09-comparison-shareable-task-card.md)、[Controller 先理解再决策](./decisions/accepted/2026-09-09-controller-understand-then-view.md)；Comparison 全面重构见[实施方案](./plan/comparison-agent-full-refactor.md) |
| 接入产品或平台 | [Product Pack](./architecture/product-plugin-compatibility.md) | [本机平台边界](./architecture/cross-platform.md) |
| 核对验收缺口 | [架构目标与 A1–A18](./plan/reprise-architecture-redesign.md)、[TUI 目标](./plan/reprise-tui-design.md) | [TUI 界面重构步骤](./plan/reprise-tui-surface-refactor.md)、[模块所有权归组](./plan/reprise-module-ownership.md)、[迁移差异表](./plan/documentation-reconciliation-for-session-harness-workflow.md)、[进度](./progress/MASTER.md)、[已关闭实施批次](./plan/reprise-refactoring-execution.md) |
| 提交与审查 | [贡献指南](./CONTRIBUTING.md)、[工程门禁](./engineering-gates.md) | [任务 brief](./plan/task-brief-template.md)、[治理](./GOVERNANCE.md) |
| 维护文档或发布 | [文档结构](./documentation-structure.md)、[文档指令](./AGENTS.md) | [发布检查](./release-checklist.md)、[Changelog](./CHANGELOG.md)、[事故复盘](./postmortem-template.md) |

## 权威与迁移

product/ 与 architecture/ 描述当前实现的规则；plan/ 拥有尚未关闭的真终端与 Runtime 证据，见[平台矩阵](./plan/2026-09-08-platform-evidence-matrix.md)、[走查修复](./plan/2026-09-08-fe4220-run-remediation.md) 与[进一步审查](./plan/2026-09-08-further-architecture-refactoring-review.md)。所有权决策见[Session harness workflow](./decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)。已落地规则以 accepted ADR 与 architecture/ 为准。

每个批次在同一变更中更新代码、规范、相关 ADR 与证据。通过[迁移差异表](./plan/documentation-reconciliation-for-session-harness-workflow.md)判断哪些旧决定需要被替代。不要在修文档时宣布功能已实现，也不要因旧 ADR 存在而重新讨论已确认目标。

目录边界和维护规则由[文档结构](./documentation-structure.md)拥有；运行进度只记在 MASTER。决策目录可搜索，不在这里手工复制所有 ADR 标题。HTML 是本机非权威草图，公开检出只靠 Markdown 即可理解设计。
