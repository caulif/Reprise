import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  CandidateSpecSchema,
  RunAttemptSchema,
  RunManifestSchema,
  TaskCaseSchema,
  RecoveryInvestigationSchema,
  type RunAttempt,
  type RunManifest,
} from '../src/core/schema.js';
import { assertTransition, canTransition } from '../src/core/state-machine.js';
import { controllerRequestSnapshot } from '../src/application/controller-briefing.js';
import { reconstructControllerRequest } from '../src/application/controller-request.js';
import { sha256 } from '../src/core/identity.js';
import { ExperimentStore, RecoveryArtifactBudgetError } from '../src/infrastructure/store/experiment-store.js';

function lockNonce(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('nonce' in value) || typeof value.nonce !== 'string') {
    throw new Error('writer.lock is missing a string nonce');
  }
  return value.nonce;
}

const timestamp = '2026-08-10T00:00:00.000Z';
const candidate = { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-test' };
const policy = {
  wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1,
  maxConsecutiveNoProgress: 1,
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
    providerId: 'test', requestedModel: 'test',
    budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
  },
  comparison: {
    providerId: 'test', requestedModel: 'test',
    budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
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
    provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64),
  };
  assert.equal(Value.Check(TaskCaseSchema, taskCase), true);
  assert.equal(Value.Check(CandidateSpecSchema, { ...candidate, candidateId: '../escape' }), false);
  assert.equal(Value.Check(RecoveryInvestigationSchema, {
    schemaVersion: 1,
    facts: [{ factId: "workspace-1", kind: "workspace", reliability: "weak", sourceRefs: ["event:history-1"], observedAt: "2026-08-18T00:00:00.000Z", pathScope: ["README.md"], summary: "Workspace contains a task-related file." }],
    plan: { planId: "plan-1", factsUsed: ["fact:workspace-1"], hypotheses: [{ hypothesisId: "hypothesis-1", rationale: "Inspect the current file as a candidate baseline.", paths: ["README.md"], supportingFactRefs: ["fact:workspace-1"], counterFactRefs: [], expectedChecks: ["read the diff"], confidence: "low" }], candidates: [{ hypothesisId: "hypothesis-1", operations: [] }], verificationPlan: ["read the diff"] },
    candidates: [{ candidateId: "candidate-1", hypothesisId: "hypothesis-1", status: "created", factRefs: ["fact:workspace-1"], beforeDigest: "a".repeat(64), createdAt: "2026-08-18T00:00:00.000Z" }],
  }), true);
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

