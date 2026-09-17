# Reprise 重构进度

## 当前批次

文档计划出清：保留真实开放目标，归档结束的施工与审查记录。当前实现以[架构总览](../architecture/overview.md)和[产品规范](../product/overview.md)为准；目标与规范迁移见[迁移边界](../plan/documentation-reconciliation-for-session-harness-workflow.md)。

## 未关闭验收

- 真终端、Runtime smoke、Controller 真实模型 lane 与生产模型输入对拍统一见[证据矩阵](../plan/2026-09-08-platform-evidence-matrix.md)。本批未运行任何付费或真实 Runtime 验收。
- [N6 Recovery+Controller 新复刻验收](../plan/2026-09-16-share-card-and-n6-replay.md)保持 OPEN：尚无显式 opt-in 新跑的完整通过证据；任务前 baseline 与无未见建议的开场须同时核对，旧 sink、旧轨迹或重渲染卡面不能替代。
- Recovery 默认空 staging 目标见[最小 Host](../plan/recovery-agent-minimum-host.md#91-provider从整树播种改为空-staging)；当前 [beginRecovery](../../src/environment/local-workspace-provider.ts) 仍复制预算内 source 或 checkpoint，超预算才使用 sparse。
- Recovery 基线复用前的运行条件检查与缺失条件修补仍须验证，见[起点恢复目标](../plan/recovery-initial-environment.md)。不能因独立副本复制成功而关闭此项。

## 最近完成证据

2026-09-17 文档与协作流程（Phase 0–4）：计划目录从 42 份收敛为 7 份开放目标、1 份历史批次索引与 1 份可复用模板；N6、平台与 Recovery 缺口保留。`npm run verify:docs` 退出 0（8 种坏输入自检均被拒绝），`git diff --check` 退出 0。范围仅文档与协作入口，未运行代码门禁或付费验收；立场见[轻量流程决策](../decisions/accepted/2026-09-17-docs-workflow-solo-to-oss.md)。

历史记录（非本批重跑）：2026-09-16 `npm run check` 为 1023 pass / 4 skip；对应[历史会话与当前会话标签](../decisions/accepted/2026-09-16-comparison-session-labels.md)、[冻结嵌套 Git](../decisions/accepted/2026-09-16-freeze-nested-git-discovery.md)、[任务前 HEAD](../decisions/accepted/2026-09-16-recovery-pre-task-head.md)和[开场约束](../decisions/accepted/2026-09-16-controller-opening-no-unseen-advice.md)。这不是平台、模型能力或全部 Recovery 目标的完成证明。

M1.1–M7 实施步骤已关闭；[历史批次索引](../plan/reprise-refactoring-execution.md)仅保留 ADR 定位，完整施工正文见该路径 Git 历史，收口边界见[M7 收口决策](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。未关闭证据以上述入口为准，不重新执行已关闭施工清单。

## 更新约定

只保留当前批次、可复核证据与未关闭项入口；验证结果区分历史记录和本批执行。没有证据不标为完成，不保存逐轮对话或重复任务清单。
