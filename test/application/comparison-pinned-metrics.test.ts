import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { comparisonFixtureModel as model, publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';

test('default autonomous factory retains pinned Host metrics across actual Pi compaction, publication and replay', async t => {
  let summaries = 0;
  const steps = [...Array.from({ length: 16 }, (_, index) => ({ name: 'read', arguments: {
    path: 'candidate/metrics.txt', offset: index * 10000, maxBytes: 10000,
  } })), ...publicationSteps()];
  const f = await runAutonomousPublication(t, { steps, beforeStart: async base => {
    base.taskCase.historicalEvents = [
      { timestamp: '2026-09-11T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-09-11T00:02:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
      { timestamp: '2026-09-11T00:02:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 } } } },
    ];
    await writeFile(join(base.sourceRoot, 'metrics.txt'), Array.from({ length: 16 }, (_, index) => `evidence-${index}:`.padEnd(10000, 'x')).join(''));
  }, onResponse: (message, index) => {
    if (index === 15) { message.usage.input = 110_000; message.usage.totalTokens = 110_001; }
  }, summarize: () => {
    summaries++;
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'COMPACTED_SOURCES_WITHOUT_METRICS' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return message;
  } });
  assert.equal(f.result.comparison.result.status, 'completed', JSON.stringify(f.result.comparison));
  assert.equal(f.renders, 1);
  assert.equal(summaries, 1);
  assert.equal(f.events.filter(event => event.type === 'agent.session_started' && event.payload.role === 'comparison').length, 1);
  const prompt = f.contexts[0]!.systemPrompt!;
  assert.match(prompt, /Pinned Host metrics:.*"baseline":\{"elapsedMs":120000,"tokens":\{"total":120/);
  assert.match(prompt, /"candidate":\{.*"usageStatus":"not_collected"/);
  assert.match(prompt, /Unknown is not zero/);
  for (const actual of f.contexts.slice(-2)) {
    assert.equal(actual.systemPrompt, prompt);
    assert.match(JSON.stringify(actual.messages), /COMPACTED_SOURCES_WITHOUT_METRICS/);
    assert.doesNotMatch(JSON.stringify(actual.messages), /evidence-0:/);
    assert.doesNotMatch(JSON.stringify(actual.messages), /elapsedMs.{0,5}120000/, 'Compaction dropped the earlier metric body; the recorded system prompt must retain it');
  }
  assert.equal(f.events.filter(event => event.type === 'agent.context_compacted').length, 1);
  const store = await ExperimentStore.open(f.result.experimentRoot, f.base.experimentId);
  try {
    const resolveInput = experimentModelInputResolver(store, f.base.runId);
    const replay = await reconstructModelRequests(store.events(), resolveInput);
    assert.equal(replay.diagnostic, undefined);
    assert.equal(replay.requests.at(-1)?.systemPrompt, prompt);
    assert.equal(replay.requests.at(-1)?.contextSource, 'generation_snapshot');
    assert.match(JSON.stringify(replay.requests.at(-1)?.messages), /COMPACTED_SOURCES_WITHOUT_METRICS/);
    assert.equal(replay.requests.at(-1)?.contentComplete, true);
    let corrupted = 0;
    const invalid = await reconstructModelRequests(store.events(), async ref => {
      const text = await resolveInput(ref);
      if (text.includes('Pinned Host metrics:') && text.includes('120000')) {
        corrupted++;
        return text.replace('120000', '120001');
      }
      return text;
    });
    assert.ok(corrupted > 0, 'The inverse must alter actual persisted generation input bytes');
    assert.equal(invalid.diagnostic?.code, 'attachment_checksum');
  } finally { await store.close(); }
});
