import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { PiModelCaller, type PiModels } from '../src/infrastructure/pi-model-caller.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content'], errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function caller(responses: AssistantMessage[], seen: string[], summarize?: () => AssistantMessage) {
  const models = {
    getModel: () => model,
    streamSimple: (_model: unknown, context: unknown, options: { maxRetries?: number }) => {
      assert.equal(options.maxRetries, 0);
      seen.push(JSON.stringify(context));
      const message = responses.shift();
      if (!message) throw new Error('Unexpected extra request.');
      const stream = createAssistantMessageEventStream();
      if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
      else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
      return stream;
    },
    completeSimple: () => { if (summarize) return summarize(); throw new Error('Unexpected summary request.'); },
  } as unknown as PiModels;
  return new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
}

test('transient continuation keeps tool results and never repeats the prompt or side effects', async () => {
  const seen: string[] = [];
  const retries: number[] = [];
  let writes = 0;
  const session = caller([
    response('toolUse', [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }]),
    response('error', [], 'Upstream request failed'),
    response('error', [], 'fetch failed'),
    response('stop', [{ type: 'text', text: '{"ok":true}' }]),
  ], seen).createSession({
    sessionId: 'retry-test', systemPrompt: 'test',
    tools: [{ name: 'write', description: 'write once', parameters: Type.Object({}), execute: async () => { writes += 1; return { content: 'saved-once' }; } }],
    onRetry: async ({ attempt }) => { retries.push(attempt); },
  });
  assert.equal(await session.append({ content: 'one-prompt', signal: new AbortController().signal }), '{"ok":true}');
  assert.equal(writes, 1);
  assert.deepEqual(retries, [2, 3]);
  assert.equal(seen.length, 4);
  for (const context of seen.slice(1)) {
    assert.match(context, /saved-once/);
    assert.equal(context.split('one-prompt').length - 1, 1);
  }
});

test('persistent upstream failure has three attempts while authentication never retries', async () => {
  for (const [message, count] of [['Upstream request failed', 3], ['401 unauthorized', 1]] as const) {
    const seen: string[] = [];
    const session = caller(Array.from({ length: count }, () => response('error', [], message)), seen).createSession({ sessionId: 'fail-test', systemPrompt: 'test', tools: [] });
    await assert.rejects(session.append({ content: 'test', signal: new AbortController().signal }), new RegExp(message));
    assert.equal(seen.length, count);
  }
});

test('cancellation during backoff stops before another provider request', async () => {
  const abort = new AbortController();
  const seen: string[] = [];
  const session = caller([response('error', [], 'Upstream request failed')], seen).createSession({ sessionId: 'cancel-test', systemPrompt: 'test', tools: [], onRetry: async () => { abort.abort(); } });
  await assert.rejects(session.append({ content: 'test', signal: abort.signal }));
  assert.equal(seen.length, 1);
});

test('oversized first input fails before the provider or a doomed summary request', async () => {
  const seen: string[] = [];
  const session = caller([], seen).createSession({ sessionId: 'budget-test', systemPrompt: 'test', tools: [] });
  await assert.rejects(session.append({ content: 'x'.repeat(1_000_000), signal: new AbortController().signal }), /Context budget/);
  assert.equal(seen.length, 0);
});

test('fixed prompt and tool definitions reserve output space before calling the provider', async () => {
  for (const largeTool of [false, true]) {
    const seen: string[] = [];
    const session = caller([], seen).createSession({ sessionId: 'fixed-budget', systemPrompt: largeTool ? 'test' : 'x'.repeat(340_000), tools: largeTool ? [{ name: 'read', description: 'x'.repeat(340_000), parameters: Type.Object({}), execute: async () => ({ content: 'unused' }) }] : [] });
    await assert.rejects(session.append({ content: 'go', signal: new AbortController().signal }), /system prompt, tools and output reserve exceed/);
    assert.equal(seen.length, 0);
  }
});

test('overflow without reducible history fails without retrying the same input', async () => {
  const seen: string[] = [];
  const session = caller([response('error', [], '400 context_length_exceeded: Your input exceeds the context window of this model.')], seen).createSession({ sessionId: 'overflow-no-history', systemPrompt: 'test', tools: [] });
  await assert.rejects(session.append({ content: 'go', signal: new AbortController().signal }), /overflow recovery could not reduce the input/);
  assert.equal(seen.length, 1);
});

for (const overflow of [false, true]) test(`${overflow ? 'overflow recovery' : 'request-time compaction'} persists summary plus tool tail across subsequent appends`, async () => {
  const seen: string[] = [];
  const responses = Array.from({ length: 16 }, (_, index) => {
    const message = response('toolUse', [{ type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { index } }]);
    if (index === 15 && !overflow) { message.usage.input = 110_000; message.usage.totalTokens = 110_010; }
    return message;
  });
  if (overflow) responses.push(response('error', [], '400 context_length_exceeded: Your input exceeds the context window of this model.'));
  responses.push(response('stop', [{ type: 'text', text: 'done' }]), response('stop', [{ type: 'text', text: 'continued' }]));
  let reads = 0;
  let summaries = 0;
  const audits: { summary: string; retainedCount: number }[] = [];
  const session = caller(responses, seen, () => {
    summaries += 1;
    return response('stop', [{ type: 'text', text: 'COMPACTED_EVIDENCE' }]);
  }).createSession({ sessionId: 'compaction-test', systemPrompt: 'Inspect evidence.',
    tools: [{ name: 'read', description: 'Read evidence.', parameters: Type.Object({ index: Type.Integer() }), execute: async (params) => {
      reads += 1;
      return { content: `evidence-${(params as { index: number }).index}: ${'x'.repeat(10_000)}` };
    } }],
    onContextCompact: async (audit) => { audits.push(audit); },
  });
  assert.equal(await session.append({ content: 'Start.', signal: new AbortController().signal }), 'done');
  assert.equal(await session.append({ content: 'Continue.', signal: new AbortController().signal }), 'continued');
  assert.equal(reads, 16);
  assert.equal(summaries, 1);
  assert.equal(audits.length, 1);
  assert.ok(audits[0]!.retainedCount > 0);
  for (const context of seen.slice(-2)) {
    assert.match(context, /COMPACTED_EVIDENCE/);
    assert.match(context, /evidence-15:/);
    assert.doesNotMatch(context, /evidence-0:/);
  }
});
