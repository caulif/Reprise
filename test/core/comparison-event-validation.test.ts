import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';

test('findings and usage events reject malformed payloads on append and reopening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-comparison-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment');
  await store.acquireWriter();
  await assert.rejects(store.append({ type: 'comparison.findings_updated', payload: { revision: 0 } }), /payload does not satisfy/);
  await assert.rejects(store.append({ type: 'comparison.investigation_closed', payload: { reason: 'completed' } }), /payload does not satisfy/);
  await assert.rejects(store.append({ type: 'comparison.draft_accepted', payload: { findingsRevision: 0 } }), /payload does not satisfy/);
  await assert.rejects(store.append({ type: 'comparison.resources_completed', payload: { modelRequests: -1 } }), /payload does not satisfy/);
  await assert.rejects(store.append({ type: 'agent.usage_reported', payload: { model: 'test', scope: 'generation', usage: { input: -1 } } }), /payload does not satisfy/);
  await store.append({ type: 'comparison.findings_updated', payload: {
    schemaVersion: 1, attemptId: 'attempt', revision: 1, catalogRevision: 0, digest: 'a'.repeat(64), artifactId: 'findings',
  } });
  await store.append({ type: 'agent.usage_reported', payload: {
    model: 'test', scope: 'compaction', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  } });
  await store.append({ type: 'comparison.investigation_closed', payload: {
    schemaVersion: 1, attemptId: 'attempt', sessionId: 'session', reason: 'bounded_investigation_timeout',
    previous: { revision: 1, catalogRevision: 0, digest: 'a'.repeat(64) }, current: { revision: 2, catalogRevision: 0, digest: 'b'.repeat(64) },
    questionIds: ['question'], semanticAssessment: 'not_certified',
  } });
  await store.close();
  const reopened = await ExperimentStore.open(root, 'experiment');
  assert.equal(reopened.events().length, 3);
  await reopened.close();
});
