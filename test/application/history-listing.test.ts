import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalHistory, readLocalHistoryListing, readLocalHistoryExperiment } from '../../src/application/experiment-history-list.js';
import { collectHistoryStorageSize } from '../../src/application/history-io.js';
import { startExperiment } from '../../src/application/experiment.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink } from '../../src/application/experiment-helpers.js';
import { callerLoopHooks } from '../../src/infrastructure/agent/audit.js';
import { inlineBody } from '../../src/infrastructure/agent/model-input.js';
import { sha256 } from '../../src/core/identity.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { sealFrozenCase } from '../../src/products/shared/frozen-case-files.js';
import { publishFrozenCase } from '../../src/products/shared/freeze.js';
import { readTaskCase } from '../../src/products/shared/task-case-reader.js';

test('listing defers attachments and snapshot traversal, selected audit still diagnoses damaged inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-listing-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const result = await startExperiment({ ...base, compare: false }).result;
  const snapshot = join(result.experimentRoot, 'benchmark-snapshots');
  await mkdir(snapshot);
  await writeFile(join(snapshot, 'large.txt'), 'snapshot'.repeat(8192));
  const store = await ExperimentStore.open(result.experimentRoot, base.experimentId);
  await store.acquireWriter();
  let artifactId: string;
  try {
    const audit = experimentAgentAuditSink(store, base.runId);
    const cursor = { invocationId: 'inv-listing', requestIndex: 1 };
    await audit.append({ type: 'agent.session_started', sessionId: 'session-listing', role: 'comparison', payload: { systemPrompt: 'Inspect', tools: [] } });
    await audit.append({ type: 'agent.message_appended', sessionId: 'session-listing', role: 'comparison', payload: { ...cursor, body: inlineBody('Go') } });
    const context = { systemPrompt: 'Inspect', messages: [{ role: 'user', content: 'x'.repeat(16384) }], tools: [] };
    await callerLoopHooks('session-listing', 'comparison', cursor, audit).onModelRequest!({ model: 'fixture', scope: 'generation',
      digest: sha256(JSON.stringify(context)), messageCount: 1, images: [], generationContext: context });
    artifactId = ([...store.events()].reverse().find(event => event.type === 'agent.model_request')!.payload as { generationInput: { artifactId: string } }).generationInput.artifactId;
  } finally { await store.close(); }
  const before = await readFile(join(result.experimentRoot, 'events.jsonl'));
  const originalRead = fs.readFile;
  const originalDirectory = fs.readdir;
  let attachmentReads = 0;
  let snapshotWalks = 0;
  fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
    if (typeof args[0] === 'string' && args[0].includes(artifactId)) attachmentReads++;
    return originalRead(...args);
  }) as typeof fs.readFile;
  fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
    if (typeof args[0] === 'string' && args[0].includes('benchmark-snapshots')) snapshotWalks++;
    return originalDirectory(...args);
  }) as typeof fs.readdir;
  syncBuiltinESMExports();
  try {
    const listed = await readLocalHistoryListing(base.dataDir);
    assert.equal(attachmentReads, 0);
    assert.equal(snapshotWalks, 0);
    assert.equal(listed.totalBytes, undefined);
    assert.equal(listed.storageSizeStatus, 'not_collected');
    assert.equal(listed.experiments[0]?.modelInputAudit, 'not_checked');
    assert.equal(listed.experiments[0]?.sizeBytes, undefined);
    const detail = await readLocalHistoryExperiment(base.dataDir, base.experimentId);
    assert.equal(detail.modelInputAudit, 'checked');
    assert.equal(detail.incompleteModelInput, undefined);
    assert.ok(attachmentReads > 0);
    assert.equal(snapshotWalks, 0);
    const storage = await collectHistoryStorageSize(base.dataDir);
    assert.equal(storage.status, 'collected');
    assert.ok(storage.bytes > 8192);
    assert.ok(snapshotWalks > 0);
  } finally { fs.readFile = originalRead; fs.readdir = originalDirectory; syncBuiltinESMExports(); }
  await writeFile(join(result.experimentRoot, 'runs', base.runId, 'artifacts', artifactId), 'damaged');
  assert.equal((await readLocalHistoryListing(base.dataDir)).experiments[0]?.modelInputAudit, 'not_checked');
  assert.equal((await readLocalHistoryExperiment(base.dataDir, base.experimentId)).incompleteModelInput, true);
  assert.deepEqual(await readFile(join(result.experimentRoot, 'events.jsonl')), before);
});