test('store hands incremental readers only the events appended after their cursor', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    await store.append({ type: 'test.event', runId: 'run-1', payload: { value: 1 } });
    await store.append({ type: 'test.event', runId: 'run-2', payload: { value: 2 } });
    const first = store.eventsSince(0, 'run-1');
    assert.equal(first.events.length, 1);
    assert.equal(first.cursor, 2);

    await store.append({ type: 'test.event', runId: 'run-1', payload: { value: 3 } });
    const second = store.eventsSince(first.cursor, 'run-1');
    assert.deepEqual(second.events.map((event) => event.payload), [{ value: 3 }]);
    assert.equal(store.eventsSince(second.cursor, 'run-1').events.length, 0);
    // A cursor from a discarded snapshot must not read past the end of the journal.
    assert.equal(store.eventsSince(99, 'run-1').events.length, 0);
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

test('store rejects malformed Controller request and observation payloads', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    await assert.rejects(
      store.append({
        type: 'controller.requested',
        runId: 'run-1',
        operationId: 'controller-request-run-1-1',
        payload: { schemaVersion: 1, requestId: 'controller-request-run-1-1' },
      }),
      /controller.requested payload does not satisfy its schema/,
    );
    await assert.rejects(
      store.append({
        type: 'controller.observation_read',
        runId: 'run-1',
        operationId: 'controller-request-run-1-1-observation-1',
        payload: { requestId: 'controller-request-run-1-1', evidenceRefs: ['event:tool-new'] },
      }),
      /controller.observation_read payload does not satisfy its schema/,
    );
    await assert.rejects(
      store.append({
        type: 'comparison.requested',
        runId: 'run-1',
        operationId: 'comparison-requested',
        payload: { schemaVersion: 1, requestId: 'comparison-requested' },
      }),
      /comparison.requested payload does not satisfy its schema/,
    );
    for (const type of ['comparison.plan_requested', 'comparison.report_requested'] as const) {
      await assert.rejects(
        store.append({ type, runId: 'run-1', operationId: `${type}-bad`, payload: { schemaVersion: 1, attemptId: 'attempt-1', phase: type.includes('plan') ? 'plan' : 'report' } }),
        new RegExp(`${type} payload does not satisfy its schema`),
      );
    }
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store reconstructs a Controller request from persisted events including observation reads', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const snapshot = controllerRequestSnapshot({
      requestId: 'controller-request-run-1-1',
      runId: 'run-1',
      runState: 'awaiting_controller',
      task: {
        initialInput: { id: 'message-1', role: 'user', text: 'Implement it.' },
        baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
        privacy: { allowModelText: true, allowBinary: false, redactions: [] },
        historicalUserTurns: [],
      },
      current: { summary: 'Waiting.', evidenceRefs: ['event:current-1'] },
      trajectory: { summary: 'None.', evidenceRefs: [] },
      evidenceCatalog: [{ ref: 'event:current-1', runId: 'run-1', source: 'initial' }],
      budget: { decisionsUsed: 0, decisionsLimit: 2 },
    });
    await store.append({
      type: 'controller.requested',
      runId: 'run-1',
      operationId: 'controller-request-run-1-1',
      payload: {
        schemaVersion: 1,
        toolSetVersion: 1,
        requestId: 'controller-request-run-1-1',
        runId: 'run-1',
        inputDigest: sha256(JSON.stringify(snapshot)),
        snapshot,
      },
    });
    await store.append({
      type: 'controller.observation_read',
      runId: 'run-1',
      operationId: 'controller-request-run-1-1-observation-1',
      payload: {
        schemaVersion: 1,
        requestId: 'controller-request-run-1-1',
        runId: 'run-1',
        source: 'run_events',
        evidenceRefs: ['event:current-1', 'event:tool-new'],
      },
    });
    const rebuilt = reconstructControllerRequest(store.events('run-1'), 'controller-request-run-1-1');
    assert.deepEqual(rebuilt.snapshot.current, snapshot.current);
    assert.deepEqual(rebuilt.snapshot.evidenceCatalog, [
      { ref: 'event:current-1', runId: 'run-1', source: 'initial' },
      { ref: 'event:tool-new', runId: 'run-1', source: 'tool' },
    ]);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store notifies live observers only until they unsubscribe', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const observed: number[] = [];
    const unsubscribe = store.subscribe((event) => observed.push(event.sequence));
    await store.append({ type: 'test.first', payload: {} });
    unsubscribe();
    await store.append({ type: 'test.second', payload: {} });
    assert.deepEqual(observed, [1]);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery artifact policy audits soft budgets and rejects hard budgets without writing the payload', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1', {
      recoveryArtifactPolicy: { softBytes: 5, hardBytes: 8 },
    });
    await store.acquireWriter();
    await store.commitArtifact({ artifactId: 'recovery-small', kind: 'recovery_report', bytes: Buffer.from('123456') });
    assert.equal(store.events().some((event) => event.type === 'recovery.artifact_budget_soft_exceeded'), true);
    await assert.rejects(
      store.commitArtifact({ artifactId: 'recovery-too-large', kind: 'recovery_report', bytes: Buffer.from('123') }),
      RecoveryArtifactBudgetError,
    );
    assert.equal(store.events().some((event) => event.type === 'recovery.artifact_budget_hard_rejected'), true);
    assert.equal((await store.listArtifacts()).some((artifact) => artifact.artifactId === 'recovery-too-large'), false);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery artifact cleanup applies terminal-specific TTL and audits the result', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1', {
      recoveryArtifactPolicy: { softBytes: 100, hardBytes: 200, successTtlMs: 1, failureTtlMs: 1 },
    });
    await store.acquireWriter();
    await store.commitArtifact({ artifactId: 'recovery-old', kind: 'recovery_report', bytes: Buffer.from('old') });
    const result = await store.cleanupRecoveryArtifacts({ terminalStatus: 'completed', now: Date.now() + 100 });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal((await store.listArtifacts()).some((artifact) => artifact.artifactId === 'recovery-old'), false);
    assert.equal(store.events().some((event) => event.type === 'recovery.artifact_cleanup_completed'), true);
    await store.close();
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
      type: 'runtime.visible_output',
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
test('store ignores a tail half-line until it owns the writer lock, then refreshes and repairs it', async () => {
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
    const beforeOpen = await readFile(join(root, 'events.jsonl'), 'utf8');
    const reopened = await ExperimentStore.open(root, 'experiment-1');
    assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), beforeOpen);
    assert.equal(reopened.replay('run-1').attempt?.runId, 'run-1');

    const otherWriter = await ExperimentStore.open(root, 'experiment-1');
    await otherWriter.acquireWriter();
    await otherWriter.append({ type: 'run.noted', operationId: 'refresh-check', payload: {} });
    await otherWriter.close();
    assert.equal(reopened.events().some((event) => event.operationId === 'refresh-check'), false);

    await reopened.acquireWriter();
    assert.equal(reopened.events().some((event) => event.operationId === 'refresh-check'), true);
    assert.match(await readFile(join(root, 'events.jsonl'), 'utf8'), /\n$/);
    await reopened.append({ type: 'run.noted', operationId: 'after-repair', payload: {} });
    assert.equal(reopened.events().at(-1)?.sequence, 4);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schema fixtures remain valid for persisted run snapshots', () => {
  assert.equal(Value.Check(RunAttemptSchema, attempt), true);
  assert.equal(Value.Check(RunManifestSchema, manifest), true);
});


