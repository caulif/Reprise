# Reprise 重构实施计划（历史索引）

M1.1–M7 实施步骤已于 2026-09-08 关闭。本文仅供既有 ADR 的批次定位与历史锚点，**不是**待办清单，**不要**重跑 M1.1–M7 施工步骤。当前规范见[架构总览](../architecture/overview.md)与[产品定义](../product/overview.md)；开放验收见 [MASTER](../progress/MASTER.md)与[平台证据矩阵](./2026-09-08-platform-evidence-matrix.md)。

目标语义仍以[架构目标](./reprise-architecture-redesign.md)与[TUI 目标](./reprise-tui-design.md)为准；当前与目标的差异见[迁移边界](./documentation-reconciliation-for-session-harness-workflow.md)。M7 收口与仍开放的验收项见[M7 收口决策](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。

## 批次与 ADR 对照

| 批次 | 主题 | 决策记录 |
|---|---|---|
| M1.1 | 基线与 Pi 能力 | [事实源与身份](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md) |
| M1.2 | Session / Invocation 生命周期 | [生命周期](../decisions/accepted/2026-09-08-session-invocation-lifecycle.md) |
| M1.3 | 模型输入重建 | [模型输入重建](../decisions/accepted/2026-09-08-model-input-reconstruction.md) |
| M1.4 | 历史只读兼容 | [历史兼容](../decisions/accepted/2026-09-08-history-readonly-compat.md) |
| M2.1 | 业务所有权 | [角色副作用](../decisions/accepted/2026-09-08-role-side-effect-ownership.md) |
| M2.2 | Recovery 连续 Session | [Recovery 连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md) |
| M2.3 | 场景封存 | [场景封存](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md) |
| M2.4 | CandidateRun 活动 | [活动所有权](../decisions/accepted/2026-09-08-candidate-run-activity-ownership.md) |
| M3.1 | Opening 单 Session | [Opening 单 Session](../decisions/superseded/2026-09-08-controller-opening-single-session.md) |
| M3.2 | 协作与投递 | [协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md) |
| M4 | Comparison 单 Session | [单 Session 对照](../decisions/accepted/2026-09-08-comparison-single-session.md) |
| M5.1 | 共用应用操作 | [共用操作](../decisions/accepted/2026-09-08-shared-experiment-operations.md) |
| M5.2 | CLI 查询与配置 | [CLI 协议](../decisions/accepted/2026-09-08-cli-query-config-protocol.md) |
| M5.3 | TUI 选择与配置 | [TUI 选择](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md) |
| M5.4 | 活动时间线 | [公开时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md) |
| M5.5 | 阅读与终端 | [阅读与终端](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md) |
| M6.1 | 原生平台语义 | [平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md) |
| M6.2 | 跨终端 cancel | [跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md) |
| M6.3 | 本地 Pack 边界 | [Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md) |
| M6.4 | 第三 Pack 与平台证明 | [第三 Pack](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md) |
| M7 | 收口与交付 | [M7 收口](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md) |

## ADR 锚点（已关闭）

下列标题仅保留入站链接锚点；细节以上表 ADR 与 MASTER 为准。

### M1.1 建立基线并验证 Pi 的实际能力

已关闭（2026-09-08）。见 [事实源与身份](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)。

### M1.2 分开 Session 生命周期与 Invocation 生命周期

已关闭（2026-09-08）。见 [生命周期](../decisions/accepted/2026-09-08-session-invocation-lifecycle.md)。

### M1.3 完整记录并可重建模型输入

已关闭（2026-09-08）。见 [模型输入重建](../decisions/accepted/2026-09-08-model-input-reconstruction.md)。

### M1.4 历史兼容与只读重开

已关闭（2026-09-08）。见 [历史兼容](../decisions/accepted/2026-09-08-history-readonly-compat.md)。

### M2.1 收拢业务所有权

已关闭（2026-09-08）。见 [角色副作用](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)。

### M2.2 Recovery 连续 Session 与停止语义

已关闭（2026-09-08）。见 [Recovery 连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)。

### M2.3 场景封存与重复运行

已关闭（2026-09-08）。见 [场景封存](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md)。

### M2.4 CandidateRun 与活动所有权

已关闭（2026-09-08）。见 [活动所有权](../decisions/accepted/2026-09-08-candidate-run-activity-ownership.md)。

### M3.1 合并首次理解与 opening

已关闭（2026-09-08）。见 [Opening 单 Session](../decisions/superseded/2026-09-08-controller-opening-single-session.md)。

### M3.2 验证协作语义和投递边界

已关闭（2026-09-08）。见 [协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)。

## 6. M4：Comparison 单 Session 与独立执行

已关闭（2026-09-08）。见 [单 Session 对照](../decisions/accepted/2026-09-08-comparison-single-session.md)。

### M5.1 提取与界面无关的应用操作

已关闭（2026-09-08）。见 [共用操作](../decisions/accepted/2026-09-08-shared-experiment-operations.md)。

### M5.2 CLI 查询、配置与机器协议

已关闭（2026-09-08）。见 [CLI 协议](../decisions/accepted/2026-09-08-cli-query-config-protocol.md)。

### M5.3 TUI 选择与配置流程

已关闭（2026-09-08）。见 [TUI 选择](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)。

### M5.4 单实验连续时间线

已关闭（2026-09-08）。见 [公开时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md)。

### M5.5 阅读、搜索与终端交互

已关闭（2026-09-08）。见 [阅读与终端](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)。

### M6.1 明确原生平台语义

已关闭（2026-09-08）。见 [平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。

### M6.2 跨终端 cancel

已关闭（2026-09-08）。见 [跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md)。

### M6.3 版本化本地插件边界

已关闭（2026-09-08）。见 [Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。

### M6.4 独立第三 Pack 与平台证明

已关闭（2026-09-08）。见 [第三 Pack](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md)。

## 9. M7：旧实现删除、规范生效与交付

已关闭（2026-09-08）。仍开放的验收项见[平台证据矩阵](./2026-09-08-platform-evidence-matrix.md)与 [M7 收口](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。
