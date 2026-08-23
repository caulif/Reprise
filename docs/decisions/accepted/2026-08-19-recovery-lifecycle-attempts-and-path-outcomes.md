# 2026-08-19 Recovery lifecycle attempts and path outcomes

## Context

Recovery already preserved isolated candidates, controlled-write journals, and Provider verification, but its persisted review artifacts did not distinguish task recovery effects from delivery files such as `recovery.md`. Operation failures also lacked one uniform, schema-checked lifecycle record.

## Decision

- Persist a schema-validated `RecoveryLifecycleAttempt` event/artifact record for the Recovery lifecycle. It contains only phase, operation identifier, candidate identifier, retry ordinal, redacted failure code, duration, and timestamp.
- Keep the Recovery lifecycle transition table in `src/application/recovery-orchestrator.ts`; it is deliberately Recovery-specific rather than a generic workflow abstraction.
- Derive candidate `pathOutcomes` from Provider fingerprints. `recovery.md` and `recovery-manifest.json` remain auditable delivery artifacts but are excluded from `recoveredPaths`, candidate verification scope, and recovery-effect summaries.
- Do not claim semantic truth from a path outcome. `verified`, `accepted`, and hidden-truth `truth-passed` remain distinct promotion layers.

## Consequences

Review and evaluation no longer report a report-only candidate as a recovered task path. The new artifact is an on-disk protocol addition and is validated before persistence. Candidate rejection still permits transition to another candidate; it is not an implicit global failure.

## Follow-up: dynamic candidate expansion

A submitted Recovery plan may introduce a new hypothesis only when every fact reference is already Host-owned and path validation succeeds. A non-empty, newly proposed operation sequence can create another isolated Provider candidate when its bounded search decision permits it; a no-new-evidence decision is retained when the distinct operation sequence has explicit counterfactual value. The original candidate and all already-created alternates remain in the graph. Expansion is recorded as a normal candidate creation attempt and event, not treated as model-declared success.

## Follow-up: privacy and terminal lifecycle closure

`recovery_model_input` artifacts now contain only a schema-versioned structural audit envelope, tool names, bounded counts, Host-owned fact identifiers, and one-way content digests. The model receives the full context only in memory; task text, transcript text, and workspace paths are not persisted in that artifact.

The main flow now records `selected_checkpoint` after verified Provider validation and records `accepted` after the Provider accepts the selected preview. Pending candidates remain `candidate_pending_review`. Failure paths write a terminal `recovery-attempts` artifact with a safe terminal reason; cleanup failures emit `recovery.cleanup_failed` and force runner review semantics. Lifecycle operation names use a fixed allowlist rather than arbitrary strings.


## RecoveryOrchestrator ownership

Recovery 生命周期由 `src/application/recovery-orchestrator.ts` 中的 `RecoveryOrchestrator` 持有。它统一负责状态推进、schema 校验后的 attempt 记录和失败终态收口；`experiment.ts` 仅编排 Provider、forensics、candidate 与 promotion 的领域操作，并通过该端口持久化审计事件。这样避免领域操作直接修改生命周期状态，也为后续按窄端口提取 forensics、candidate executor 和 promotion 留下稳定边界。
