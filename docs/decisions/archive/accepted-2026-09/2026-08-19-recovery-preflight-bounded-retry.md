# 决策：Recovery preflight 的有界 staging 重试

状态：accepted

## 背景

真实 5+5 曾出现 `preflight_failed`：单次 staging copy / 只读检查的短暂失败会使 Recovery Agent 根本无法开始 forensics，即使源目录、其他证据和下一次操作均可用。这与最大努力恢复原则冲突，但盲目无限重试又会隐藏不可用输入或延长失败。

## 决定

Recovery 在 `begin_recovery_staging` 第一次失败后，使用既有脱敏 `recoveryPreflightDiagnostic` 分类。只有 `retryable=true` 的诊断可进行一次重试；重试前写入 `recovery.preflight_retry`，其中只包含第几次尝试和 `reasonCode`、`operation`、`exitCategory`、`retryable`。不保存错误文本、源路径、会话内容或凭据。

第二次失败仍沿用 `recovery.preflight_failed` 和当前安全 fallback。不会把不可读取的 source 伪装为 `insufficient_evidence`，也不会在 staging 尚未建立时调用模型。成功重试后正常进入 maximum-effort forensics；同一 Provider 后续为候选复制树的调用不计作额外 preflight 重试。

## 后果

短暂 staging 故障不再直接剥夺 Agent 调查机会；不可用输入仍有稳定、脱敏、可统计的失败终态。该策略只针对读源并创建隔离副本的 Provider 操作，源目录不写入，重试不能扩大权限或越过 source tripwire。

## 验证

`test/codex-experiment.test.ts` 覆盖首个 copy 失败、第二次 staging 成功并进入 forensics，以及两个 staging 尝试均失败时保留红化 `preflight_failed` 诊断。构建和定向测试均通过。
