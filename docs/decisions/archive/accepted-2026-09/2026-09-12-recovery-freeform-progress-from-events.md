# 决策：Recovery 自由轮次进度从事件日志恢复

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-12

## 问题

进程内计数（无论挂在 Recovery Agent 还是 Session Host）在进程重启、Session 重建或同一 continuity key 新建 Session 后归零，会重复执行 understand/restore。Session 应只持有模型会话资源，不能成为业务阶段事实源。

## 决定

understand/restore 完成时，`agent.invocation_completed` 的 `payload.requestId` 分别为 `recovery-freeform-understand` 与 `recovery-freeform-restore`。Host 每次调用 `recover()` 前用 `completedRecoveryFreeformTurns(store.events(runId))` 写入 `RecoveryContext.completedFreeformTurns`。工作区重置写入 `recovery.workspace_reset`（或 `recovery.model_retry` 且 `previousFailure === "workspace_damaged"`），进度归零。该字段不进入模型工作集。

## 备选方案

**Session 内存计数。** 重启后无法恢复阶段。

**独立 `recovery.phase_completed` 事件。** 与已有 invocation 完成事件重复；当前用带标签的 invocation 即可稳定推导。

## 影响

旧日志没有这些 `requestId` 时进度视为 0，可能重跑自由轮次。新 Session 在同一工作副本上继续时必须带上从事件算出的计数。

## 验证

`test/application/recovery-envelope.test.ts`：失败信封后第二次 `recover` 使用事件推导的计数，understand 提示只出现一次；`workspace_damaged` 后计数为 0。`test/core/architecture.test.ts`：`session.ts` 不得含 `completedFreeformTurns`。反向：再次把进度存在 Session 字段上时架构测试失败。
