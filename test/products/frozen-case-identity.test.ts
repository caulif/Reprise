import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema, type TaskCase } from '../../src/core/schema.js';
import { sealTaskCase, validateTaskCase, assertFrozenFilePath } from '../../src/core/task-case-identity.js';
import { sha256, writeImmutable } from '../../src/core/identity.js';
import { freezeCase, publishFrozenCase, listPublishedFrozenCases, type FrozenFile } from '../../src/products/shared/freeze.js';
import { withFrozenCaseLease } from '../../src/products/shared/frozen-case-lease.js';
import { sealFrozenCase } from '../../src/products/shared/frozen-case-files.js';
import { readTaskCase } from '../../src/products/shared/task-case-reader.js';
import { persistTaskCase } from '../../src/application/experiment-helpers.js';
import { readLocalHistory } from '../../src/application/experiment-history-list.js';
import type { ImportedSession } from '../../src/products/contract.js';

const NOW = '2026-10-14T00:00:00.000Z';
const PRIVACY = { allowModelText: true, allowBinary: false, redactions: [] };
const FILES: FrozenFile[] = [{ relativePath: 'raw/session.txt', content: 'source' }, { relativePath: 'baseline-artifacts/artifact-1', content: 'artifact' }];

function legacy(): TaskCase {
  return { schemaVersion: 1, caseId: 'case-legacy', source: { productId: 'codex', sessionId: 'session', sourcePath: 'C:/sessions/old.jsonl' },
    initialInput: { id: 'u1', role: 'user', text: 'First task' },
    transcript: [{ id: 'u1', role: 'user', text: 'First task' }, { id: 'u2', role: 'user', text: 'Second task' }], historicalEvents: [{ a: 1, b: 2 }],
    baseline: { status: 'available', artifactRefs: [{ artifactId: 'artifact-1', caseId: 'case-legacy' }], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, taskContext: { nested: { a: 1, b: 2 } },
    provenance: { importedAt: NOW, packVersion: 'fixture-v1', sourceHash: sha256('source') }, privacy: PRIVACY, contentHash: sha256('source') };
}

async function root(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'reprise-case-identity-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}

function imported(): ImportedSession {
  const task = legacy();
  return { source: task.source, initialInput: task.initialInput, transcript: task.transcript, historicalEvents: task.historicalEvents,
    baseline: task.baseline, sourceRuntimeEvidence: task.sourceRuntimeEvidence, taskContext: task.taskContext,
    provenance: { packVersion: task.provenance.packVersion }, raw: { relativePath: 'raw/session.txt', text: 'source' }, extraFiles: [{ relativePath: 'baseline-artifacts/artifact-1', bytes: Buffer.from('artifact') }],
    diagnostics: [], signals: { userMessages: 2, assistantMessages: 0, toolCalls: 0, completedTurns: 1 } };
}

test('v2 canonical identity excludes import time and storage path but binds task semantics and file bytes', async () => {
  const original = legacy();
  const sealed = await sealFrozenCase(original, FILES);
  assert.equal(Value.Check(TaskCaseSchema, sealed), true);
  assert.equal(sealed.schemaVersion, 2);
  assert.notEqual(sealed.contentHash, sealed.provenance.sourceHash);
  const relocated = { ...original, source: { ...original.source, sourcePath: 'D:/moved/source.jsonl' }, provenance: { ...original.provenance, importedAt: '2026-10-15T00:00:00.000Z' },
    taskContext: { nested: { b: 2, a: 1 } }, historicalEvents: [{ b: 2, a: 1 }] };
  assert.equal((await sealFrozenCase(relocated, FILES)).contentHash, sealed.contentHash);
  const variants: TaskCase[] = [
    { ...original, initialInput: original.transcript[1]! },
    { ...original, execution: { mode: 'task_completion', goal: 'Goal', deliverables: ['file'], authorization: 'write' } },
    { ...original, privacy: { ...PRIVACY, allowBinary: true } },
    { ...original, transcript: [...original.transcript].reverse() },
    { ...original, historicalEvents: [...original.historicalEvents, { step: 2 }] },
    { ...original, taskContext: { authorization: 'different' } },
    { ...original, provenance: { ...original.provenance, packVersion: 'fixture-v2' } },
    { ...original, source: { ...original.source, sessionId: 'another' } },
  ];
  for (const task of variants) assert.notEqual((await sealFrozenCase(task, FILES)).contentHash, sealed.contentHash);
  assert.notEqual((await sealFrozenCase(original, [{ ...FILES[0]!, content: 'changed' }])).contentHash, sealed.contentHash);
  const completion = variants[1]!;
  assert.notEqual(sealTaskCase(completion, []).contentHash, sealTaskCase({ ...completion, execution: { mode: 'task_completion', goal: 'Goal', deliverables: ['file'], authorization: 'read only' } }, []).contentHash);
  assert.equal(sealed.baseline.artifactRefs[0]?.caseId, sealed.caseId);
});

test('different selections coexist, same selection reuses, failed new publication preserves old case and legacy history', async (t) => {
  const directory = await root(t);
  const cases = join(directory, 'cases');
  await publishFrozenCase({ taskCase: legacy(), casesRoot: cases, files: FILES });
  const oldBytes = await readFile(join(cases, legacy().caseId, 'case.json'));
  const first = await freezeCase(imported(), cases, PRIVACY, NOW, { initialMessageId: 'u1' });
  const before = await readFile(join(cases, first.taskCase.caseId, 'case.json'));
  await assert.rejects(freezeCase(imported(), cases, PRIVACY, NOW, { initialMessageId: 'u2', write: async () => { throw new Error('new write failed'); } }), /new write failed/);
  assert.deepEqual(await readFile(join(cases, first.taskCase.caseId, 'case.json')), before);
  const second = await freezeCase(imported(), cases, PRIVACY, NOW, { initialMessageId: 'u2' });
  assert.notEqual(first.taskCase.caseId, second.taskCase.caseId);
  const again = await freezeCase(imported(), cases, PRIVACY, '2026-10-15T00:00:00.000Z', { initialMessageId: 'u1' });
  assert.equal(again.reused, true);
  assert.deepEqual(await readFile(join(cases, legacy().caseId, 'case.json')), oldBytes);
  const history = await readLocalHistory(directory);
  assert.equal(history.invalidCaseCount, 0);
  assert.equal(history.cases.find(({ taskCase }) => taskCase.caseId === legacy().caseId)?.taskCase.initialInput.id, 'u1');
  assert.equal(history.cases.length, 3);
});

test('same-content concurrent directory publication is idempotent; legacy identity conflict preserves its winner', async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  const results = await Promise.all(Array.from({ length: 8 }, () => publishFrozenCase({ taskCase: task, files: FILES, casesRoot: directory, reuseExisting: true })));
  assert.equal(results.filter((result) => !result.reused).length, 1);
  assert.deepEqual(await readdir(directory), [task.caseId]);
  const variants = [legacy(), { ...legacy(), initialInput: legacy().transcript[1]! }];
  const competing = await Promise.allSettled(variants.map((item) => publishFrozenCase({ taskCase: item, files: FILES, casesRoot: directory, reuseExisting: true })));
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  const winner = variants[competing.findIndex((result) => result.status === 'fulfilled')]!;
  assert.equal((await readTaskCase(join(directory, winner.caseId, 'case.json'))).initialInput.id, winner.initialInput.id);
});

test('independent processes share filesystem case publication ownership', { timeout: 30_000 }, async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  const moduleUrl = new URL('../../src/products/shared/freeze.js', import.meta.url).href;
  const script = `import { publishFrozenCase } from ${JSON.stringify(moduleUrl)};
    process.once('message', async () => {
      try { const result = await publishFrozenCase({ taskCase: JSON.parse(process.argv[2]), files: [{ relativePath: 'raw/session.txt', content: 'source' }, { relativePath: 'baseline-artifacts/artifact-1', content: 'artifact' }], casesRoot: process.argv[1], reuseExisting: true }); process.stdout.write(result.reused ? 'reused' : 'created'); }
      catch (error) { process.stderr.write(error.stack); process.exitCode = 1; }
      process.disconnect();
    }); process.send('ready');`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, JSON.stringify(task)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = ''; let errors = '';
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    return { child, ready: once(child, 'message'), done: once(child, 'exit').then(([code]) => { assert.equal(code, 0, errors); return output; }) };
  });
  await Promise.all(children.map((child) => child.ready));
  for (const child of children) child.child.send('start');
  assert.deepEqual((await Promise.all(children.map((child) => child.done))).sort(), ['created', 'reused']);
  assert.deepEqual(await readdir(directory), [task.caseId]);
});

