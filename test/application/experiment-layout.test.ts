import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistExperimentSpec, persistRunPreflight, listPersistedRunIds, resolvedExperimentRoot } from "../../src/application/experiment-layout.js";
import { CliError } from "../../src/application/cli-error.js";
import type { ExperimentSpec } from "../../src/core/schema.js";

function spec(experimentId: string, requestedModel: string): ExperimentSpec {
  return {
    experimentId,
    taskCaseId: "case-layout",
    candidates: [{ candidateId: "candidate", productId: "codex", requestedModel }],
    controller: { providerId: "provider", requestedModel: "model", budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    comparison: { providerId: "provider", requestedModel: "model", budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 },
    outputRoot: "unused",
  };
}

test("second persist keeps the first experiment spec and stores per-run preflight", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-layout-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = resolvedExperimentRoot(dataDir, "exp-layout");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'experiment.json'), JSON.stringify({ spec: spec('exp-layout', 'gpt-first') }));
  await persistExperimentSpec(root, { schemaVersion: 2, experimentId: 'exp-layout', taskCaseId: 'case-layout',
    taskCaseIdentity: { kind: 'legacy-v1', legacyContentHash: 'a'.repeat(64), observedCanonicalHash: 'b'.repeat(64) } });
  const stored = JSON.parse(await readFile(join(root, "experiment.json"), "utf8")) as { spec: ExperimentSpec; runIds?: string[] };
  assert.notEqual(stored.spec.schemaVersion, 2);
  if (stored.spec.schemaVersion === 2) throw new Error('Expected legacy fixture.');
  assert.equal(stored.spec.candidates[0]?.requestedModel, "gpt-first");
  assert.equal(stored.runIds, undefined);
  const preflight = { sourceBaseline: 'available' as const, resolved: { productId: 'codex', executable: 'codex', requestedModel: 'model', resolvedModel: 'model' }, limitations: [], comparisonClass: 'observational' as const };
  await persistRunPreflight(root, "run-a", preflight);
  await persistRunPreflight(root, "run-b", preflight);
  assert.deepEqual(await listPersistedRunIds(root), ["run-a", "run-b"]);
});

test("resolvedExperimentRoot rejects path escape", () => {
  assert.throws(() => resolvedExperimentRoot("C:/data", "../outside"), CliError);
});
