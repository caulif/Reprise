import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RecoveryAgentPort } from "../../src/agents/recovery-agent.js";
import { recoverExperiment } from "../../src/application/recovery/recover.js";
import {
  RecoveryOrchestrator,
  recoveryAttemptRecord,
  transitionRecoveryState,
} from "../../src/application/recovery/orchestrator.js";
import { taskContinuationOutcome } from "../../src/application/recovery/readiness.js";
import { userRecoveryStatus } from "../../src/application/recovery/user-status.js";
import { RecoveryLifecycleAttemptSchema, RecoveryTaskOutcomeSchema } from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { now, VerifiedRuntime, input } from "../codex-experiment-support.js";
import type { EnvironmentBaseline } from "../../src/environment/local-workspace-provider.js";

test("Recovery lifecycle is linear created-staged-forensics-model-validated-accepted", () => {
  let state = transitionRecoveryState("created", "staged");
  state = transitionRecoveryState(state, "forensics");
  state = transitionRecoveryState(state, "model");
  state = transitionRecoveryState(state, "validated");
  assert.equal(transitionRecoveryState(state, "accepted"), "accepted");
  assert.throws(() => transitionRecoveryState("staged", "accepted"), /Invalid Recovery lifecycle transition/);
  assert.throws(() => transitionRecoveryState("model", "accepted"), /Invalid Recovery lifecycle transition/);
  assert.throws(
    () => transitionRecoveryState("created", "forensics_running" as never),
    /Invalid Recovery lifecycle transition/,
  );
  assert.throws(
    () => transitionRecoveryState("forensics", "hypotheses_ready" as never),
    /Invalid Recovery lifecycle transition/,
  );
  assert.throws(
    () => transitionRecoveryState("model", "candidate_rejected" as never),
    /Invalid Recovery lifecycle transition/,
  );
});

test("Recovery lifecycle attempts reject v1 and retired phase names", () => {
  const current = recoveryAttemptRecord({
    attemptId: "attempt-1",
    phase: "forensics",
    operation: "resolve_facts",
    attemptNumber: 1,
    result: "succeeded",
    durationMs: 12,
    recordedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(current.schemaVersion, 2);
  assert.equal(Value.Check(RecoveryLifecycleAttemptSchema, current), true);
  assert.equal(
    Value.Check(RecoveryLifecycleAttemptSchema, { ...current, schemaVersion: 1 }),
    false,
  );
  assert.equal(
    Value.Check(RecoveryLifecycleAttemptSchema, { ...current, phase: "hypothesis" }),
    false,
  );
  assert.equal(
    Value.Check(RecoveryLifecycleAttemptSchema, { ...current, phase: "candidate", operation: "invoke_model" }),
    false,
  );
  assert.equal(
    Value.Check(RecoveryLifecycleAttemptSchema, { ...current, operation: "validate_candidate" }),
    false,
  );
  assert.throws(
    () =>
      recoveryAttemptRecord({
        attemptId: "attempt-old",
        phase: "hypothesis" as never,
        operation: "create_candidate" as never,
        attemptNumber: 1,
        result: "succeeded",
        durationMs: 0,
        recordedAt: "2026-09-16T00:00:00.000Z",
      }),
    /invalid/i,
  );
});

test("Orchestrator fail collapses unfinished states to failed, not exhausted", async () => {
  const orchestrator = new RecoveryOrchestrator();
  orchestrator.transition("staged");
  orchestrator.transition("forensics");
  orchestrator.transition("model");
  orchestrator.fail();
  assert.equal(orchestrator.state, "failed");
  orchestrator.fail();
  assert.equal(orchestrator.state, "failed");
});

test("blocked envelope is a distinct taskOutcome, not unrecoverable", () => {
  assert.equal(taskContinuationOutcome("ready"), "ready_for_task");
  assert.equal(taskContinuationOutcome("blocked"), "blocked");
  assert.equal(taskContinuationOutcome("failed"), "unrecoverable");
  assert.equal(Value.Check(RecoveryTaskOutcomeSchema, "blocked"), true);
  assert.equal(Value.Check(RecoveryTaskOutcomeSchema, "blocked_by_safety"), true);
  assert.notEqual("blocked", "blocked_by_safety");
});

test("user recovery status keeps blocked retryable, distinct from failed", () => {
  const baseline = {
    baselineId: "baseline-case",
    caseId: "case",
    mode: "canonical",
    match: "observational",
    resources: [],
    readiness: { runnable: "isolated", strictness: "strict", blockingResourceIds: [] },
    fingerprint: { capturedAt: "2026-09-16T00:00:00.000Z", resources: [], digest: "a".repeat(64) },
    budget: { fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [] },
    capabilities: { canFork: true, fingerprints: ["file_tree"], externalSideEffects: "none" },
    warnings: [],
    createdAt: "2026-09-16T00:00:00.000Z",
    recovery: {
      status: "blocked",
      summary: "Required input is missing.",
      unresolved: ["sheet.xlsx"],
      sourceDigest: "a".repeat(64),
      recoveredDigest: "a".repeat(64),
      taskOutcome: "blocked",
    },
  } as EnvironmentBaseline;
  assert.equal(userRecoveryStatus({ baseline, transcriptOk: true }), "blocked");
});

test("recoverExperiment writes blocked taskOutcome and diagnosis for a blocked envelope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-blocked-outcome-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "# source\n");
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe spreadsheet is missing.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "blocked-outcome",
        value: {
          status: "blocked",
          summary: "Required spreadsheet is missing from source.",
          reportPath: "recovery.md",
          unresolved: ["workbook.xlsx"],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-blocked-outcome",
    runId: "recovery-blocked-outcome-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "blocked");
  assert.equal(attempt.baseline.recovery?.taskOutcome, "blocked");
  assert.notEqual(attempt.baseline.recovery?.taskOutcome, "unrecoverable");
  assert.notEqual(attempt.baseline.recovery?.taskOutcome, "blocked_by_safety");
  const diagnosis = JSON.parse(
    await readFile(join(attempt.experimentRoot, "recovery-diagnosis.json"), "utf8"),
  ) as { finalStatus: string };
  assert.equal(diagnosis.finalStatus, "blocked");
  const lifecycle = JSON.parse(
    await readFile(join(attempt.experimentRoot, "artifacts", "recovery-attempts"), "utf8"),
  ) as { state: string; attempts: { schemaVersion: number; phase: string }[] };
  assert.equal(lifecycle.state, "validated");
  assert.ok(lifecycle.attempts.every((item) => item.schemaVersion === 2));
  assert.equal(typeof attempt.accept, "undefined");
});
