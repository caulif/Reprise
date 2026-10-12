import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { recoverExperiment } from '../../src/application/recovery/recover.js';
import { createExperimentWorkflow } from '../../src/application/experiment-workflow.js';
import { sha256 } from '../../src/core/identity.js';
import { LocalWorkspaceProvider } from '../../src/environment/local-workspace-provider.js';
import { evaluateRecoveryPreTaskConditions } from '../../src/environment/recovery-pre-task.js';
import { assertGitStartPaths } from '../../src/environment/recovery-git-start.js';
import { codexProductPack } from '../../src/products/packs/codex/pack.js';
import { persistPreparedScene, loadSealedScene } from '../../src/application/experiment-scene.js';
import { replicaWorkspaceLocation } from '../../src/application/result-paths.js';
import { compactRecoveryProviderRoot } from '../../src/application/recovery-provider-layout.js';
import { now, VerifiedRuntime, input } from '../codex-experiment-support.js';

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, windowsHide: true })).stdout.trim();
}
async function setup(root: string) {
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, 'init');
  await writeFile(join(source, 'README.md'), 'before\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'before');
  const commit = await git(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'README.md'), 'historical answer\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'answer');
  const answer = await git(source, 'rev-parse', 'HEAD');
  await mkdir(join(source, 'input space'));
  await writeFile(join(source, 'input space', '题目.txt'), 'original input');
  await writeFile(join(source, 'answer.html'), 'later artifact');
  return { source, commit, answer, inputs: [{ path: 'input space/题目.txt', sha256: sha256('original input') }] };
}

test('confirmed Git recovery bypasses the model, preserves hashed inputs, and excludes future answer objects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-git-start-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = await setup(root);
  const base = input(root, new VerifiedRuntime());
  const events: string[] = [];
  const attempt = await recoverExperiment({
    dataDir: base.dataDir, caseId: base.caseId, experimentId: 'confirmed-start', runId: 'confirmed-run',
    sourceRoot: fixture.source, taskCase: { ...base.taskCase, historicalEvents: [{ commit: fixture.answer }] },
    gitStart: { commit: fixture.commit, inputs: fixture.inputs }, now,
    recovery: { recover: async () => { throw new Error('Model must not be called.'); } },
    onEvent: (event) => { events.push(event.type); },
  });
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.recovery?.taskOutcome, 'ready_for_task');
  const baseline = attempt.baseline.root!;
  assert.equal(await git(baseline, 'rev-parse', 'HEAD'), fixture.commit);
  assert.equal(await readFile(join(baseline, 'README.md'), 'utf8'), 'before\n');
  assert.equal(await readFile(join(baseline, 'input space', '题目.txt'), 'utf8'), 'original input');
  await assert.rejects(readFile(join(baseline, 'answer.html')));
  await assert.rejects(git(baseline, 'cat-file', '-t', fixture.answer));
  assert.equal(await git(fixture.source, 'rev-parse', 'HEAD'), fixture.answer);
  assert.equal(await readFile(join(fixture.source, 'answer.html'), 'utf8'), 'later artifact');
  assert.ok(events.includes('recovery.git_start_requested'));
  assert.ok(events.includes('recovery.git_start_restored'));
  assert.equal(events.includes('agent.model_request'), false);
  const checked = await evaluateRecoveryPreTaskConditions(baseline, base.taskCase, { commit: fixture.commit, inputs: fixture.inputs });
  assert.equal(checked.readyAllowed, true);
  await writeFile(join(baseline, 'input space', '题目.txt'), 'changed');
  assert.equal((await evaluateRecoveryPreTaskConditions(baseline, base.taskCase, { commit: fixture.commit, inputs: fixture.inputs })).readyAllowed, false);
});

test('confirmed input mismatch never publishes or modifies the original repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-git-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = await setup(root);
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const staging = await provider.beginRecovery({ caseId: 'case', sourceRoot: fixture.source });
  try {
    await assert.rejects(provider.restoreGitStart(staging, {
      commit: fixture.commit, inputs: [{ path: fixture.inputs[0]!.path, sha256: '0'.repeat(64) }],
    }), /hash does not match/);
    assert.equal(await git(staging.root, 'rev-parse', 'HEAD'), fixture.answer);
  } finally {
    await provider.discardRecovery(staging);
  }
  assert.equal(await git(fixture.source, 'rev-parse', 'HEAD'), fixture.answer);
});

