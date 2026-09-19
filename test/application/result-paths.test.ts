import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResultPathLinks } from "../../src/application/result-paths.js";
import { resolveHistoricalFinalPath } from "../../src/application/historical-final-discovery.js";
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

const inspection = (): RunInspection => ({
  runId: "run-1",
  changedPaths: ["slides/final.html"],
  runtimeGeneratedPaths: [],
  commands: [],
  rejectedApprovals: 0,
  turns: 1,
});

test("buildResultPathLinks prioritizes report and final artifact files", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-result-paths-"));
  t.after(async () => rm(experimentRoot, { recursive: true, force: true }));
  const workspaceRoot = join(experimentRoot, "environment", "runs", "run-1");
  const baselineDir = join(experimentRoot, "environment", "baselines");
  await mkdir(baselineDir, { recursive: true });
  await writeFile(join(baselineDir, "deck.html"), "<!doctype html><title>deck</title>", "utf8");
  await mkdir(join(workspaceRoot, "slides"), { recursive: true });
  await writeFile(join(workspaceRoot, "slides", "final.html"), "<!doctype html><title>final</title>", "utf8");
  const links = await buildResultPathLinks({
    experimentRoot,
    runId: "run-1",
    reportPath: join(experimentRoot, "report.html"),
    taskCase: taskCase(),
    inspection: inspection(),
    workspaceRoot,
  });
  assert.equal(links.report, join(experimentRoot, "report.html"));
  assert.equal(links.historyFinal, join(baselineDir, "deck.html"));
  assert.equal(links.candidateFinal, join(workspaceRoot, "slides", "final.html"));
  assert.match(links.trace ?? "", /runs[/\\]run-1$/);
});

test("buildResultPathLinks omits historyFinal when baseline has no deliverable names", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-result-paths-nobase-"));
  t.after(async () => rm(experimentRoot, { recursive: true, force: true }));
  const workspaceRoot = join(experimentRoot, "environment", "runs", "run-1");
  const emptyCase: TaskCase = {
    ...taskCase(),
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    transcript: [{ id: "m1", role: "user", text: "no deliverables mentioned" }],
  };
  const links = await buildResultPathLinks({
    experimentRoot,
    runId: "run-1",
    taskCase: emptyCase,
    inspection: inspection(),
    workspaceRoot,
  });
  assert.equal(links.historyFinal, undefined);
});

test("resolveHistoricalFinalPath prefers sealed attempt finals over environment baselines", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-result-paths-priority-"));
  t.after(async () => rm(experimentRoot, { recursive: true, force: true }));
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const baselineDir = join(experimentRoot, "environment", "baselines");
  await mkdir(join(attemptRoot, "history", "finals"), { recursive: true });
  await mkdir(baselineDir, { recursive: true });
  await writeFile(join(attemptRoot, "history", "finals", "deck.html"), "<!doctype html><title>sealed</title>", "utf8");
  await writeFile(join(baselineDir, "deck.html"), "<!doctype html><title>baseline</title>", "utf8");
  const resolved = await resolveHistoricalFinalPath({
    experimentRoot,
    runId: "run-1",
    taskCase: taskCase(),
    attemptRoot,
  });
  assert.equal(resolved, join(attemptRoot, "history", "finals", "deck.html"));
});

test("resolveHistoricalFinalPath resolves baseline-artifacts under dataDir", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-result-paths-datadir-"));
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-data-"));
  t.after(async () => {
    await rm(experimentRoot, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const artifactDir = join(dataDir, "cases", "case-1", "baseline-artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "deck.html"), "<!doctype html><title>artifact</title>", "utf8");
  const resolved = await resolveHistoricalFinalPath({
    experimentRoot,
    runId: "run-1",
    taskCase: taskCase(),
    dataDir,
  });
  assert.equal(resolved, join(artifactDir, "deck.html"));
});
