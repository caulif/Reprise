import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryOrchestrator, recoveryAttemptRecord, transitionRecoveryState } from "../../src/application/recovery/orchestrator.js";

test("Recovery lifecycle rejects skipped phases and retired candidate loops", () => {
  let state = transitionRecoveryState("created", "staged");
  state = transitionRecoveryState(state, "forensics");
  state = transitionRecoveryState(state, "model");
  state = transitionRecoveryState(state, "validated");
  assert.equal(transitionRecoveryState(state, "failed"), "failed");
  assert.throws(() => transitionRecoveryState("staged", "accepted"), /Invalid Recovery lifecycle transition/);
  assert.throws(() => transitionRecoveryState("validated", "model"), /Invalid Recovery lifecycle transition/);
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
      schemaVersion: 2,
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
  orchestrator.transition("forensics");
  await orchestrator.recordAttempt({
    attemptId: "attempt-1",
    phase: "forensics",
    operation: "resolve_facts",
    attemptNumber: 1,
    result: "succeeded",
    durationMs: 1,
    recordedAt: "2026-08-19T00:00:00.000Z",
  });
  orchestrator.transition("model");
  orchestrator.fail();
  assert.equal(orchestrator.state, "failed");
  assert.deepEqual(persisted, ["attempt-1"]);
  assert.equal(orchestrator.attempts.length, 1);
});

test("Recovery orchestrator preserves failed as the terminal decision", () => {
  const orchestrator = new RecoveryOrchestrator();
  orchestrator.transition("staged");
  orchestrator.transition("forensics");
  orchestrator.transition("model");
  orchestrator.transition("validated");
  orchestrator.fail();
  assert.equal(orchestrator.state, "failed");
  orchestrator.fail();
  assert.equal(orchestrator.state, "failed");
});