test('an individual entry I/O fault and partial event prefix remain visible beside healthy history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-listing-damage-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const result = await startExperiment({ ...base, compare: false }).result;
  const bad = join(base.dataDir, 'experiments', 'damaged');
  await mkdir(join(bad, 'experiment.json'), { recursive: true });
  const log = join(result.experimentRoot, 'events.jsonl');
  const bytes = await readFile(log);
  await writeFile(log, Buffer.concat([bytes, Buffer.from('{"schemaVersion":')]));
  const listing = await readLocalHistoryListing(base.dataDir);
  assert.equal(listing.experiments.length, 2);
  const healthy = listing.experiments.find(item => item.experimentId === base.experimentId)!;
  assert.equal(healthy.eventLogDiagnostic, 'incomplete_tail');
  const damaged = listing.experiments.find(item => item.experimentId === 'damaged')!;
  assert.equal(damaged.outcome, 'unknown');
  assert.match(damaged.eventLogErrorCode!, /^E[A-Z0-9]+$/);
  assert.deepEqual(await readFile(log), Buffer.concat([bytes, Buffer.from('{"schemaVersion":')]));
  assert.equal((await readLocalHistory(base.dataDir)).experiments.length, 2);
  await rm(join(result.experimentRoot, 'experiment.json'));
  const fallback = (await readLocalHistoryListing(base.dataDir)).experiments.find(item => item.experimentId === base.experimentId)!;
  assert.equal(fallback.formatError, 'missing_metadata');
  assert.equal(fallback.eventLogDiagnostic, 'incomplete_tail');
  assert.equal(fallback.modelInputAudit, 'not_checked');
});

test('listing metadata does not certify frozen file integrity or bypass the selected-case reader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-listing-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = input(root, new VerifiedRuntime()).taskCase;
  const files = [{ relativePath: 'source.txt', content: 'original' }];
  const sealed = await sealFrozenCase(task, files);
  await publishFrozenCase({ taskCase: sealed, files, casesRoot: join(root, 'cases') });
  const caseRoot = join(root, 'cases', sealed.caseId);
  await writeFile(join(caseRoot, 'source.txt'), 'tampered');
  const listing = await readLocalHistoryListing(root);
  assert.equal(listing.cases.length, 1);
  assert.equal(listing.cases[0]!.filesVerified, false);
  await assert.rejects(readTaskCase(listing.cases[0]!.path, { expectedCaseId: sealed.caseId, requireComplete: true }), /integrity mismatch/);
  const full = await readLocalHistory(root);
  assert.equal(full.cases.length, 0);
  assert.equal(full.invalidCaseCount, 1);
});

test('metadata listing keeps the frozen reader root and JSON link boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-listing-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = input(root, new VerifiedRuntime()).taskCase;
  const externalCases = join(root, 'external-cases');
  await publishFrozenCase({ taskCase: task, files: [], casesRoot: externalCases });
  const data = join(root, 'data');
  const cases = join(data, 'cases');
  await mkdir(cases, { recursive: true });
  await symlink(join(externalCases, task.caseId), join(cases, task.caseId), 'junction');
  const linkedRoot = await readLocalHistoryListing(data);
  assert.equal(linkedRoot.cases.length, 0);
  await rm(join(cases, task.caseId));
  await t.test('JSON symlink is rejected when the platform permits creating it', async sub => {
    const target = join(cases, task.caseId);
    await mkdir(target);
    await writeFile(join(target, 'case.complete'), 'complete');
    try { await symlink(join(externalCases, task.caseId, 'case.json'), join(target, 'case.json'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') { sub.skip('Windows file symlink privilege unavailable'); return; }
      throw error;
    }
    assert.equal((await readLocalHistoryListing(data)).cases.length, 0);
  });
});