test('unified read verifies files and identity, supports moved roots, and copies verified external files for persistence', async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  await publishFrozenCase({ taskCase: task, casesRoot: directory, files: FILES });
  const moved = join(directory, 'moved');
  await mkdir(moved);
  await rename(join(directory, task.caseId), join(moved, task.caseId));
  const loaded = await readTaskCase(join(moved, task.caseId, 'case.json'), { expectedCaseId: task.caseId, requireComplete: true });
  assert.equal(loaded.contentHash, task.contentHash);
  const target = join(directory, 'copy', task.caseId, 'case.json');
  await persistTaskCase(target, loaded);
  assert.equal((await readTaskCase(target)).contentHash, task.contentHash);
  await assert.rejects(persistTaskCase(join(directory, 'no-origin', task.caseId, 'case.json'), task), /verified source directory/);
  await writeFile(join(moved, task.caseId, 'raw/session.txt'), 'tamper');
  const bytes = await readFile(join(moved, task.caseId, 'case.json'));
  await assert.rejects(readTaskCase(join(moved, task.caseId, 'case.json')), /integrity mismatch/);
  await assert.rejects(publishFrozenCase({ taskCase: task, files: FILES, casesRoot: moved, reuseExisting: true }), /integrity mismatch/);
  assert.deepEqual(await readFile(join(moved, task.caseId, 'case.json')), bytes);
});

