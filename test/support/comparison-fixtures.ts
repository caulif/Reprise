import type { RunRecord, TaskCase } from "../../src/core/schema.js";
import type { ComparisonContext } from "../../src/agents/comparison-agent.js";

const timestamp = "2026-08-15T00:00:00.000Z";

export function taskCase(): TaskCase {
  return {
    schemaVersion: 1, caseId: "case-1", source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "修复报告。" },
    transcript: [{ id: "message-1", role: "user", text: "修复报告。" }],
    historicalEvents: [],
    baseline: { status: "available", finalMessage: "Done.", artifactRefs: [], evidenceRefs: ["event:baseline-1"] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "fixture", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}

export function runRecord(): RunRecord {
  return {
    attempt: {
      schemaVersion: 1, runId: "run-1", experimentId: "experiment-1", caseId: "case-1",
      candidate: { candidateId: "candidate-1", productId: "codex", requestedModel: "gpt-5.6" },
      policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 },
      createdAt: timestamp,
    },
    state: "finished", stageReached: "awaiting_controller",
    outcome: {
      task: { status: "incomplete", evidenceRefs: [] },
      termination: { kind: "limit_reached", code: "limit.turns", initiatedBy: "harness" },
      cleanup: { status: "complete", remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: "experiment-1", runId: "run-1", firstSequence: 1, lastSequence: 2 },
    artifactRefs: [], warnings: [],
  };
}

export function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId: "attempt-1",
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: { run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" }, models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" }, delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" }, replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" } },
  };
}
