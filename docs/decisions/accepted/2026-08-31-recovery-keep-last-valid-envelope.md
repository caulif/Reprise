# 决策：后一次完成信封不得覆盖已通过探测的完成信封

状态：accepted

## 问题

Readiness 反馈轮若**模型请求失败**，Host 会保留上一份 TypeBox 通过的完成信封。后一次会话若同样 `completed`，Host 会用它覆盖 `lastCompletedRecovery`，再做 Provider 校验。后一份信封可以 TypeBox 通过但证据或 manifest 对不上实际变更；校验拒绝会丢弃 staging。第一次已经落地的 `partial` 与可审查 preview 整单变成 `current_state_fallback`，确认页没有 accept。

[Partial 额外路径](./2026-08-30-recovery-partial-extra-paths.md)只覆盖「manifest 漏报路径仍可校验」。它不覆盖「后一次完成信封替换前一次已能探测通过的信封」。

## 决定

反馈轮得到新的 `completed` 信封时，先对**当前 staging** 做不丢弃副本的探测（证据引用 + manifest 与变更一致，规则与 `validateRecovery` 相同，不 unlink、不 `discardRecovery`）。

- 探测通过：该信封成为 `lastCompletedRecovery`。
- 探测失败且已有上一份完成信封：恢复上一份，保留 staging，停止继续反馈，记 `recovery.warning`。不得为此跳过证据校验，也不得对失败信封 `acceptRecovery`。沿用的上一封若随后 `validateRecovery` 通过，按[校验通过预览自动接受](./2026-08-31-recovery-auto-accept-validated-preview.md)发布。
- 没有任何完成信封能通过探测：仍走 fallback，无 accept。

源目录 tripwire 失败仍是硬失败，不靠「沿用上一封」掩盖。

## 备选方案

**后一次 TypeBox 通过的完成信封一律覆盖前一次。** 实现简单，但会把已可审查的 partial 作废。

**校验失败时跳过证据引用以保住 preview。** 与 [Partial 额外路径](./2026-08-30-recovery-partial-extra-paths.md) 已放弃的方案相同。

**探测失败也调用 `validateRecovery`。** 失败路径会丢弃 staging，无法沿用上一封。

## 影响

Host 在覆盖完成信封前必须能探测且失败时不销毁 staging。确认页有 accept 时仍是部分恢复并可开跑；无 accept 才是无法恢复。

## 验证

`test/codex-experiment-recovery-effort.test.ts`：第一次 valid `partial` 后第二次故意无效完成信封，结果有 accept、match 为 `recovered_partial`；只有一份无效完成信封则无 accept。`npm run check` 覆盖构建、静态门禁和全量测试。
