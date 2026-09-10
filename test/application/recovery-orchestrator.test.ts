import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryOrchestrator, recoveryAttemptRecord, transitionRecoveryState } from "../../src/application/recovery/orchestrator.js";

test("Recovery lifecycle permits branch rejection without abandoning another candidate", () => {
  let state = transitionRecoveryState("created", "staged");
  state = transitionRecoveryState(state, "forensics_running");
  state = transitionRecoveryState(state, "hypotheses_ready");
  state = transitionRecoveryState(state, "candidate_running");
  state = transitionRecoveryState(state, "candidate_rejected");
  assert.equal(transitionRecoveryState(state, "candidate_running"), "candidate_running");
  assert.throws(() => transitionRecoveryState("staged", "accepted"), /Invalid Recovery lifecycle transition/);
});

test("Recovery lifecycle attempts use a schema-validated operation allowlist", () => {
  assert.deepEqual(
    recoveryAttemptRecord({
      attemptId: "attempt-1",
      phase: "forensics",
      operation: "resolve_facts",
      attemptNumber: 1,
      result: "succeeded",
      durationMs: 12,
      recordedAt: "2026-08-19T00:00:00.000Z",
    }),
    {
      schemaVersion: 1,
      attemptId: "attempt-1",
      phase: "forensics",
      operation: "resolve_facts",
      attemptNumber: 1,
      result: "succeeded",
      durationMs: 12,
      recordedAt: "2026-08-19T00:00:00.000Z",
    },
  );
  assert.throws(
    () => recoveryAttemptRecord({ attemptId: "attempt-2", phase: "forensics", operation: "resolve_facts", attemptNumber: 0, result: "succeeded", durationMs: 0, recordedAt: "2026-08-19T00:00:00.000Z" }),
    /invalid/i,
  );
  assert.throws(
    () => recoveryAttemptRecord({ attemptId: "attempt-3", phase: "forensics", operation: "C:\\Sensitive\\Workspace" as never, attemptNumber: 1, result: "failed", durationMs: 0, recordedAt: "2026-08-19T00:00:00.000Z" }),
    /invalid/i,
  );
});


test("Recovery orchestrator owns durable lifecycle progression and terminal failure", async () => {
  const persisted: string[] = [];
  const orchestrator = new RecoveryOrchestrator({
    onAttempt: (attempt) => { persisted.push(attempt.attemptId); },
  });
  orchestrator.transition("staged");
  orchestrator.transition("forensics_running");
  await orchestrator.recordAttempt({
    attemptId: "attempt-1",
    phase: "forensics",
    operation: "resolve_facts",
    attemptNumber: 1,
    result: "succeeded",
    durationMs: 1,
    recordedAt: "2026-08-19T00:00:00.000Z",
  });
  orchestrator.transition("hypotheses_ready");
  orchestrator.transition("candidate_running");
  orchestrator.fail(false);
  assert.equal(orchestrator.state, "exhausted");
  assert.deepEqual(persisted, ["attempt-1"]);
  assert.equal(orchestrator.attempts.length, 1);
});

test("Recovery orchestrator preserves review-required as a terminal decision", () => {
  const orchestrator = new RecoveryOrchestrator();
  orchestrator.transition("staged");
  orchestrator.transition("forensics_running");
  orchestrator.transition("hypotheses_ready");
  orchestrator.transition("candidate_running");
  orchestrator.transition("candidate_pending_review");
  orchestrator.fail(true);
  assert.equal(orchestrator.state, "review_required");
  orchestrator.fail(false);
  assert.equal(orchestrator.state, "review_required");
});