test('Git input allowlist rejects aliases, metadata, traversal, and duplicate paths', () => {
  for (const path of ['../secret', '/absolute', '.git/config', 'nested/.GIT/config', '.git /config', '.reprise/state', 'recovery.md', 'C:/x', 'a\\b', 'a//b', 'input.', 'NUL.txt', 'a?b']) {
    assert.throws(() => assertGitStartPaths({ commit: 'a'.repeat(40), inputs: [{ path, sha256: 'b'.repeat(64) }] }));
  }
  assert.throws(() => assertGitStartPaths({ commit: 'a'.repeat(40), inputs: [
    { path: 'Input.txt', sha256: 'b'.repeat(64) }, { path: 'input.txt', sha256: 'b'.repeat(64) },
  ] }), /unique/);
});

test('workflow accepts an explicit Git start without model configuration or agent construction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-git-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = await setup(root);
  const base = input(root, new VerifiedRuntime());
  const workflow = createExperimentWorkflow({
    dataDir: base.dataDir, now: () => now, pack: codexProductPack,
    agents: async () => { throw new Error('Agent configuration must not be loaded.'); },
  });
  const events: unknown[] = [];
  const result = await workflow.recover({ taskCase: base.taskCase, sourceRoot: fixture.source,
    gitStart: { commit: fixture.commit, inputs: [] }, onEvent: event => { events.push(event); } });
  assert.equal(result.acceptedAutomatically, true, JSON.stringify(events));
  assert.equal(await git(result.baseline.root!, 'rev-parse', 'HEAD'), fixture.commit);
  await assert.rejects(readFile(join(result.baseline.root!, fixture.inputs[0]!.path)));
  const descriptor = await persistPreparedScene(result, fixture.source, base.taskCase);
  assert.equal(descriptor.recoveryProviderLayout, 'compact-v1');
  const reopened = await loadSealedScene(base.dataDir, result.experimentId);
  assert.equal(await git(reopened.attempt.baseline.root!, 'rev-parse', 'HEAD'), fixture.commit);
  const providerRoot = compactRecoveryProviderRoot(result.experimentRoot, result.runId!);
  assert.deepEqual(replicaWorkspaceLocation(result.experimentRoot, 'candidate', join(providerRoot, 'runs', 'candidate')),
    { providerRoot, workspaceRoot: join(providerRoot, 'runs', 'candidate') });
  assert.equal(replicaWorkspaceLocation(join(base.dataDir, 'experiments', 'another-experiment'), 'candidate', join(providerRoot, 'runs', 'candidate')), undefined);
  await writeFile(join(result.experimentRoot, 'scene.json'), JSON.stringify({ ...descriptor, recoveryProviderRunId: undefined }));
  await assert.rejects(loadSealedScene(base.dataDir, result.experimentId), /missing its Recovery run identity/);
});

test('missing commit and unsupported submodules fail without replacing staging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-git-unsupported-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = await setup(root);
  await git(fixture.source, 'update-index', '--add', '--cacheinfo', `160000,${fixture.commit},module`);
  await git(fixture.source, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'submodule');
  const moduleCommit = await git(fixture.source, 'rev-parse', 'HEAD');
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const staging = await provider.beginRecovery({ caseId: 'case', sourceRoot: fixture.source });
  try {
    await assert.rejects(provider.restoreGitStart(staging, { commit: '0'.repeat(40), inputs: [] }));
    await assert.rejects(provider.restoreGitStart(staging, { commit: moduleCommit, inputs: [] }), /submodules/);
    assert.equal(await git(staging.root, 'rev-parse', 'HEAD'), moduleCommit);
  } finally {
    await provider.discardRecovery(staging);
  }
});

test('LFS and symbolic-link Git trees are refused rather than claiming their contents were restored', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-git-lfs-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = await setup(root);
  await writeFile(join(fixture.source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  await git(fixture.source, 'add', '.gitattributes');
  await git(fixture.source, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'lfs');
  const lfsCommit = await git(fixture.source, 'rev-parse', 'HEAD');
  const blob = await git(fixture.source, 'rev-parse', 'HEAD:README.md');
  await git(fixture.source, 'update-index', '--add', '--cacheinfo', `120000,${blob},link`);
  await git(fixture.source, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'link');
  const linkCommit = await git(fixture.source, 'rev-parse', 'HEAD');
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const staging = await provider.beginRecovery({ caseId: 'case', sourceRoot: fixture.source });
  try {
    await assert.rejects(provider.restoreGitStart(staging, { commit: lfsCommit, inputs: [] }), /LFS/);
    await assert.rejects(provider.restoreGitStart(staging, { commit: linkCommit, inputs: [] }), /symlinks/);
    assert.equal(await git(staging.root, 'rev-parse', 'HEAD'), linkCommit);
  } finally {
    await provider.discardRecovery(staging);
  }
});
