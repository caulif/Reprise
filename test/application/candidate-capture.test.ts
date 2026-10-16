import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalWorkspaceProvider } from '../../src/environment/local-workspace-provider.js';
import { copyTree, fingerprintTree, publishDirectory } from '../../src/environment/local-workspace-fs.js';
import { cleanupCandidateRun } from '../../src/application/candidate-run-cleanup.js';
import { ScriptedRunner } from '../support/scripted-runtime.js';
import { captureWorkspaceScope } from '../../src/application/controller-queries.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { copySnapshotFile } from '../../src/environment/snapshot-file.js';
import { truncate, stat } from 'node:fs/promises';

async function fixture(t: { after(fn: () => Promise<unknown>): void }, copy = copyTree) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'answer.txt'), 'before');
  const provider = new LocalWorkspaceProvider(join(root, 'environment'), copy);
  const baseline = await provider.resolveBaseline({ caseId: 'case', sourceRoot: source }, [], {});
  return { root, provider, environment: await provider.prepareRun(baseline, 'run') };
}

async function installedWorkspace(root: string) {
  for (const dir of ['node_modules', 'packages/app/node_modules', 'packages/delivery/node_modules']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'node_modules/.modules.yaml', 'packages/app/package.json', 'packages/delivery/package.json']) await writeFile(join(root, file), '{}');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nimporters:\n  .:\n    dependencies: {}\n  packages/app:\n    dependencies: {}\npackages:\n  other: {}\n');
  await writeFile(join(root, 'packages/app/node_modules/cache.txt'), 'rebuildable');
  await writeFile(join(root, 'packages/delivery/node_modules/answer.txt'), 'non-workspace delivery');
}

test('production capture fingerprints sealed files, prunes installed workspace importers, preserves other deliveries', async t => {
  const { provider, environment } = await fixture(t);
  await installedWorkspace(environment.root);
  await writeFile(join(environment.root, 'answer.txt'), 'after');
  // The live progress scan is deliberately unusable: capture must use its sealed copy.
  provider.fingerprint = async () => { throw new Error('live fingerprint must not run'); };
  const artifacts: Buffer[] = [];
  await captureWorkspaceScope({ environment, workspaceProvider: provider, experimentId: 'experiment', runId: 'run',
    store: { commitArtifact: async (input: { bytes: Uint8Array }) => { artifacts.push(Buffer.from(input.bytes)); } } as unknown as ExperimentStore });
  const scope = JSON.parse(artifacts[0]!.toString()) as { candidateFingerprint: string; textSnapshots: { path: string; content: string }[]; omittedRebuildableDirectories: { path: string }[] };
  const snapshot = await provider.candidateSnapshot('run');
  assert.equal(snapshot.status, 'complete');
  assert.equal(scope.candidateFingerprint, (await fingerprintTree(snapshot.root)).fingerprint.digest);
  assert.ok(scope.omittedRebuildableDirectories.some(entry => entry.path === 'packages/app/node_modules'));
  assert.equal(await readFile(join(snapshot.root, 'packages/delivery/node_modules/answer.txt'), 'utf8'), 'non-workspace delivery');
  assert.ok(scope.textSnapshots.some(entry => entry.path === 'answer.txt' && entry.content === 'after'));
  await writeFile(join(environment.root, 'answer.txt'), 'later');
  assert.equal(await readFile(join(snapshot.root, 'answer.txt'), 'utf8'), 'after');
  await assert.rejects(provider.sealCandidateSnapshot(environment), /refusing to replace/);
  assert.equal((await provider.candidateSnapshot('run')).status, 'complete');
});

test('streaming copy and hashing stop on cancellation before returning', async t => {
  const { root } = await fixture(t);
  const from = join(root, 'large.bin');
  const to = join(root, 'partial.bin');
  await writeFile(from, '');
  await truncate(from, 128 * 1024 * 1024);
  const abort = new AbortController();
  const copying = copySnapshotFile(from, to, abort.signal);
  abort.abort(new Error('stop IO'));
  await assert.rejects(copying, /abort/i);
  const size = (await stat(to)).size;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await stat(to)).size, size);
  assert.ok(size < 128 * 1024 * 1024);
  await assert.rejects(fingerprintTree(root, undefined, abort.signal), /stop IO/);
});

