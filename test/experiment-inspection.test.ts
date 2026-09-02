import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRun } from '../src/application/experiment-inspection.js';
import type { EventEnvelope, RunRecord } from '../src/core/schema.js';
import type { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

function envelope(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: '2026-09-02T00:00:00.000Z',
    type,
    runId: 'run-1',
    payload,
    checksum: 'a'.repeat(64),
  };
}

test('inspectRun uses the candidate product translator, not the source session product', async () => {
  const events = [envelope('claude-code.assistant', {
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls workspace' } }] },
  })];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const asSourcePack = await inspectRun(store, record, true, 'codex');
  const asCandidatePack = await inspectRun(store, record, true, 'claude-code');
  assert.equal(asSourcePack.commands.length, 0);
  assert.deepEqual(asCandidatePack.commands, ['ls workspace']);
});
