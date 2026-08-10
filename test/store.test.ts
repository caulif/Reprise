import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  CandidateSpecSchema,
  RunAttemptSchema,
  RunManifestSchema,
  TaskCaseSchema,
  type RunAttempt,
  type RunManifest,
} from '../src/core/schema.js';
import { assertTransition, canTransition } from '../src/core/state-machine.js';
import { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-08-10T00:00:00.000Z';
const candidate = { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-test' };
const policy = {
  wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1,
  heartbeatTimeoutMs: 1, maxConsecutiveNoProgress: 1,
};
const attempt: RunAttempt = {
  schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate, policy, createdAt: timestamp,
};
const manifest: RunManifest = {
  schemaVersion: 1, attempt,
  resolvedModel: { requested: 'gpt-test', resolved: 'gpt-test' },
  runtime: { productId: 'codex', executable: 'codex.exe' },
  environment: { environmentId: 'environment-1', workspacePath: 'C:/safe/workspace' },
  controller: {
    providerId: 'test', requestedModel: 'test', resolvedModel: 'test',
    optionsHash: hash('options'), promptHash: hash('prompt'), toolPolicyHash: hash('tools'), contextPolicyHash: hash('context'),
    budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0, maxProviderRetries: 0 },
  },
  startedAt: timestamp,
};

async function temporaryExperiment(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'reprise-store-'));
}

test('schemas accept the minimum frozen objects and reject malformed candidates', () => {
  const taskCase = {
    schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' },
    initialInput: { id: 'message-1', role: 'user', text: 'Implement the feature.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Implement the feature.' }], historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    environmentBaseline: { status: 'unavailable', artifactRefs: [] },
    provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: hash('source') },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, contentHash: hash('case'),
  };
  assert.equal(Value.Check(TaskCaseSchema, taskCase), true);
  assert.equal(Value.Check(CandidateSpecSchema, { ...candidate, candidateId: '../escape' }), false);
});

test('CandidateRun permits only the seven-state graph', () => {
  assert.equal(canTransition('created', 'preparing'), true);
  assert.equal(canTransition('awaiting_controller', 'awaiting_target'), true);
  assert.equal(canTransition('finished', 'created'), false);
  assert.throws(() => assertTransition('finished', 'created'), /Invalid CandidateRun transition/);
});

test('store commits attempt before manifest, replays events, and preserves a terminal outcome', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    await assert.rejects(store.commitManifest(manifest), /RunAttempt must be committed/);
    await store.commitAttempt(attempt);
    await store.commitManifest(manifest);
    const first = await store.append({ type: 'run.finished', runId: 'run-1', payload: { outcome: 'first' } });
    await store.append({ type: 'runtime.late', runId: 'run-1', payload: { outcome: 'late' } });
    const replay = store.replay('run-1');
    assert.deepEqual(replay.attempt, attempt);
    assert.deepEqual(replay.manifest, manifest);
    assert.deepEqual(replay.finishedPayload, { outcome: 'first' });
    assert.equal(replay.eventIds.includes(first.eventId), true);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store rejects a second writer and repeats a submitted operation without another event', async () => {
  const root = await temporaryExperiment();
  try {
    const first = await ExperimentStore.open(root, 'experiment-1');
    const second = await ExperimentStore.open(root, 'experiment-1');
    await first.acquireWriter();
    await assert.rejects(second.acquireWriter(), /already has an active writer/);
    const one = await first.append({ type: 'test.event', operationId: 'operation-1', payload: { value: 1 } });
    const two = await first.append({ type: 'test.event', operationId: 'operation-1', payload: { value: 1 } });
    assert.equal(two.eventId, one.eventId);
    await first.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store serializes concurrent appends for a replayable event log', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const events = await Promise.all(Array.from({ length: 12 }, (_, index) => store.append({
      type: 'codex.item_completed',
      operationId: `operation-${index}`,
      payload: { output: 'x'.repeat(32_000), index },
    })));
    assert.deepEqual(events.map((event) => event.sequence).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
    await store.close();
    const reopened = await ExperimentStore.open(root, 'experiment-1');
    assert.equal(reopened.replay('run-1').eventIds.length, 0);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('store recovers a tail half-line and rejects artifact ownership violations', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    await store.commitAttempt(attempt);
    await store.commitArtifact({ artifactId: 'artifact-1', runId: 'run-1', kind: 'text', bytes: Buffer.from('hello') });
    assert.deepEqual(await store.readArtifact({ artifactId: 'artifact-1', experimentId: 'experiment-1', runId: 'run-1' }), Buffer.from('hello'));
    await assert.rejects(store.readArtifact({ artifactId: 'artifact-1', experimentId: 'other-experiment', runId: 'run-1' }), /does not belong/);
    await store.close();
    await appendFile(join(root, 'events.jsonl'), '{"broken":');
    const reopened = await ExperimentStore.open(root, 'experiment-1');
    assert.equal(reopened.replay('run-1').attempt?.runId, 'run-1');
    assert.match(await readFile(join(root, 'events.jsonl'), 'utf8'), /\n$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schema fixtures remain valid for persisted run snapshots', () => {
  assert.equal(Value.Check(RunAttemptSchema, attempt), true);
  assert.equal(Value.Check(RunManifestSchema, manifest), true);
});
