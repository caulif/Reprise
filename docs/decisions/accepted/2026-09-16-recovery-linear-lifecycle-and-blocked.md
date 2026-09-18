# 决策：Recovery 线性生命周期与 taskOutcome=blocked

状态：accepted
日期：2026-09-16

## 问题

Recovery 应用层仍持有 13 态假设/候选/验证器状态机（`forensics_running` … `exhausted`），以及无写入方的会话字段与评估指标。真实路径是线性的：一个副本、一个 Session、三轮、Host 机械检查后 accept 或停。Agent 信封 `blocked`（缺关键输入，补上后可重跑）被 `taskContinuationOutcome` 一律写成 `unrecoverable`，TUI/评估比事实悲观。`blocked_by_safety` 是安全闸，不能兼作缺输入。

## 决定

应用层生命周期收缩为：

`created → staged → forensics → model → validated → accepted | failed`

标识符与六段语义一一对应。没有第二候选、没有验证器拒绝回流。Agent `blocked` 或 `ready` 但未自动 accept 时停在 `validated`；抛错走 `failed`；自动 accept 走 `accepted`。

`EnvironmentBaseline.recovery.taskOutcome` 增加字面量 `blocked`，与 `blocked_by_safety` 不同。映射：信封 `ready` → `ready_for_task`；信封 `blocked` → `blocked`；安全闸 → `blocked_by_safety`；其余失败仍是 `unrecoverable` / `runner_failed`。TUI 与诊断 `finalStatus` 按「缺关键输入，补上后可重跑」展示 `blocked`，不得显示成无法恢复。

**on-disk。** `RecoveryLifecycleAttempt.schemaVersion` 升为 2。phase 仅为 `staging | forensics | model | validated`；operation 仅为 `begin_staging | resolve_facts | invoke_model | validate`。新写入经 `Value.Check` **拒绝** v1 与旧 phase/operation（`hypothesis`、`candidate`、`verification`、`promotion`、`create_candidate`、`validate_candidate`、`promote_checkpoint`）。历史 `events.jsonl` 的 `payload` 仍是 `unknown`，旧实验可读，但 Host 不得再写出旧形。不迁移磁盘。删除无写入方字段（`hypothesisCount`、`candidateCount`、`verifierRejectionReasons`、`pathBoundaryRejected`、`haltReadinessFeedback`、`readinessSignature`、`noProgressTurns`、`candidateCreated`）及对应评估指标。不改 Recovery Agent 模型轮次语义。

本决定替代 [task outcome 语义](../archive/superseded/2026-08-22-recovery-task-outcome-semantics.md) 中「非 ready 即 unrecoverable」以及 [lifecycle attempts](../archive/accepted-2026-09/2026-08-19-recovery-lifecycle-attempts-and-path-outcomes.md) 中的 13 态转移表与候选拒绝回流。attempt 记录本身仍由 Orchestrator 校验后落盘。

## 备选方案

**保留 13 态、只改文档。** 读者仍会以为存在第二候选和验证器拒绝。

**把 blocked 映射进 `blocked_by_safety`。** 缺输入与越安全边界混在一起，补输入重跑与闸门失败无法区分。

**迁移旧 `recovery.attempt` 到 v2。** 旧实验没有第二候选可还原；拒绝新写入更便宜，且事件 payload 本就未按 attempt schema 重放。

## 影响

[`RecoveryOrchestrator`](../../../src/application/recovery/orchestrator.ts)、[`RecoveryLifecycleAttemptSchema`](../../../src/core/schemas/recovery.ts)、[`taskContinuationOutcome`](../../../src/application/recovery/readiness.ts)、[`userRecoveryStatus`](../../../src/application/recovery/user-status.ts)。确认页不得因 `blocked` 启动候选。不改 Comparison resume，不改 Recovery 三轮模型语义。

## 验证

`test/application/recovery-linear-lifecycle.test.ts`：线性转移成立；旧态名抛错；v1 / 旧 phase 的 attempt 拒绝；`blocked` 信封写入 `taskOutcome=blocked` 且诊断 `finalStatus=blocked`。`test/application/recovery-orchestrator.test.ts` 覆盖 v2 allowlist。`test/application/codex-experiment-recovery-effort.test.ts`：blocked 不再是 `unrecoverable`。`npm run check` 必须通过。反向：写出 `phase: "hypothesis"` 或把信封 `blocked` 写成 `unrecoverable` 即失败。