for (const variant of ['future', 'missing-identity', 'foreign-owner', 'wrong-digest', 'wrong-file-hash', 'wrong-algorithm', 'legacy-identity'] as const) {
  test(`unified validation rejects ${variant} without accepting a legacy digest as v2`, async () => {
    const task = await sealFrozenCase(legacy(), FILES);
    const value = structuredClone(task);
    if (variant === 'future') Object.assign(value, { schemaVersion: 3 });
    if (variant === 'missing-identity') delete value.freezeIdentity;
    if (variant === 'foreign-owner') value.baseline.artifactRefs[0]!.caseId = 'foreign';
    if (variant === 'wrong-digest') value.contentHash = value.provenance.sourceHash;
    if (variant === 'wrong-file-hash') value.freezeIdentity!.files[0]!.contentHash = sha256('tamper');
    if (variant === 'wrong-algorithm') Object.assign(value.freezeIdentity!, { algorithm: 'future' });
    if (variant === 'legacy-identity') value.schemaVersion = 1;
    assert.throws(() => validateTaskCase(value));
  });
}

test('unsafe, duplicate and linked file bindings cannot become trusted frozen evidence', async (t) => {
  for (const path of ['../outside', '/absolute', 'C:/drive', 'a\\b', 'raw/NUL', 'raw/file.', 'case.json', 'case.complete', 'CASE.JSON', 'Case.Complete', 'file.TMP-other']) assert.throws(() => assertFrozenFilePath(path));
  await assert.rejects(sealFrozenCase(legacy(), [FILES[0]!, { ...FILES[0]!, relativePath: 'RAW/session.txt' }]), /duplicate/);
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  await publishFrozenCase({ taskCase: task, casesRoot: directory, files: FILES });
  const outside = join(directory, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'session.txt'), 'source');
  await rm(join(directory, task.caseId, 'raw'), { recursive: true });
  await symlink(outside, join(directory, task.caseId, 'raw'), 'junction');
  await assert.rejects(readTaskCase(join(directory, task.caseId, 'case.json')), /symbolic link or junction/);
  assert.deepEqual(await listPublishedFrozenCases(directory), [task.caseId]);
});


test('case-root junction cannot claim an outside case, including a legacy case', async (t) => {
  const directory = await root(t);
  const task = legacy();
  const outside = join(directory, 'outside');
  const cases = join(directory, 'cases');
  await mkdir(cases);
  await publishFrozenCase({ taskCase: task, casesRoot: outside, files: FILES });
  await symlink(join(outside, task.caseId), join(cases, task.caseId), 'junction');
  const before = await readFile(join(outside, task.caseId, 'case.json'));
  await assert.rejects(readTaskCase(join(cases, task.caseId, 'case.json'), { expectedCaseId: task.caseId }), /root must be a real directory/);
  await assert.rejects(publishFrozenCase({ taskCase: task, files: FILES, casesRoot: cases, reuseExisting: true }), /root must be a real directory/);
  assert.deepEqual(await readFile(join(outside, task.caseId, 'case.json')), before);
  const linkedRoot = join(directory, 'linked-cases');
  await symlink(outside, linkedRoot, 'junction');
  await assert.rejects(publishFrozenCase({ taskCase: task, files: FILES, casesRoot: linkedRoot, reuseExisting: true }), /casesRoot must be a real directory/);
});

test('publication releases only its own lease and preserves a swapped owner after a successful action', async (t) => {
  const directory = await root(t);
  const target = join(directory, 'case');
  const lock = `${target}.publish-lock`;
  await assert.rejects(withFrozenCaseLease(target, async () => {
    await rm(lock);
    await writeFile(lock, 'different-owner');
    return 'result';
  }), /lease ownership changed/);
  assert.equal(await readFile(lock, 'utf8'), 'different-owner');
});

test('verified source copy is checked again in private staging before publication', async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  const source = join(directory, 'source');
  const cases = join(directory, 'cases');
  await publishFrozenCase({ taskCase: task, files: FILES, casesRoot: source });
  const loaded = await readTaskCase(join(source, task.caseId, 'case.json'));
  const old = await readFile(join(source, task.caseId, 'case.json'));
  await writeFile(join(source, task.caseId, 'raw/session.txt'), 'changed after verified read');
  await assert.rejects(persistTaskCase(join(cases, task.caseId, 'case.json'), loaded), /integrity mismatch|Publication bytes/);
  assert.deepEqual(await readFile(join(source, task.caseId, 'case.json')), old);
  assert.deepEqual(await listPublishedFrozenCases(cases), []);
});


