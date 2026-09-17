# Reprise 重构历史批次索引

M1.1–M7 实施步骤已关闭。本文仅为既有 ADR 入站链接保留批次锚点与决策定位，不是活跃施工计划；新工作不要重跑 M1.1–M7。完整施工正文与逐步验证记录保存在本路径的 Git 历史中。

实施关闭不等于全部验收关闭：TUI 真终端、Controller 真实模型 lane、Runtime smoke 与生产模型输入对拍的未关闭证据统一见[证据矩阵](./2026-09-08-platform-evidence-matrix.md)，当前工作与短证据见 [MASTER](../progress/MASTER.md)。本文不维护第二份验收台账。

当前行为以[架构总览](../architecture/overview.md)与[产品规范](../product/overview.md)为准；目标语义见[架构目标](./reprise-architecture-redesign.md)、[TUI 目标](./reprise-tui-design.md)，当前差异见[迁移边界](./documentation-reconciliation-for-session-harness-workflow.md)。下列标题只保留历史定位，不下达执行指令；历史决定的有效范围以各 ADR 状态及替代链接为准。

## 3. M1：Agent 执行机制与唯一持久化事实源

### M1.1 建立基线并验证 Pi 的实际能力

决策：[事实源与身份](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)。

### M1.2 分开 Session 生命周期与 Invocation 生命周期

决策：[Session 与 Invocation 生命周期](../decisions/accepted/2026-09-08-session-invocation-lifecycle.md)。

### M1.3 完整记录并可重建模型输入

决策：[模型输入重建](../decisions/accepted/2026-09-08-model-input-reconstruction.md)。

### M1.4 历史兼容与只读重开

决策：[历史只读兼容](../decisions/accepted/2026-09-08-history-readonly-compat.md)。

## 4. M2：harness、Recovery、封存场景与运行生命周期

### M2.1 收拢业务所有权

决策：[角色副作用所有权](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)。

### M2.2 Recovery 连续 Session 与停止语义

决策：[Recovery 连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)。

### M2.3 场景封存与重复运行

决策：[场景封存与重复运行](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md)。

### M2.4 CandidateRun 与活动所有权

决策：[CandidateRun 活动所有权](../decisions/accepted/2026-09-08-candidate-run-activity-ownership.md)。

## 5. M3：Controller 单 Session 与用户协作行为

### M3.1 合并首次理解与 opening

历史决策：[opening 同 Session](../decisions/superseded/2026-09-08-controller-opening-single-session.md)；替代决策：[先理解再按视图决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md)。

### M3.2 验证协作语义和投递边界

决策：[协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)。

## 6. M4：Comparison 单 Session 与独立执行

决策：[单 Session 对照](../decisions/accepted/2026-09-08-comparison-single-session.md)。

## 7. M5：共用 Workflow、完整 CLI 与键盘 TUI

### M5.1 提取与界面无关的应用操作

决策：[共用实验操作](../decisions/accepted/2026-09-08-shared-experiment-operations.md)。

### M5.2 CLI 查询、配置与机器协议

决策：[CLI 查询与机器协议](../decisions/accepted/2026-09-08-cli-query-config-protocol.md)。

### M5.3 TUI 选择与配置流程

决策：[TUI 选择与配置按键](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)。

### M5.4 单实验连续时间线

决策：[公开活动持久化与单列时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md)。

### M5.5 阅读、搜索与终端交互

决策：[阅读锚点、搜索与终端恢复](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)。

## 8. M6：跨平台本机控制与可扩展 Pack

### M6.1 明确原生平台语义

决策：[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。

### M6.2 跨终端 cancel

决策：[跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md)。

### M6.3 版本化本地插件边界

决策：[版本化本地 Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。

### M6.4 独立第三 Pack 与平台证明

决策：[第三 Pack 与平台证据](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md)。

## 9. M7：旧实现删除、规范生效与交付

决策：[M7 收口与未关闭验收](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。验收缺口以[证据矩阵](./2026-09-08-platform-evidence-matrix.md)为准，不以本索引的实施关闭声明替代。
