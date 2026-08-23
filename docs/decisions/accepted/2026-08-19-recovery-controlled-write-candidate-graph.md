# Recovery 受控写入与候选图审查边界

- 日期：2026-08-19
- 状态：accepted

## 决策

Recovery 在弱证据下仍创建并执行最高证据候选，但不得在执行后无条件销毁其他候选。其余候选作为 Provider-owned 隔离分支保留，状态为 `pending_user_review`，并为每个候选生成独立的审查摘要 artifact。候选图通过 `recovery-candidate-graph` immutable artifact 固化，事件只保存候选、状态和 artifact ref。

受控写入 journal 的成功后态必须通过 content-addressed artifact 复原字节。`replayControlledRecoveryDeltaBytes` 会拒绝缺少 postimage artifact 或 hash/size 不匹配的记录；metadata hash 不能单独作为文件内容。

## 原因

弱证据表示语义不确定，不表示没有调查价值。保留 alternate hypotheses 让人工审查比较事实、验证状态和差异，同时不把未执行候选伪装成已验证结果。Provider 在 recovery staging 被接受或丢弃时统一回收候选目录，避免分支长期泄漏。

## 边界

- `pending_user_review` 不是自动接受，也不是恢复正确性的证明。
- 候选图只引用事实、hash、diff/review artifact，不写入凭据或未获允许的正文。
- `staging_shell` 仍是 external/unobserved writer，不进入 direct-write byte replay。
- 用户源目录仍受 source tripwire、路径边界、manifest/hash verifier 和显式 accept 保护。
