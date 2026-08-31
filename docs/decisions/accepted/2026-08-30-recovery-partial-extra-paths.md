# Partial 恢复允许额外工作区变更并保留预览

## 背景

真实会话走查里 Recovery 写出 TypeBox 通过的 `partial` envelope，Verifier 为 `pending_user_review`，但 Provider `validateManifest` 要求 manifest 路径集合与实际变更**全等**。模型漏报若干删除路径时，staging 被丢弃，用户只看到无法恢复、没有 `accept`。

## 决策

- `status=recovered`：manifest 路径集合必须与变更全等（不变）。
- `status=partial`：每条 manifest action 必须对应一次实际变更；**允许**额外变更（记入 unresolved / warnings，不丢弃 preview）。
- 校验通过的 partial preview **必须**暴露 `accept`。确认页按[无 accept 不得开跑](./2026-08-30-recovery-failed-blocks-candidate.md)：有 accept 则为部分恢复，限制可见；无 accept 才是无法恢复。

## 放弃的方案

- 弱证据自动 `acceptRecovery` 并默默开跑。
- 放宽 `recovered` 的路径全等。
- 为了保住 preview 而跳过证据引用校验。
