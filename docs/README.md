# Reprise 文档

当前实现在 `product/` 与 `architecture/`；尚未落地的目标在 `plan/`；选择理由在 `decisions/`。开始任务先确认是修复当前行为还是实施计划，不要按文件修改时间选择规范。

## 按模块阅读

| 模块 | 当前规范 | 入口 |
|---|---|---|
| 产品与安全口径 | [产品定义](./product/overview.md) | [TUI](./product/tui.md) |
| 跨模块生命周期 | [架构总览](./architecture/overview.md) | [角色与 prompt](./architecture/agent-roles-and-system-prompts.md) |
| 持久化与 CandidateRun | [持久化](./architecture/persistence-and-crash-consistency.md) | [结果与终止](./architecture/run-outcome.md) |
| Recovery / 环境 | [环境](./architecture/environment.md) | [Git sink catalog](./decisions/accepted/2026-09-11-git-sink-catalog.md)、[冻结嵌套 Git](./decisions/accepted/2026-09-16-freeze-nested-git-discovery.md)、[任务前 HEAD](./decisions/accepted/2026-09-16-recovery-pre-task-head.md)、[线性生命周期与 blocked](./decisions/accepted/2026-09-16-recovery-linear-lifecycle-and-blocked.md) |
| Controller | [Controller](./architecture/controller.md) | [实验条件](./architecture/controller-experiment-conditions.md)、[开场不得引用未发生建议](./decisions/accepted/2026-09-16-controller-opening-no-unseen-advice.md)、[运行时仅合同](./decisions/accepted/2026-09-16-controller-runtime-contracts-only.md)、[allowModelText 化石](./decisions/accepted/2026-09-16-allow-model-text-fossil.md) |
| Comparison | [对照](./architecture/comparison.md) | [价格快照与 ID 清洗](./decisions/accepted/2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md)、[astra 与 `[1m]` 别名](./decisions/accepted/2026-09-16-pricing-astra-and-1m-alias.md)、[操作者覆盖](./decisions/accepted/2026-09-14-comparison-operator-pricing-override.md)、[Pi 自定义模型 cost](./decisions/accepted/2026-09-15-pi-custom-model-requires-cost.md)、[可分享卡版式](./decisions/accepted/2026-09-14-comparison-share-card-layout.md)、[十秒比较卡](./decisions/accepted/2026-09-15-comparison-ten-second-card.md)、[历史会话 / 当前会话](./decisions/accepted/2026-09-16-comparison-session-labels.md)、[卡面图片必须成对](./decisions/accepted/2026-09-16-comparison-paired-visual-only.md)、[发布合同/版式分级与 cancel](./decisions/accepted/2026-09-16-comparison-publication-tiers-and-cancel.md)、[data-claim 紧随锚点](./decisions/accepted/2026-09-15-comparison-claim-trailing-citation.md)、[单卡与 N6 复刻](./plan/2026-09-16-share-card-and-n6-replay.md) |
| Product Pack / 平台 | [Pack 契约](./architecture/product-plugin-compatibility.md) | [本机平台](./architecture/cross-platform.md) |
| 工程 | [贡献](./CONTRIBUTING.md) | [门禁](./engineering-gates.md) |
| 文档维护 | [文档结构](./documentation-structure.md) | [文档指令](./AGENTS.md) |
| 进度与目标 | [MASTER](./progress/MASTER.md) | [架构目标计划](./plan/reprise-architecture-redesign.md) |

## 权威与迁移

product/ 与 architecture/ 描述当前实现的规则；plan/ 拥有尚未关闭的真终端与 Runtime 证据，见[平台矩阵](./plan/2026-09-08-platform-evidence-matrix.md)、[走查修复](./plan/2026-09-08-fe4220-run-remediation.md) 与[进一步审查](./plan/2026-09-08-further-architecture-refactoring-review.md)。所有权决策见[Session harness workflow](./decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)。已落地规则以 accepted ADR 与 architecture/ 为准。

每个批次在同一变更中更新代码、规范、相关 ADR 与证据。通过[迁移差异表](./plan/documentation-reconciliation-for-session-harness-workflow.md)判断哪些旧决定需要被替代。不要在修文档时宣布功能已实现，也不要因旧 ADR 存在而重新讨论已确认目标。

目录边界和维护规则由[文档结构](./documentation-structure.md)拥有；运行进度只记在 MASTER。决策目录可搜索，不在这里手工复制所有 ADR 标题。HTML 是本机非权威草图，公开检出只靠 Markdown 即可理解设计。
