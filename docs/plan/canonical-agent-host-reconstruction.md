# Canonical Agent Host Reconstruction Plan

> Status: in progress
> Date: 2026-08-12
> Authoritative semantic sources: `docs/architecture/*.md`, especially `agent-roles-and-system-prompts.md`; migration checklist: `docs/analysis/current-implementation-gap-and-correction-plan.md`.

## Objective and Done-means

Rebuild Reprise around three isolated, tool-capable model sessions and a deterministic Host. Completion requires the recovery, controller, comparison, evidence, persistence, TUI/reporting, and test contracts in section 12 of the correction plan to be implemented—not merely documented.

Evidence required before completion:

1. `npm run typecheck` passes.
2. The directly affected Node tests pass after one build, including new tests proving the contracts below.
3. A requirement-by-requirement audit against the correction plan's sections 3, 7, 9, 11, and 12 identifies no unimplemented canonical behavior.
4. A local deterministic end-to-end fixture produces immutable recovery/evidence/comparison artifacts and remains renderable after all model callers are removed from the process.

Non-goals: a workflow DSL, a second event store, generic plugin infrastructure, arbitrary Controller shell access, or backwards-compatible execution paths that retain `stop` or domain-result fallbacks.

## Current-State Findings

The existing `ExperimentStore`, Candidate runtime lifecycle, workspace isolation, and TUI interaction shell are retained. The present `PiAgentHost` is a one-shot `completeSimple` JSON wrapper: it has neither sessions nor registered tools. That root issue causes Recovery to only plan, Controller to lose continuity and manufacture `done`, and Comparison to receive summaries rather than inspectable evidence.

The current worktree also includes a separate partially completed TUI/Codex workflow change. This reconstruction must preserve its working runtime, persistence, and timeline improvements while replacing the incorrect Agent contracts beneath it.

## Dependency Order

| Phase | Deliverable | Depends on | Acceptance focus |
|---|---|---|---|
| 0 | Canonical types, prompt versions, no fabricated Agent values | none | `send | done`; invocation failures discriminated |
| 1 | `AgentSessionHost` and Pi adapter with real session/tool loop/audit | 0 | persistent session, tools execute through Host, timeout/cancel events |
| 2 | Logical-root tool policy and evidence catalog/query adapters | 1 | path, ownership, privacy, size, and truncation enforcement |
| 3 | Executing Recovery coordinator and provider validation/freeze | 1–2 | staging-only mutation, recovery.md, command/file/network audit |
| 4 | Controller coordinator and RunOutcome projector | 1–2 | one session per run, incremental observations, no `stop`/fallback completion |
| 5 | Comparison coordinator with `comparison.md` and artifact-led queries | 1–2, evidence capture | free report, evidence refs, insufficient-evidence state |
| 6 | Capture full candidate evidence before release; TUI/HTML projections | 2, 4–5 | facts/narrative separation and replay without model |
| 7 | Remove legacy completion paths and complete system acceptance matrix | 0–6 | no legacy contracts reachable |

## Execution Rules

- The Host records lifecycle and tool facts; agent prose cannot modify `RunOutcome` or immutable facts.
- A failed, timed out, cancelled, or privacy-blocked agent invocation has no fabricated domain value.
- File tools use logical root plus relative path; absolute paths and traversal are rejected before filesystem access.
- Recovery has staging-only writes; Controller and Comparison only receive read tools.
- Each phase adds its smallest direct test. Tests exercise Host enforcement, not only prompt text.

## Phase 0–1 Task Breakdown

1. Add an explicit `AgentInvocation<T>` discriminated union and an independent `AgentSessionHost` boundary. Keep `PiModelCaller.completeSimple` only for connection probing.
2. Add a Pi-backed session driver around `@earendil-works/pi-agent-core`'s `Agent`, so tool definitions are registered and executed by a real loop.
3. Add session/tool audit sink events and direct unit tests for session isolation, tool execution, timeout/cancellation, privacy suppression, and absence of fallback values.
4. Migrate each agent's public contract one at a time, starting with Controller's `send | done` type and failure handling.

## Risks / Replan Triggers

- The Pi version may expose incompatible tool-schema runtime behavior. If its real loop cannot accept the current TypeBox schema, use the installed `typebox` package at the adapter boundary and preserve the public schema layer.
- The pre-existing uncommitted TUI work overlaps orchestrator files. Integrate rather than discard it; do not reset unrelated user work.
- A real provider smoke is explicitly opt-in and is not a completion substitute for deterministic contract tests.
