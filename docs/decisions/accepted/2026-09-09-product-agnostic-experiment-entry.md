# 决策：产品无关的实验入口与 TUI Recovery 投影

状态：accepted

延续 [LaunchContext](./2026-09-09-candidate-launch-context.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md) 阶段 H、L。

## 问题

Application 入口仍带 Codex 产品前缀，TUI 还持有带 workspace Provider 的 `RecoveryAttempt`。界面因此能直接 discard/accept 隔离副本，而不是只走 `ExperimentWorkflow`。

## 决定

公开入口为 `startExperiment`、`preflightExperiment`、`recoverExperiment`。`ExperimentWorkflow` 在进程内持有 Recovery 活对象，并提供 `discardRecovery` / `acceptRecovery`。TUI 只保存 `RecoveryView`（无 Provider、无 accept 钩子），启动时只传 `recoveryExperimentId`。CLI 与测试仍可向 `start` 传入完整 `recoveryAttempt`（封存 scene、直接编排）。

## 备选方案

**保留 Codex 前缀别名。** 与「不保留旧命名」冲突。

**TUI 继续持有 Provider。** 界面会绕过 Application 控制端口去终止 staging。

## 影响

TUI 确认后不得改 `CandidateLaunchContext`。取消与关闭只调用 workflow 的 discard/accept。

## 验证

`test/architecture.test.ts` 禁止 `src/application` 与 TUI 入口使用 Codex 前缀函数名，并禁止 TUI 引用 `RecoveryAttempt`。`npm run check` 必须通过。