test('store refuses a leftover writer lock instead of reclaiming it', async () => {
  const root = await temporaryExperiment();
  try {
    await writeFile(join(root, 'writer.lock'), `${JSON.stringify({ experimentId: 'experiment-1', pid: 999_999_999, nonce: 'stale-lock', startedAt: '2026-01-01T00:00:00.000Z', host: hostname() })}\n`);
    const store = await ExperimentStore.open(root, 'experiment-1');
    await assert.rejects(store.acquireWriter(), /already has an active writer/);
    assert.equal(lockNonce(await readFile(join(root, 'writer.lock'), 'utf8')), 'stale-lock');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store refuses an unreadable writer lock without deleting it', async () => {
  for (const corrupt of ['', '{"experimentId":"experi', '{"experimentId":"experiment-1"}']) {
    const root = await temporaryExperiment();
    try {
      await writeFile(join(root, 'writer.lock'), corrupt);
      const store = await ExperimentStore.open(root, 'experiment-1');
      await assert.rejects(store.acquireWriter(), /already has an active writer/);
      assert.equal(await readFile(join(root, 'writer.lock'), 'utf8'), corrupt);
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('store does not retire a foreign writer lock by age', async () => {
  const root = await temporaryExperiment();
  const foreign = { experimentId: 'experiment-1', pid: process.pid, nonce: 'foreign-lock', host: `${hostname()}-other` };
  try {
    await writeFile(join(root, 'writer.lock'), `${JSON.stringify({ ...foreign, startedAt: new Date().toISOString() })}\n`);
    const blocked = await ExperimentStore.open(root, 'experiment-1');
    await assert.rejects(blocked.acquireWriter(), /already has an active writer/);
    await blocked.close();

    await writeFile(join(root, 'writer.lock'), `${JSON.stringify({ ...foreign, startedAt: '2026-01-01T00:00:00.000Z' })}\n`);
    const store = await ExperimentStore.open(root, 'experiment-1');
    await assert.rejects(store.acquireWriter(), /already has an active writer/);
    assert.equal(lockNonce(await readFile(join(root, 'writer.lock'), 'utf8')), 'foreign-lock');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('store close does not remove a replacement writer lock with another nonce', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const replacement = { experimentId: 'experiment-1', pid: process.pid, nonce: 'replacement-lock', startedAt: new Date().toISOString(), host: hostname() };
    await writeFile(join(root, 'writer.lock'), `${JSON.stringify(replacement)}
`);
    await store.close();
    assert.deepEqual(JSON.parse(await readFile(join(root, 'writer.lock'), 'utf8')), replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store allows only one writer on an experiment and does not serialize different experiments', async () => {
  const root = await temporaryExperiment();
  const other = await temporaryExperiment();
  try {
    const first = await ExperimentStore.open(root, 'experiment-1');
    const contender = await ExperimentStore.open(root, 'experiment-1');
    const second = await ExperimentStore.open(other, 'experiment-2');
    await first.acquireWriter();
    await assert.rejects(contender.acquireWriter(), /already has an active writer/);
    await second.acquireWriter();
    await first.append({ type: 'run.noted', operationId: 'noted-1', payload: { experiment: 'one' } });
    await second.append({ type: 'run.noted', operationId: 'noted-2', payload: { experiment: 'two' } });
    await Promise.all([first.close(), contender.close(), second.close()]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("store refuses to open a journal with corrupt event JSON", async () => {
  const root = await temporaryExperiment();
  try {
    await writeFile(join(root, "events.jsonl"), "{not-json}\n");
    await assert.rejects(
      ExperimentStore.open(root, "experiment-1"),
      /Corrupt event JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
