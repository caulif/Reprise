import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentWorkflow } from "../../src/application/experiment-workflow.js";
import type { HarnessAgents } from "../../src/application/harness-agents.js";
import { createProductLookup } from "../../src/products/index.js";
import { codexProductPack } from "../../src/products/packs/codex/pack.js";
import { claudeCodeProductPack } from "../../src/products/packs/claude-code/pack.js";
import { input, VerifiedRuntime } from "../codex-experiment-support.js";
import { captureHistoricalDelivery } from '../../src/application/historical-delivery.js';
import { sha256 } from '../../src/core/identity.js';
import { readLocalHistory } from '../../src/application/experiment-history-list.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';

function historicalPatchEvents() {
  const patch = "*** Begin Patch\n*** Add File: pelican_bike.html\n+<!doctype html>\n+<html>bike</html>\n*** End Patch";
  return [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call", call_id: "write", name: "exec",
        input: `const patch = ${JSON.stringify(patch)}; const r = await tools.apply_patch(patch); text(r);`,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output", call_id: "write",
        output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: "{}" }],
      },
    },
  ];
}

test("live and persisted comparison extract Codex history when the candidate is Claude Code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-workflow-history-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtime = new VerifiedRuntime();
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "fixture\n");
  const compare = base.comparison.compare.bind(base.comparison);
  t.mock.method(base.comparison, 'compare', async (...args: Parameters<typeof base.comparison.compare>) => {
    assert.deepEqual(args[0].reportFacts.sessionAgents, { baseline: 'Historical Agent', candidate: 'Current Agent' });
    return compare(...args);
  });
  const workflow = createExperimentWorkflow({
    dataDir: base.dataDir,
    runtime,
    lookup: createProductLookup([
      { ...codexProductPack, manifest: { ...codexProductPack.manifest, displayName: 'Historical Agent' } },
      { ...claudeCodeProductPack, manifest: { ...claudeCodeProductPack.manifest, displayName: 'Current Agent' } },
    ]),
    agents: async () => ({
      controller: base.controller, comparison: base.comparison, recovery: {},
      config: { ...base.agentConfig, recoveryBudget: base.agentConfig.budget },
    }) as unknown as HarnessAgents,
    now: () => base.now,
    defaults: { policy: base.policy },
  });
  const taskCase = { ...base.taskCase, historicalEvents: historicalPatchEvents() };
  const candidate = { ...base.candidate, productId: "claude-code" };
  const handle = await workflow.start({
    taskCase, candidate, sourceRoot: base.sourceRoot, compare: true,
    experimentId: "cross-product-history", runId: "run-cross", onEvent: () => {},
  });
  const result = await handle.result;
  assert.equal(runtime.created, 1);
  const attemptsRoot = join(result.experimentRoot, "comparison-attempts");
  const firstAttempt = (await readdir(attemptsRoot))[0];
  assert.ok(firstAttempt);
  const first = JSON.parse(await readFile(join(attemptsRoot, firstAttempt, "derived-history", "manifest.json"), "utf8")) as {
    extractorVersion: string; artifacts: Array<{ logicalPath: string }>;
  };
  assert.equal(first.extractorVersion, "codex-historical-artifacts/v2");
  assert.equal(first.artifacts[0]?.logicalPath, "pelican_bike.html");

  await workflow.comparePersisted("cross-product-history", undefined, undefined, "run-cross");
  const attempts = await readdir(attemptsRoot);
  assert.equal(attempts.length, 2);
  const secondAttempt = attempts.find((name) => name !== firstAttempt);
  assert.ok(secondAttempt);
  const second = JSON.parse(await readFile(join(attemptsRoot, secondAttempt, "derived-history", "manifest.json"), "utf8")) as typeof first;
  assert.equal(second.extractorVersion, first.extractorVersion);
  assert.deepEqual(second.artifacts, first.artifacts);
});

test('comparePersisted freezes the explicitly selected delivery and its provenance event without rerunning the candidate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-selected-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtime = new VerifiedRuntime();
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), 'task input');
  const workflow = createExperimentWorkflow({ dataDir: base.dataDir, runtime,
    lookup: createProductLookup([codexProductPack]), now: () => base.now, defaults: { policy: base.policy },
    agents: async () => ({ controller: base.controller, comparison: base.comparison, recovery: {},
      config: { ...base.agentConfig, recoveryBudget: base.agentConfig.budget } }) as unknown as HarnessAgents });
  const handle = await workflow.start({ taskCase: base.taskCase, candidate: base.candidate, sourceRoot: base.sourceRoot,
    compare: false, experimentId: 'selected-history', runId: 'selected-run', onEvent: () => {} });
  const result = await handle.result;
  const originalCase = await readFile(join(base.dataDir, 'cases', base.taskCase.caseId, 'case.json'));
  const selectedFile = join(root, 'delivered.txt');
  await writeFile(selectedFile, 'chosen delivery');
  const selection = await captureHistoricalDelivery({ dataDir: base.dataDir, taskCase: base.taskCase, now: base.now, selectionBasis: 'Explicit selection',
    source: { kind: 'captured_file', sourcePath: selectedFile, logicalPath: 'delivered.txt', expectedHash: sha256('chosen delivery') } });
  await rm(selectedFile);
  await workflow.comparePersisted('selected-history', undefined, undefined, 'selected-run');
  assert.equal(runtime.created, 1);
  const attemptsRoot = join(result.experimentRoot, 'comparison-attempts');
  const attemptId = (await readdir(attemptsRoot))[0]!;
  const manifest = JSON.parse(await readFile(join(attemptsRoot, attemptId, 'finals', 'manifest.json'), 'utf8')) as { selectionId: string; capture: { kind: string } };
  assert.equal(manifest.selectionId, selection.selectionId);
  assert.equal(manifest.capture.kind, 'captured_file');
  assert.equal(await readFile(join(attemptsRoot, attemptId, 'finals', 'delivered.txt'), 'utf8'), 'chosen delivery');
  assert.deepEqual(await readFile(join(base.dataDir, 'cases', base.taskCase.caseId, 'case.json')), originalCase);
  assert.equal(await readFile(join(base.sourceRoot, 'README.md'), 'utf8'), 'task input');
  const history = await readLocalHistory(base.dataDir);
  assert.ok(history.experiments.some(experiment => experiment.experimentId === 'selected-history'));
  const store = await ExperimentStore.open(result.experimentRoot, 'selected-history');
  const prepared = store.events('selected-run').find(event => event.type === 'comparison.historical_delivery_prepared');
  assert.ok(prepared);
  const payload = prepared.payload as { selectionId: string; artifactId: string };
  assert.equal(payload.selectionId, selection.selectionId);
  const artifact = await store.readArtifact({ artifactId: payload.artifactId, experimentId: 'selected-history', runId: 'selected-run' });
  assert.equal((JSON.parse(Buffer.from(artifact).toString()) as { capture: { kind: string } }).capture.kind, 'captured_file');
  await store.close();
  const selectedRoot = join(base.dataDir, 'historical-deliveries', base.taskCase.caseId, selection.selectionId);
  await writeFile(join(selectedRoot, 'files', selection.selectionId, 'delivered.txt'), 'tampered');
  const originalReport = await readFile(join(result.experimentRoot, 'report.html'));
  const failed = await workflow.comparePersisted('selected-history', undefined, undefined, 'selected-run');
  assert.equal(failed.comparison.result.status, 'failed');
  assert.equal(runtime.created, 1);
  assert.deepEqual(await readFile(join(result.experimentRoot, 'report.html')), originalReport);
  assert.match(await readFile(failed.reportPath, 'utf8'), /Comparison unavailable/);
});
