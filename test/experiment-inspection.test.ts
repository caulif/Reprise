import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWorkspaceScope, inspectRun } from '../src/application/experiment-inspection.js';
import type { EventEnvelope, RunRecord } from '../src/core/schema.js';
import type { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';
import type { LocalWorkspaceProvider, PreparedEnvironmentRef } from '../src/environment/local-workspace-provider.js';

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

test('captureWorkspaceScope does not snapshot a sibling tree that shares a path prefix', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'reprise-scope-prefix-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'app');
  await mkdir(root);
  await mkdir(join(parent, 'app2'));
  await writeFile(join(parent, 'app2', 'secret.txt'), 'SIBLING_SECRET_SHOULD_NOT_SNAPSHOT');
  const empty = { capturedAt: '2026-09-08T00:00:00.000Z', resources: [], digest: '0'.repeat(64) };
  const after = {
    capturedAt: empty.capturedAt,
    resources: [{ path: '../app2/secret.txt', kind: 'file' as const, size: 32 }],
    digest: '1'.repeat(64),
  };
  const artifacts: Buffer[] = [];
  await captureWorkspaceScope({
    store: { commitArtifact: async (input: { bytes: Uint8Array }) => { artifacts.push(Buffer.from(input.bytes)); } } as unknown as ExperimentStore,
    environment: { root, beforeFingerprint: empty } as unknown as PreparedEnvironmentRef,
    workspaceProvider: {
      fingerprint: async () => after,
      sealCandidateSnapshot: async () => ({ root: join(parent, 'snapshots', 'run-1'), status: 'complete' as const }),
    } as unknown as LocalWorkspaceProvider,
    experimentId: 'experiment-1',
    runId: 'run-1',
  });
  assert.equal(artifacts.length, 1);
  const payload = JSON.parse(artifacts[0]!.toString('utf8')) as { textSnapshots: unknown[] };
  assert.equal(payload.textSnapshots.length, 0);
  assert.doesNotMatch(artifacts[0]!.toString('utf8'), /SIBLING_SECRET/);
});

