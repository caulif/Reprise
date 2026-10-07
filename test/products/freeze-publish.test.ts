import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskCase } from '../../src/core/schema.js';
import { listPublishedFrozenCases, publishFrozenCase } from '../../src/products/shared/freeze.js';
import { publishFrozenDirectory } from '../../src/products/shared/freeze-publish.js';

const RETRY_DELAYS = [30, 80, 160, 320, 640];

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Injected ${code}`), { code });
}

async function directories(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-publish-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const staging = join(root, '.staging');
  const target = join(root, 'case');
  await mkdir(staging);
  await writeFile(join(staging, 'case.complete'), 'complete');
  return { root, staging, target };
}

function taskCase(): TaskCase {
  return {
    schemaVersion: 1, caseId: 'case-test',
    source: { productId: 'codex', sessionId: 'session' }, evidenceLevel: 'transcript',
    initialInput: { id: 'u', role: 'user', text: 'Task' },
    transcript: [{ id: 'u', role: 'user', text: 'Task' }], historicalEvents: [],
    baseline: { status: 'available', finalMessage: 'Done', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    provenance: { packVersion: 'test', importedAt: '2026-10-05T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'a'.repeat(64),
  };
}

test('frozen directory publishes directly through native rename', async (t) => {
  const { root, staging, target } = await directories(t);
  await publishFrozenDirectory(staging, target);
  assert.equal(await readFile(join(target, 'case.complete'), 'utf8'), 'complete');
  assert.deepEqual(await readdir(root), ['case']);
});

for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EAGAIN']) {
  test(`frozen directory retries transient ${code} with bounded backoff before atomic publication`, async (t) => {
    const { root, staging, target } = await directories(t);
    const waits: number[] = [];
    let attempts = 0;
    await publishFrozenDirectory(staging, target, {
      rename: async (from, to) => {
        attempts++;
        if (attempts <= RETRY_DELAYS.length) throw ioError(code);
        await rename(from, to);
      },
      delay: async (ms) => {
        waits.push(ms);
        assert.deepEqual(await readdir(root), ['.staging']);
      },
    });
    assert.equal(attempts, 6);
    assert.deepEqual(waits, RETRY_DELAYS);
    assert.deepEqual(await readdir(root), ['case']);
    assert.equal(await readFile(join(target, 'case.complete'), 'utf8'), 'complete');
  });
}

test('permanent busy freeze preserves cause and removes private staging without publishing partial case', async (t) => {
  const { root, staging } = await directories(t);
  await rm(staging, { recursive: true });
  const busy = ioError('EPERM');
  const waits: number[] = [];
  let attempts = 0;
  await assert.rejects(publishFrozenCase({
    taskCase: taskCase(), casesRoot: root, files: [{ relativePath: 'raw/source.txt', content: 'input' }],
    publishDependencies: {
      rename: async (from) => {
        attempts++;
        assert.equal(await readFile(join(String(from), 'case.complete'), 'utf8'), '');
        throw busy;
      },
      delay: async (ms) => { waits.push(ms); },
    },
  }), (error: unknown) => error instanceof Error && error.cause === busy);
  assert.equal(attempts, 6);
  assert.deepEqual(waits, RETRY_DELAYS);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await listPublishedFrozenCases(root), []);
});

for (const [index, failure] of [ioError('EIO'), ioError('EXDEV'), new Error('untyped'), { code: 'EBUSY' }, 42].entries()) {
  test(`frozen directory propagates non-retryable failure variant ${index} immediately`, async (t) => {
    const { root, staging, target } = await directories(t);
    let attempts = 0;
    let waits = 0;
    await assert.rejects(publishFrozenDirectory(staging, target, {
      rename: async () => {
        attempts++;
        // Inject non-Error rejection values to prove they cannot trigger busy retries.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw failure;
      },
      delay: async () => { waits++; },
    }), (error: unknown) => error === failure);
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
    assert.deepEqual(await readdir(root), ['.staging']);
  });
}

for (const kind of ['directory', 'file', 'dangling-junction'] as const) {
  test(`frozen directory detects ${kind} destination created during retry wait`, async (t) => {
    const { staging, target, root } = await directories(t);
    let attempts = 0;
    const intruder = async () => {
      if (kind === 'directory') await mkdir(target);
      else if (kind === 'file') await writeFile(target, 'existing');
      else await symlink(join(root, 'missing'), target, 'junction');
    };
    await assert.rejects(publishFrozenDirectory(staging, target, {
      rename: async () => { attempts++; throw ioError('EBUSY'); },
      delay: async (ms) => { assert.equal(ms, 30); await intruder(); },
    }), /Case already exists/);
    assert.equal(attempts, 1);
    assert.equal(await readFile(join(staging, 'case.complete'), 'utf8'), 'complete');
    if (kind === 'file') assert.equal(await readFile(target, 'utf8'), 'existing');
    else if (kind === 'directory') assert.deepEqual(await readdir(target), []);
    assert.deepEqual((await readdir(root)).sort(), ['.staging', 'case']);
  });
}

test('destination existence check propagates IO failure before invoking rename', async (t) => {
  const { staging, target } = await directories(t);
  let attempts = 0;
  await assert.rejects(publishFrozenDirectory(staging, `${target}\0`, {
    rename: async () => { attempts++; },
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ERR_INVALID_ARG_VALUE');
  assert.equal(attempts, 0);
});
