# 决策：Recovery 准入后的不可变 CandidateLaunchContext

状态：accepted

延续 [CandidateRun 活动所有权](./2026-09-08-candidate-run-activity-ownership.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md) 阶段 D。

## 问题

隔离 workspace 在 `prepareRun` 之后即可启动 CandidateRun，但交接事实没有单独、可校验的不可变对象。workspace 若落在实验根之外，或 Recovery 未物化 observations，仍可能创建运行。

## 决定

Host 在创建 CandidateRun 之前写入 `runs/{runId}/candidate-launch.json`。对象是 `CandidateLaunchContext`：experimentId、runId、隔离 workspaceRoot、productId、requestedModel、resolvedModel、permissions。持久化前 `Value.Check`。workspace 必须包含在 experimentRoot 内。存在 `recoveryAttempt` 时还要求 `observations/INDEX.md` 可读。检查失败抛错，不创建 CandidateRun。

## 备选方案

**把交接字段散落在 RunManifest。** Manifest 已有 runtime/environment，但缺少「Recovery 完成后才允许启动」的单独准入点。

**允许 Application 在检查失败后仍创建 Run 再立刻 finalizing。** 会留下半成品候选状态。

## 影响

TUI 确认后不得改 launch 文件。产品原始会话路径不进入该对象。

## 验证

`test/candidate-launch.test.ts`：schema 通过、根外 workspace 拒绝、缺 observations 拒绝。`npm run check` 必须通过。
