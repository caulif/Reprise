import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWorkspaceScope, inspectRun } from '../../src/application/controller-queries.js';
import type { EventEnvelope, RunRecord } from '../../src/core/schema.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import type { LocalWorkspaceProvider, PreparedEnvironmentRef } from '../../src/environment/local-workspace-provider.js';

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

test('latest settled turn does not reuse a previous assistant reply', async () => {
  const events = [
    envelope('runtime.visible_output', { item: { type: 'agentMessage', text: 'FIRST_REPLY' } }, 1),
    envelope('runtime.turn_settled', { status: 'completed' }, 2),
    envelope('runtime.turn_settled', { status: 'failed' }, 3),
  ];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, 'codex');
  assert.equal(observation.finalMessage, 'FIRST_REPLY');
  assert.equal(observation.turnVisibleText, undefined);
  assert.equal(observation.settlementStatus, 'failed');
  assert.match(observation.currentSummary, /No model text is available to the Controller/);
});

test('latest settled turn prompt comes from visible_prompt, not the previous reply', async () => {
  const events = [
    envelope('runtime.visible_output', { item: { type: 'agentMessage', text: 'FIRST_REPLY' } }, 1),
    envelope('runtime.turn_settled', { status: 'completed' }, 2),
    envelope('runtime.visible_prompt', {
      item: { type: 'userMessage', content: [{ type: 'text', text: 'Approve editing README.md?' }] },
    }, 3),
    envelope('runtime.turn_settled', { status: 'waiting_input' }, 4),
  ];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, 'codex');
  assert.equal(observation.turnVisibleText, undefined);
  assert.equal(observation.turnPrompt, 'Approve editing README.md?');
  assert.equal(observation.settlementStatus, 'waiting_input');
});

test('inspectRun current summary does not inline candidate final text', async () => {
  const marker = 'UNIQUE_PPT_CLAIM_SHOULD_NOT_APPEAR';
  const events = [
    envelope('runtime.visible_output', { item: { type: 'agentMessage', text: marker } }, 1),
    envelope('runtime.turn_settled', { status: 'completed' }, 2),
  ];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, 'codex');
  assert.equal(observation.finalMessage, marker);
  assert.doesNotMatch(observation.currentSummary, new RegExp(marker));
  assert.match(observation.currentSummary, /Read current-user-view.md/);
});

test('inspectRun uses the candidate product translator, not the source session product', async () => {
  const events = [envelope('runtime.visible_output', {
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls workspace' } }] },
  })];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const asSourcePack = await inspectRun(store, record, 'codex');
  const asCandidatePack = await inspectRun(store, record, 'claude-code');
  assert.equal(asSourcePack.commands.length, 0);
  assert.deepEqual(asCandidatePack.commands, ['ls workspace']);
});

test('inspectRun distinguishes workspace evidence that was not collected', async () => {
  const store = { events: () => [] } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [] } as unknown as RunRecord;
  const observation = await inspectRun(store, record, 'codex');
  assert.equal(observation.workspaceEvidenceStatus, 'not_collected');
  assert.match(observation.currentSummary, /Read current-user-view.md/);
  assert.doesNotMatch(observation.currentSummary, /Workspace evidence/);
});

test('persisted Runtime metrics stay unchanged after repeated Harness agent usage and reopening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-runtime-usage-attribution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [], outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' } } } as unknown as RunRecord;
  const replay = { sourceRootKind: 'operator_selected' as const, requestedModel: 'deepseek-v4.1-flash' };
  let store = await ExperimentStore.open(root, 'experiment-usage');
  try {
    await store.acquireWriter();
    for (const usage of [
      { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 4 },
      { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 },
    ]) await store.append({ type: 'runtime.usage_reported', runId: 'run-1', payload: { usage } });
    const before = await inspectRun(store, record, 'claude-code', undefined, replay);
    assert.deepEqual(before.tokenUsage, { total: 345, input: 30, output: 5, cached: 300 });
    assert.ok(before.costUsd !== undefined && before.costUsd > 0);
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const role of ['comparison', 'controller', 'recovery', undefined]) {
        await store.append({ type: 'agent.usage_reported', runId: 'run-1', payload: {
          model: 'gpt-6-astra', scope: 'generation', ...(role ? { role } : {}),
          usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, totalTokens: 2_000_000 },
        } });
      }
      assert.deepEqual(await inspectRun(store, record, 'claude-code', undefined, replay), before);
    }
    assert.equal(store.events('run-1').filter((event) => event.type === 'agent.usage_reported').length, 12);
    await store.close();
    store = await ExperimentStore.open(root, 'experiment-usage');
    assert.deepEqual(await inspectRun(store, record, 'claude-code', undefined, replay), before);
    await store.acquireWriter();
    await store.append({ type: 'agent.usage_reported', runId: 'run-1', payload: {
      model: 'gpt-6-astra', scope: 'compaction', role: 'comparison',
      usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, totalTokens: 2_000_000 },
    } });
    assert.deepEqual(await inspectRun(store, record, 'claude-code', undefined, replay), before);
    assert.equal(store.events('run-1').filter((event) => event.type === 'agent.usage_reported').length, 13);
  } finally {
    await store.close();
  }
});

test('Harness usage cannot turn missing Runtime telemetry into zero or priced candidate usage', async () => {
  const events = [envelope('agent.usage_reported', {
    model: 'deepseek-v4.1-flash', scope: 'generation',
    usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, totalTokens: 2_000_000 },
  })];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [], outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' } } } as unknown as RunRecord;
  const observation = await inspectRun(store, record, 'claude-code', undefined,
    { sourceRootKind: 'operator_selected', requestedModel: 'deepseek-v4.1-flash' });
  assert.equal(observation.tokenUsage, undefined);
  assert.equal(observation.tokenCount, undefined);
  assert.equal(observation.costUsd, undefined);
  assert.equal(observation.pricingLookup, undefined);
});

test('Runtime Codex watermarks and cache-inclusive deltas retain their original aggregation', async () => {
  const events: EventEnvelope[] = [];
  const store = { events: () => events } as unknown as ExperimentStore;
  const record = { attempt: { runId: 'run-1' }, artifactRefs: [], outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' } } } as unknown as RunRecord;
  const replay = { sourceRootKind: 'operator_selected' as const, requestedModel: 'gpt-6-astra' };
  for (const total of [128, 256]) events.push(envelope('runtime.usage_reported', {
    info: { total_token_usage: { total_tokens: total } },
  }));
  assert.equal((await inspectRun(store, record, 'codex', undefined, replay)).tokenCount, 256);
  for (const last of [
    { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20 },
    { input_tokens: 80, output_tokens: 5, cached_input_tokens: 30 },
  ]) events.push(envelope('runtime.usage_reported', {
    info: { last_token_usage: last, total_token_usage: { total_tokens: 9000 } },
  }));
  const observation = await inspectRun(store, record, 'codex', undefined, replay);
  assert.deepEqual(observation.tokenUsage, { total: 195, input: 130, output: 15, cached: 50 });
  assert.equal(observation.costUsd, (130 * 10 + 15 * 50 + 50) / 1_000_000);
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

