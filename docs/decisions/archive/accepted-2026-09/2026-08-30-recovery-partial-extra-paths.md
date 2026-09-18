# 决策：Partial 恢复允许额外工作区变更并保留预览

状态：accepted

## 问题

真实会话走查里 Recovery 写出 TypeBox 通过的 `partial` envelope，Verifier 为 `pending_user_review`，但 Provider 校验曾要求 manifest 路径集合与实际变更**全等**。模型漏报若干删除路径时，staging 被丢弃，用户只看到无法恢复、没有 `accept`。

## 决定

- `status=recovered`：变更清单必须与实际变更全等。
- `status=partial`：清单中的每条 action 必须对应一次实际变更；**允许**额外变更（记入 unresolved / warnings，不丢弃 preview）。
- 校验通过的 partial preview **必须**能被接受。确认页按[无 accept 不得开跑](./2026-08-30-recovery-failed-blocks-candidate.md)：有 accept 则为部分恢复，限制可见；无 accept 才是无法恢复。

## 备选方案

**弱证据自动 `acceptRecovery` 并默默开跑。** 把计费候选绑在未校验树上。

**放宽 `recovered` 的路径全等。** 已恢复会掩盖未声明的额外变更。

**为了保住 preview 而跳过证据引用校验。** 放弃 Host 对 staging 的证据约束。

## 影响

partial 只要合法变更通过校验，就能留下可审查 preview，而不是因漏报路径整单作废。后续变更清单来源见 [fingerprint 差](./2026-08-31-recovery-fingerprint-changeset.md)；校验通过后的自动接受见 [自动接受](./2026-08-31-recovery-auto-accept-validated-preview.md)。

## 验证

`test/codex-experiment-recovery-envelope.test.ts`：partial 额外路径仍能 preview。反向：recovered 仍拒绝未对齐的变更集合。`npm run check`。
