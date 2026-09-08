# 决策：Recovery 连续 Session

状态：accepted

目标批次见 [M2.2](../../plan/reprise-refactoring-execution.md#m22-recovery-连续-session-与停止语义)。

## 问题

`PiAgentHost.request` 为每次 `recover()` 新建 Session 并在返回后 `close`。调查、就绪反馈和信封修复因此丢掉对话历史。证据不足时若仍挂上 `accept`，TUI 会把 `insufficient_evidence` 当成可启动的 partial。

## 决定

`RecoveryAgent` 按 `RecoveryContext.continuityKey` 复用 `AgentSessionHost`。一次准备的主调查与就绪反馈共用 `experimentId`；另选候选再执行使用 `experimentId:candidateId`。结构化修复仍在同一次 Invocation 内。准备结束时 `releasePreparation(experimentId)` 关闭该实验下全部 Recovery Session。`continuityKey` 不进入模型工作集。

信封 `insufficient_evidence` 停止就绪反馈循环，不再为补路径继续要模型。诊断标 `failed`，不暴露 `accept`。TUI/CLI 不传入 `allowCurrentStateFallback`。`userRecoveryStatus` 对不足证据和 `runnable=blocked` 恒为 failed。Schema 修复仍走 Host 有界 repair；缺证据走停止。

## 备选方案

**继续每轮 `host.request`。** 反馈轮看不到工具与摘要历史。

**不足证据仍提供 accept，由确认页文案劝退。** 确认页 Enter 仍可能启动候选。

**就绪缺口一律再问模型直到次数用尽。** 会用循环补造不存在的证据。

## 影响

同一 `continuityKey` 的第二次 `recover()` 不再 `createSession`。不足证据不能进入候选选择。测试可用 `allowCurrentStateFallback` 发布当前树，产品路径没有该开关。

## 验证

`test/recovery-envelope.test.ts`：调查后再带 `readinessFeedback` 调用，只创建一次 Pi Session。`test/codex-experiment-recovery-effort.test.ts`：`insufficient_evidence` 不进入就绪循环且无 accept。`test/recovery-user-status.test.ts` 与 `test/tui-workflow.test.ts`：不足/blocked 不能启动。`test/architecture.test.ts`：TUI/CLI 不含 fallback opt-in。
