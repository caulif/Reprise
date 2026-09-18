import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildResultPathLinks } from "../../src/application/result-paths.js";
import type { RunInspection } from "../../src/application/comparison.js";
import type { TaskCase } from "../../src/core/schema.js";

const taskCase = (): TaskCase => ({
  schemaVersion: 1,
  caseId: "case-1",
  source: { productId: "codex", sessionId: "session-1" },
  initialInput: { id: "m1", role: "user", text: "做 deck.html" },
  transcript: [{ id: "m1", role: "user", text: "做 deck.html" }],
  historicalEvents: [],
  baseline: { status: "available", artifactRefs: [{ artifactId: "deck.html", caseId: "case-1" }], evidenceRefs: [] },
  sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
  provenance: { packVersion: "test", importedAt: "2026-09-18T00:00:00.000Z", sourceHash: "a".repeat(64) },
  privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  contentHash: "b".repeat(64),
});

test("buildResultPathLinks prioritizes report and final artifact files", () => {
  const experimentRoot = "C:\\exp\\run-1";
  const inspection: RunInspection = {
    runId: "run-1",
    changedPaths: ["slides/final.html"],
    runtimeGeneratedPaths: [],
    commands: [],
    rejectedApprovals: 0,
    turns: 1,
  };
  const links = buildResultPathLinks({
    experimentRoot,
    runId: "run-1",
    reportPath: join(experimentRoot, "report.html"),
    taskCase: taskCase(),
    inspection,
    workspaceRoot: join(experimentRoot, "environment", "runs", "run-1"),
  });
  assert.equal(links.report, join(experimentRoot, "report.html"));
  assert.match(links.historyFinal ?? "", /deck\.html$/);
  assert.match(links.candidateFinal ?? "", /final\.html$/);
  assert.match(links.trace ?? "", /runs[/\\]run-1$/);
});
