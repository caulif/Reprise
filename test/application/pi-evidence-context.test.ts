import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { PiProviderAdapter, type PiModels } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'] = []): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: 'stop', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test('save evidence projection retains every user correction and restores later full transcript', async () => {
  const contexts: Context[] = [];
  const messages = [response([{ type: 'text', text: 'assistant narration '.repeat(1000) }]), response(), response()];
  const models = { streamSimple: (_: unknown, context: Context) => {
    contexts.push(structuredClone(context)); const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: messages.shift()! }); return stream;
  } } as unknown as PiModels;
  const session = new PiProviderAdapter({ models, model, config: { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' } })
    .createSession({ sessionId: 'evidence', systemPrompt: 'test', tools: [] });
  const signal = new AbortController().signal;
  await session.append({ content: 'original task', signal });
  await session.append({ content: 'actual user correction and current findings', contextMode: 'evidence', signal });
  await session.append({ content: 'resume full transcript', signal });
  assert.equal(contexts[1]!.messages.filter(message => message.role === 'user').length, 2);
  assert.ok(JSON.stringify(contexts[1]).includes('actual user correction'));
  assert.ok(!JSON.stringify(contexts[1]).includes('assistant narration'));
  assert.ok(JSON.stringify(contexts[2]).includes('assistant narration'));
  assert.ok(JSON.stringify(contexts[1]).length < JSON.stringify(contexts[2]).length / 10);
});

test('stream observation separates first SDK event from visible text and never records token contents', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const message = response();
  const source = { streamSimple: () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'visible', partial: message });
    stream.push({ type: 'done', reason: 'stop', message }); return stream;
  } } as unknown as PiModels;
  let facts: Record<string, unknown> | undefined;
  const usage = piRequestUsage(source, { onModelStream: async payload => { facts = payload; } });
  const stream = await usage.stream(model, { messages: [] });
  t.mock.timers.tick(20);
  for await (const _event of stream) t.mock.timers.tick(10);
  await usage.flush();
  assert.equal(typeof facts?.requestId, 'string');
  const { requestId: _requestId, ...timing } = facts!;
  assert.deepEqual(timing, { startedAt: 1000, firstEventAt: 1020, firstTextAt: 1030, finishedAt: 1050, events: 3 });
});
