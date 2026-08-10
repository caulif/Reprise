import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspaceProvider } from '../src/environment/local-workspace-provider.js';

async function directories(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-env-'));
  const source = await mkdtemp(join(tmpdir(), 'reprise-source-'));
  await writeFile(join(source, 'input.txt'), 'original');
  return { root, source };
}

test('LocalWorkspaceProvider isolates a run and fingerprints before/after changes', async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline({ caseId: 'case-1', sourceRoot: source }, [], {});
    assert.equal(baseline.readiness.runnable, 'isolated');
    const environment = await provider.prepareRun(baseline, 'run-1');
    assert.equal(environment.mode, 'isolated');
    assert.equal(await readFile(join(environment.root, 'input.txt'), 'utf8'), 'original');

    const before = await provider.fingerprint(environment);
    await writeFile(join(environment.root, 'input.txt'), 'changed');
    const after = await provider.fingerprint(environment);
    assert.notEqual(before.digest, after.digest);
    assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('LocalWorkspaceProvider owns run paths and release is idempotent', async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline({ caseId: 'case-2', sourceRoot: source }, [], {});
    const environment = await provider.prepareRun(baseline, 'run-2');
    await assert.rejects(provider.prepareRun(baseline, 'run-2'), /already exists/);
    await provider.release(environment);
    await provider.release(environment);
    await assert.rejects(stat(environment.root), { code: 'ENOENT' });

    const forged = { ...environment, root: source };
    await assert.rejects(provider.fingerprint(forged), /owned|workspace/);
    await assert.rejects(provider.release({ ...environment, root: join(root, 'runs', 'unowned') }), /owned|workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('LocalWorkspaceProvider reports an unavailable source as unsupported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-env-'));
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline({ caseId: 'case-3', sourceRoot: join(root, 'missing') }, [], {});
    assert.equal(baseline.mode, 'unsupported');
    assert.equal(baseline.readiness.runnable, 'unsupported');
    await assert.rejects(provider.prepareRun(baseline, 'run-3'), /unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
