import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceTools, observationTools } from '../src/infrastructure/agent-tools.js';
import type { TaskCase } from '../src/core/schema.js';
import { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

const signal = new AbortController().signal;

async function catalog(): Promise<{ store: ExperimentStore; root: string; read: (params: unknown) => Promise<{ content: string; details?: unknown }> }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-agent-tools-'));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  await store.commitArtifact({ artifactId: 'evidence-1', runId: 'run-1', kind: 'text', bytes: Buffer.from('abcdefghij') });
  const [tool] = evidenceTools(store, [{ artifactId: 'evidence-1', experimentId: 'experiment-1', runId: 'run-1' }]);
  if (!tool) throw new Error('Expected catalog reader.');
  return { store, root, read: (params) => tool.execute(params, signal) };
}

test('evidence tools accept only cataloged identifiers, not filesystem paths', async (t) => {
  const { store, root, read } = await catalog();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  for (const artifactId of ['../.env', 'C:/Users/test/.env', '.env', 'id_rsa', 'symlink']) {
    await assert.rejects(read({ artifactId, runId: 'run-1' }), /not in this comparison evidence catalog/);
  }
});

test('evidence tools bound artifact reads and reject catalog misses', async (t) => {
  const { store, root, read } = await catalog();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const page = await read({ artifactId: 'evidence-1', runId: 'run-1', offset: 2, maxBytes: 3 });
  assert.equal(page.content, 'cde');
  assert.deepEqual(page.details, { artifactId: 'evidence-1', offset: 2, truncated: true, nextCursor: 5 });
  await assert.rejects(read({ artifactId: 'evidence-1', runId: 'run-1', maxBytes: 262_145 }), /maxBytes must be a positive integer/);
  await assert.rejects(read({ artifactId: 'missing', runId: 'run-1' }), /not in this comparison evidence catalog/);
  const byIdOnly = await read({ artifactId: 'evidence-1' });
  assert.equal(byIdOnly.content, 'abcdefghij');
});

test('observation tools redact assistant transcript text and nested event text when model text is disallowed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-agent-observation-'));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  await store.append({
    type: 'codex.item_completed',
    runId: 'run-1',
    payload: { item: { type: 'agentMessage', text: 'event secret' }, nested: [{ text: 'nested secret' }], keep: 'visible' },
  });
  const transcript = [
    { id: 'message-1', role: 'user', text: 'user text' },
    { id: 'message-2', role: 'assistant', text: 'assistant secret' },
  ] as TaskCase['transcript'];
  const [tool] = observationTools(store, { runId: 'run-1', transcript, allowModelText: false });
  if (!tool) throw new Error('Expected observation reader.');
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  const transcriptPage = await tool.execute({ source: 'transcript' }, signal);
  assert.deepEqual(JSON.parse(transcriptPage.content), [
    { id: 'message-1', role: 'user', text: 'user text' },
    { id: 'message-2', role: 'assistant', text: '[REDACTED]' },
  ]);
  const eventPage = await tool.execute({ source: 'run_events' }, signal);
  const redactedEvents = JSON.parse(eventPage.content) as Array<{ payload: unknown }> ;
  assert.deepEqual(redactedEvents[0]?.payload, {
    item: { type: 'agentMessage', text: '[REDACTED]' },
    nested: [{ text: '[REDACTED]' }],
    keep: 'visible',
  });
});

test('observation tools preserve model text when privacy allows it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-agent-observation-'));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  await store.append({ type: 'codex.item_completed', runId: 'run-1', payload: { text: 'event secret' } });
  const transcript = [{ id: 'message-1', role: 'assistant', text: 'assistant secret' }] as TaskCase['transcript'];
  const [tool] = observationTools(store, { runId: 'run-1', transcript, allowModelText: true });
  if (!tool) throw new Error('Expected observation reader.');
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  const transcriptPage = await tool.execute({ source: 'transcript' }, signal);
  assert.deepEqual(JSON.parse(transcriptPage.content), transcript);
  const eventPage = await tool.execute({ source: 'run_events' }, signal);
  const visibleEvents = JSON.parse(eventPage.content) as Array<{ payload: { text?: string } }>;
  assert.equal(visibleEvents[0]?.payload.text, 'event secret');
});