for (const variant of ['invalid-manifest', 'wrong-byte-length', 'missing-file', 'duplicate-artifact', 'unbound-reference'] as const) {
  test(`new artifact binding rejects ${variant} before publishing a trusted case`, async (t) => {
    const directory = await root(t);
    const artifact = { artifactId: 'artifact-1', logicalPath: 'out.txt', bundleId: 'bundle', contentHash: sha256('artifact'), byteLength: 8,
      origin: 'reconstructed_from_history', sourceRefs: ['event:source'], finality: 'final' };
    const manifest = { schemaVersion: 1, sourceHash: sha256('trace'), extractorVersion: 'fixture-v1', artifacts: [artifact], issues: [] };
    if (variant === 'wrong-byte-length') artifact.byteLength++;
    if (variant === 'duplicate-artifact') manifest.artifacts.push({ ...artifact });
    const task = legacy();
    if (variant === 'unbound-reference') task.baseline.artifactRefs[0]!.artifactId = 'artifact-other';
    const files: FrozenFile[] = [FILES[0]!, { relativePath: 'baseline-artifacts/manifest.json', content: JSON.stringify(variant === 'invalid-manifest' ? {} : manifest) },
      ...(variant === 'missing-file' ? [] : [{ relativePath: 'baseline-artifacts/files/bundle/out.txt', content: 'artifact' }])];
    const sealed = await sealFrozenCase(task, files);
    await assert.rejects(publishFrozenCase({ taskCase: sealed, files, casesRoot: directory }), /artifact manifest|artifact reference/);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('v2 initial input must be a retained user message and can be resealed after an explicit execution change', async () => {
  const task = legacy();
  await assert.rejects(sealFrozenCase({ ...task, transcript: task.transcript.slice(1) }, FILES), /recorded user message/);
  const frozen = await sealFrozenCase(task, FILES);
  const completion = await sealFrozenCase({ ...frozen, execution: { mode: 'task_completion', goal: 'Goal', deliverables: [], authorization: 'read' } }, FILES);
  assert.notEqual(completion.caseId, frozen.caseId);
});


test('publication rejects unbound extra or changed bytes and private readers reject later unbound files', async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  await assert.rejects(publishFrozenCase({ taskCase: task, casesRoot: directory, files: [...FILES, { relativePath: 'extra.txt', content: 'unbound' }] }), /Publication bytes/);
  await assert.rejects(publishFrozenCase({ taskCase: task, casesRoot: directory, files: [{ ...FILES[0]!, content: 'changed' }, FILES[1]!] }), /Publication bytes/);
  await publishFrozenCase({ taskCase: task, casesRoot: directory, files: FILES });
  await writeFile(join(directory, task.caseId, 'baseline-artifacts/unbound.txt'), 'unbound');
  await assert.rejects(readTaskCase(join(directory, task.caseId, 'case.json'), { expectedCaseId: task.caseId, requireComplete: true }), /unbound file/);
  const external = await readTaskCase(join(directory, task.caseId, 'case.json'));
  const copied = join(directory, 'copy', task.caseId, 'case.json');
  await persistTaskCase(copied, external);
  await assert.rejects(readFile(join(directory, 'copy', task.caseId, 'baseline-artifacts/unbound.txt')), { code: 'ENOENT' });
});


test('copy-time source mutation is detected by staged file verification after initial publication validation', async (t) => {
  const directory = await root(t);
  const task = await sealFrozenCase(legacy(), FILES);
  const source = join(directory, 'source');
  await publishFrozenCase({ taskCase: task, casesRoot: source, files: FILES });
  const loaded = await readTaskCase(join(source, task.caseId, 'case.json'));
  const cases = join(directory, 'cases');
  const files = task.freezeIdentity!.files.map((file) => ({ relativePath: file.relativePath, copyFrom: join(source, task.caseId, file.relativePath) }));
  await assert.rejects(publishFrozenCase({ taskCase: loaded, casesRoot: cases, files,
    write: async (path, bytes, signal) => {
      await writeImmutable(path, bytes, signal);
      if (path.endsWith('case.json')) await writeFile(join(source, task.caseId, 'raw/session.txt'), 'mutation during copying');
    },
  }), /integrity mismatch/);
  assert.deepEqual(await readdir(cases), []);
  assert.equal((JSON.parse(await readFile(join(source, task.caseId, 'case.json'), 'utf8')) as TaskCase).contentHash, task.contentHash);
});
