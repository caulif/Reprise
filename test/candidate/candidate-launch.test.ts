import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { CandidateLaunchContextSchema } from "../../src/core/schema.js";
import { commitCandidateLaunchContext } from "../../src/application/recovery/launch-context.js";
import { compactRecoveryProviderRoot } from '../../src/application/recovery-provider-layout.js';

test('compact Candidate launch accepts only an experiment-owned candidate path and still requires observations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r-launch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const experimentRoot = join(root, 'experiments', 'exp-1');
  const providerRoot = compactRecoveryProviderRoot(experimentRoot, 'recovery-run');
  const workspaceRoot = join(providerRoot, 'runs', 'candidate-run');
  await mkdir(workspaceRoot, { recursive: true });
  const request = { experimentRoot, experimentId: 'exp-1', runId: 'candidate-run', workspaceRoot,
    productId: 'fake', requestedModel: 'fake-model', resolvedModel: 'fake-model', requireObservations: true };
  await assert.rejects(commitCandidateLaunchContext(request), /observations are missing/);
  const observations = join(experimentRoot, 'runs', 'recovery-run', 'observations');
  await mkdir(observations, { recursive: true });
  await writeFile(join(observations, 'INDEX.md'), '# Frozen observations\n');
  const context = await commitCandidateLaunchContext(request);
  assert.equal(context.workspaceRoot, workspaceRoot);
  for (const rejected of [
    join(providerRoot, 'runs', 'another-run'),
    join(compactRecoveryProviderRoot(join(root, 'experiments', 'exp-2'), 'recovery-run'), 'runs', 'candidate-run'),
    providerRoot,
    join(providerRoot, 'rs', 'candidate-run'),
    join(workspaceRoot, 'nested'),
    join(root, 'r', 'arbitrary', 'runs', 'candidate-run'),
  ]) {
    await assert.rejects(commitCandidateLaunchContext({ ...request, workspaceRoot: rejected }), /isolation root/);
  }
});

test("CandidateLaunchContext is schema-checked and refuses a workspace outside the experiment", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-launch-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = join(experimentRoot, "runs", "run-1", "workspace");
  await mkdir(workspace, { recursive: true });
  const context = await commitCandidateLaunchContext({
    experimentRoot,
    experimentId: "exp-1",
    runId: "run-1",
    workspaceRoot: workspace,
    productId: "fake",
    requestedModel: "fake-model",
    resolvedModel: "fake-model",
  });
  assert.equal(Value.Check(CandidateLaunchContextSchema, context), true);
  const persisted = JSON.parse(await readFile(join(experimentRoot, "runs", "run-1", "candidate-launch.json"), "utf8")) as { runId: string };
  assert.equal(persisted.runId, "run-1");
  await assert.rejects(
    () => commitCandidateLaunchContext({
      experimentRoot,
      experimentId: "exp-1",
      runId: "run-1",
      workspaceRoot: join(tmpdir(), "outside-workspace"),
      productId: "fake",
      requestedModel: "fake-model",
      resolvedModel: "fake-model",
    }),
    /isolation root/,
  );
});

test("recovery handover does not launch when observations are missing", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-launch-obs-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = join(experimentRoot, "runs", "run-1", "workspace");
  await mkdir(workspace, { recursive: true });
  await assert.rejects(
    () => commitCandidateLaunchContext({
      experimentRoot,
      experimentId: "exp-1",
      runId: "run-1",
      workspaceRoot: workspace,
      productId: "fake",
      requestedModel: "fake-model",
      resolvedModel: "fake-model",
      requireObservations: true,
    }),
    /observations are missing/,
  );
  const observations = join(experimentRoot, "runs", "recovery-run", "observations");
  await mkdir(observations, { recursive: true });
  await writeFile(join(observations, "INDEX.md"), "# Frozen observations\n");
  const context = await commitCandidateLaunchContext({
    experimentRoot,
    experimentId: "exp-1",
    runId: "run-1",
    workspaceRoot: workspace,
    productId: "fake",
    requestedModel: "fake-model",
    resolvedModel: "fake-model",
    requireObservations: true,
  });
  assert.equal(context.workspaceRoot.includes("run-1"), true);
});
