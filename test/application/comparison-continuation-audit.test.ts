import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentAgentAuditSink } from '../../src/application/experiment-helpers.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';

test('Store validates new continuation and stream timing events, rejecting malformed persisted facts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-continuation-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'audit'); await store.acquireWriter();
  t.after(() => store.close());
  const continuation = { schemaVersion: 1, phase: 'review', granted: true, reason: 'granted', oldDeadline: 1,
    newDeadline: 60_001, remainingMs: 300_000, extension: 1 };
  await experimentAgentAuditSink(store, 'run-1').append({ type: 'comparison.sources_continued', sessionId: 'session', role: 'comparison', payload: { attemptId: 'attempt-1', ...continuation } });
  await assert.rejects(store.append({ type: 'comparison.sources_continued', payload: { ...continuation, extension: 3 } }), /schema/);
  const stream = { schemaVersion: 1, requestIndex: 1, startedAt: 1000, firstEventAt: 1010, firstTextAt: null, finishedAt: 1030, events: 1 };
  await experimentAgentAuditSink(store, 'run-1').append({ type: 'agent.model_stream_completed', sessionId: 'session', role: 'comparison', payload: { attemptId: 'attempt-1', ...stream } });
  await assert.rejects(store.append({ type: 'agent.model_stream_completed', payload: { ...stream, firstEventAt: 'unknown' } }), /schema/);
});
