import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { PiProviderAdapter, type PiModels } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';
import { summarizeComparisonEvaluationUsage } from '../../src/application/comparison-evaluation-usage.js';
import type { EventEnvelope } from '../../src/core/schema.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function fixture(messages: AssistantMessage[], summaries: string[] = []) {
  const models = {
    getModel: () => model,
    streamSimple: () => {
      const message = messages.shift();
      if (!message) throw new Error('Unexpected request');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      return stream;
    },
    completeSimple: async () => { summaries.push('called'); return response('stop', [{ type: 'text', text: 'Summary' }]); },
    getProviders: () => [], getModels: () => [], getAuth: () => undefined,
  } as unknown as PiModels;
  return { models, adapter: new PiProviderAdapter({ models, model, config: { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' } }) };
}

test('compaction requests obey the same pre-call guard, including usage from preceding generation', async () => {
  const summaries: string[] = [];
  const order: string[] = [];
  const { models } = fixture([response('stop', [])], summaries);
  let cost = 0;
  const usage = piRequestUsage(models, {
    onModelRequest: async ({ scope }) => { order.push(scope!); if (cost > 0) throw new Error('Cost limit'); },
    onModelUsage: async () => { await Promise.resolve(); cost++; order.push('usage'); },
  });
  await usage.stream(model, { messages: [] });
  await assert.rejects(usage.models.completeSimple(model, { messages: [] }), /Cost limit/);
  assert.deepEqual(order, ['generation', 'usage', 'compaction']);
  assert.deepEqual(summaries, []);
  await usage.flush();
});

test('a failed compaction usage audit cannot trigger another billed summary', async () => {
  const summaries: string[] = [];
  const { models } = fixture([], summaries);
  const usage = piRequestUsage(models, { onModelUsage: async () => { throw new Error('Compaction audit failed'); } });
  await assert.rejects(usage.models.completeSimple(model, { messages: [] }), /Compaction audit failed/);
  await assert.rejects(usage.models.completeSimple(model, { messages: [] }), /Compaction audit failed/);
  assert.equal(summaries.length, 1);
  await assert.rejects(usage.flush(), /Compaction audit failed/);
});

test('compaction disables provider retries while preserving caller options', async () => {
  const { models } = fixture([]);
  let received: Parameters<PiModels['completeSimple']>[2];
  models.completeSimple = async (_model, _context, options) => {
    received = options;
    throw new Error('Provider failed');
  };
  let audits = 0;
  const usage = piRequestUsage(models, { onModelRequest: async () => { audits++; } });
  const abort = new AbortController();
  await assert.rejects(usage.models.completeSimple(model, { messages: [] }, { maxRetries: 5, maxRetryDelayMs: 60_000, signal: abort.signal, maxTokens: 100 }), /Provider failed/);
  assert.equal(received?.maxRetries, 0);
  assert.equal(received?.maxRetryDelayMs, 8_000);
  assert.equal(received?.signal, abort.signal);
  assert.equal(received?.maxTokens, 100);
  assert.equal(audits, 1);
});

test('failed or aborted SDK placeholder zeros leave both generation and compaction usage/cost unknown', async () => {
  for (const stopReason of ['error', 'aborted'] as const) {
    const failed = response(stopReason, []);
    failed.usage = { ...failed.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const { models } = fixture([failed]);
    models.completeSimple = async () => failed;
    const events: EventEnvelope[] = [];
    let index = 0;
    const append = (type: string, payload: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: events.length + 1,
      eventId: `event-${events.length + 1}`, occurredAt: '2026-10-05T00:00:00.000Z', type, payload, checksum: 'a'.repeat(64) });
    const usage = piRequestUsage(models, {
      onModelRequest: async payload => { index++; append('agent.model_request', { ...payload, sessionId: 's', invocationId: 'i', requestIndex: index }); },
      onModelUsage: async payload => { append('agent.usage_reported', { ...payload, sessionId: 's', invocationId: 'i', requestIndex: index }); },
    });
    await usage.stream(model, { messages: [] });
    await usage.flush();
    await usage.models.completeSimple(model, { messages: [] });
    assert.equal(events.filter(event => event.type === 'agent.model_request').length, 2);
    assert.equal(events.filter(event => event.type === 'agent.usage_reported').length, 0);
    const summary = summarizeComparisonEvaluationUsage(events, undefined, { fixture: { input: 2, output: 2, cacheRead: 0, cacheCreation: 0 } });
    assert.equal(summary.usageCoverage, 'missing');
    assert.equal(summary.estimatedCostUsd, undefined);
    assert.equal(summary.knownEstimatedCostUsd, undefined);
  }
});

test('an error response with actual nonzero usage still records its observed tokens', async () => {
  const { models } = fixture([response('error', [])]);
  models.completeSimple = async () => response('error', []);
  let reported = 0;
  const usage = piRequestUsage(models, { onModelUsage: async ({ usage: facts }) => { reported += facts.totalTokens; } });
  await usage.stream(model, { messages: [] });
  await usage.flush();
  await usage.models.completeSimple(model, { messages: [] });
  assert.equal(reported, 40);
});

test('a successful explicit zero-token response is retained rather than treated as a failed placeholder', async () => {
  const success = response('stop', []);
  success.usage = { ...success.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const { models } = fixture([success]);
  models.completeSimple = async () => success;
  const observed: number[] = [];
  const usage = piRequestUsage(models, { onModelUsage: async ({ usage: facts }) => { observed.push(facts.totalTokens); } });
  await usage.stream(model, { messages: [] });
  await usage.flush();
  await usage.models.completeSimple(model, { messages: [] });
  assert.deepEqual(observed, [0, 0]);
});

test('generation usage is drained before tools and compaction usage is awaited', async () => {
  const order: string[] = [];
  const { adapter, models } = fixture([
    response('toolUse', [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }]),
    response('stop', [{ type: 'text', text: 'Done' }]),
  ]);
  const session = adapter.createSession({ sessionId: 'usage-order', systemPrompt: 'test', tools: [
    { name: 'write', description: 'write', parameters: Type.Object({}), execute: async () => { order.push('tool'); return { content: 'saved' }; } },
  ], onModelUsage: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push('usage'); } });
  assert.equal(await session.append({ content: 'go', signal: new AbortController().signal }), 'Done');
  assert.deepEqual(order, ['usage', 'tool', 'usage']);
  const usage = piRequestUsage(models, { onModelUsage: async ({ scope }) => { await Promise.resolve(); order.push(scope); } });
  await usage.models.completeSimple(model, { messages: [] });
  assert.equal(order.at(-1), 'compaction');
});

test('usage persistence failure prevents tools and cannot be silently swallowed', async () => {
  let writes = 0;
  const { adapter } = fixture([response('toolUse', [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }])]);
  const session = adapter.createSession({ sessionId: 'usage-failure', systemPrompt: 'test', tools: [
    { name: 'write', description: 'write', parameters: Type.Object({}), execute: async () => { writes++; return { content: 'saved' }; } },
  ], onModelUsage: async () => { throw new Error('Usage store failed'); } });
  await assert.rejects(session.append({ content: 'go', signal: new AbortController().signal }), /Usage store failed/);
  assert.equal(writes, 0);
  await assert.rejects(session.waitForIdle!(), /Usage store failed/);
});

test('cancelled append waits for pending usage auditing before it settles', async () => {
  const abort = new AbortController();
  let audited = false;
  const { adapter } = fixture([response('stop', [{ type: 'text', text: 'Done' }])]);
  const session = adapter.createSession({ sessionId: 'usage-cancel', systemPrompt: 'test', tools: [], onModelUsage: async () => {
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    audited = true;
  } });
  await assert.rejects(session.append({ content: 'go', signal: abort.signal }));
  assert.equal(audited, true);
  session.cancel();
  await session.waitForIdle!();
});
