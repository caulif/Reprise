import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRun } from '../src/application/experiment-inspection.js';
import type { EventEnvelope, RunRecord } from '../src/core/schema.js';
import type { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

function envelope(type: string, payload: unknown, sequence = 1): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    occurredAt: '2026-09-02T00:00:00.000Z',
    type,
    runId: 'run-1',
    payload,
    checksum: 'a'.repeat(64),
  };
}

test('inspectRun current summary does not inline candidate final text', async () => {
  const marker = 'UNIQUE_PPT_CLAIM_SHOULD_NOT_APPEAR';
  const events = [
    envelope('codex.item_completed', { item: { type: 'agentMessage', text: marker } }, 1),
    envelope('runtime.turn_settled', { status: 'completed' }, 2),
  ];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, true, 'codex');
  assert.equal(observation.finalMessage, marker);
  assert.doesNotMatch(observation.currentSummary, new RegExp(marker));
  assert.match(observation.currentSummary, /inspect THIS-TURN and project files rather than treating this summary as completion/);
});

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

test('inspectRun distinguishes workspace evidence that was not collected', async () => {
  const store = { events: () => [] } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, true, 'codex');
  assert.equal(observation.workspaceEvidenceStatus, 'not_collected');
  assert.match(observation.currentSummary, /Workspace evidence: not_collected/);
});