test('capture has its own bounded deadline while runtime close keeps the shorter deadline', async () => {
  const events: { type: string; payload: unknown }[] = [];
  let release = false;
  const result = await cleanupCandidateRun('completed', {
    runner: new ScriptedRunner([], []), timeoutMs: 10, captureTimeoutMs: 500,
    appendCleanup: async (type, payload) => { events.push({ type, payload }); return type; },
    captureArtifacts: async () => { await new Promise(resolve => setTimeout(resolve, 30)); },
    release: async () => { release = true; return { status: 'released' }; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(release, true);
  assert.deepEqual(events.find(event => event.type === 'cleanup.capture_started')?.payload, { reason: 'completed', timeoutMs: 500 });
  assert.deepEqual(events.find(event => event.type === 'cleanup.close_started')?.payload, { reason: 'completed', timeoutMs: 10 });
});

test('atomic snapshot publication cancels a busy rename without a partial copy fallback', async t => {
  const { root } = await fixture(t);
  const staging = join(root, 'staging');
  const destination = join(root, 'destination');
  await mkdir(staging);
  await writeFile(join(staging, 'answer.txt'), 'retained');
  const abort = new AbortController();
  const busy = Object.assign(new Error('busy'), { code: 'EPERM' });
  await assert.rejects(publishDirectory(staging, destination, async () => { abort.abort(); throw busy; }, { atomicOnly: true, signal: abort.signal }), /abort/i);
  await assert.rejects(stat(destination));
  assert.equal(await readFile(join(staging, 'answer.txt'), 'utf8'), 'retained');
  await assert.rejects(publishDirectory(staging, destination, async () => { throw busy; }, { atomicOnly: true }), /busy/);
  await assert.rejects(stat(destination));
  assert.equal(await readFile(join(staging, 'answer.txt'), 'utf8'), 'retained');
});

test('failed snapshot preserves diagnosis and live files, retries without replacing earlier staging', async t => {
  let fail = true;
  const { root, provider, environment } = await fixture(t, async (from, to, signal, policy) => {
    if (policy && fail) { await writeFile(join(to, 'partial.txt'), 'partial'); throw new Error('disk copy failed'); }
    await copyTree(from, to, signal, policy);
  });
  await assert.rejects(provider.sealCandidateSnapshot(environment), /disk copy failed/);
  assert.equal((await provider.candidateSnapshot('run')).status, 'incomplete');
  const snapshots = join(root, 'environment/snapshots');
  const staging = (await readdir(snapshots)).find(name => name.startsWith('.run.staging-'))!;
  assert.equal(await readFile(join(snapshots, staging, 'partial.txt'), 'utf8'), 'partial');
  assert.equal(await readFile(join(environment.root, 'answer.txt'), 'utf8'), 'before');
  fail = false;
  const sealed = await provider.sealCandidateSnapshot(environment);
  assert.equal(sealed.status, 'complete');
  assert.equal(await readFile(join(snapshots, staging, 'partial.txt'), 'utf8'), 'partial');
  await assert.rejects(readFile(join(sealed.root, 'partial.txt')));
});

test('explicit retention overrides nested dependency omission and cancellation never publishes success', async t => {
  const { provider, environment } = await fixture(t);
  await installedWorkspace(environment.root);
  const abort = new AbortController();
  abort.abort(new Error('capture cancelled'));
  await assert.rejects(provider.sealCandidateSnapshot(environment, abort.signal), /capture cancelled/);
  assert.equal((await provider.candidateSnapshot('run')).status, 'incomplete');
  const sealed = await provider.sealCandidateSnapshot(environment, undefined, ['packages/app/node_modules/cache.txt']);
  assert.equal(await readFile(join(sealed.root, 'packages/app/node_modules/cache.txt'), 'utf8'), 'rebuildable');
});

test('missing install proof preserves dependency-named deliveries', async t => {
  const { provider, environment } = await fixture(t);
  await installedWorkspace(environment.root);
  await rm(join(environment.root, 'node_modules/.modules.yaml'));
  const sealed = await provider.sealCandidateSnapshot(environment);
  assert.deepEqual(sealed.omitted, []);
  assert.equal(await readFile(join(sealed.root, 'packages/app/node_modules/cache.txt'), 'utf8'), 'rebuildable');
});

test('replaced root lock uses and retains the installed dependency lock without changing the delivery', async t => {
  const { provider, environment } = await fixture(t);
  await installedWorkspace(environment.root);
  const installed = await readFile(join(environment.root, 'pnpm-lock.yaml'), 'utf8');
  await mkdir(join(environment.root, 'node_modules/.pnpm'));
  await writeFile(join(environment.root, 'node_modules/.pnpm/lock.yaml'), installed);
  const delivered = 'importers:\n  .:\n    dependencies: {}\n';
  await writeFile(join(environment.root, 'pnpm-lock.yaml'), delivered);
  const sealed = await provider.sealCandidateSnapshot(environment);
  const dependency = sealed.omitted.find(entry => entry.path === 'packages/app/node_modules')!;
  assert.equal(dependency.lockfile, 'node_modules/.pnpm/lock.yaml');
  assert.match(dependency.restoreCommand, /isolated copy/);
  assert.equal(await readFile(join(sealed.root, dependency.lockfile), 'utf8'), installed);
  assert.equal(await readFile(join(sealed.root, 'pnpm-lock.yaml'), 'utf8'), delivered);
  assert.equal(await readFile(join(environment.root, 'pnpm-lock.yaml'), 'utf8'), delivered);
  await assert.rejects(readFile(join(sealed.root, 'packages/app/node_modules/cache.txt')));
});

test('copy limits fail before large I/O and conflicting completion markers fail closed', async t => {
  const { root, provider, environment } = await fixture(t);
  const large = join(environment.root, 'large.bin');
  await writeFile(large, '');
  await truncate(large, 512 * 1024 * 1024 + 1);
  await assert.rejects(provider.sealCandidateSnapshot(environment), /copy exceeds limits/);
  const marker = join(root, 'environment/snapshots/run.incomplete');
  assert.match(await readFile(marker, 'utf8'), /stage=copy/);
  await writeFile(join(root, 'environment/snapshots/run.complete'), '');
  assert.equal((await provider.candidateSnapshot('run')).status, 'incomplete');
  assert.equal((await stat(large)).size, 512 * 1024 * 1024 + 1);
});
