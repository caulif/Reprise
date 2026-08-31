import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observationTools } from '../src/infrastructure/agent-tools.js';
import type { TaskCase } from '../src/core/schema.js';
import { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

const signal = new AbortController().signal;

test('retired comparison tools are not exported from agent-tools', async () => {
  const source = await readFile(join(process.cwd(), 'src/infrastructure/agent-tools.ts'), 'utf8');
  assert.doesNotMatch(source, /read_artifact|write_comparison_report|evidenceTools|comparisonReportTool/);
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
