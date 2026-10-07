import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { PiProviderAdapter } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { invocationYieldDeadline } from '../../src/infrastructure/agent/providers/pi/yield-deadline.js';
import { AgentInvocationStartedSchema } from '../../src/core/schema.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';
import { Agent } from '@earendil-works/pi-agent-core';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config = { schemaVersion: 2 as const, provider: { kind: 'pi-catalog' as const, id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' as const };
const reason = 'bounded_source_timeout';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function message(stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, content: stopReason === 'stop' ? [{ type: 'text', text: 'Done' }] : [], stopReason,
    ...(errorMessage ? { errorMessage } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function emit(stream: ReturnType<typeof createAssistantMessageEventStream>, terminal: AssistantMessage) {
  stream.push(terminal.stopReason === 'error' || terminal.stopReason === 'aborted'
    ? { type: 'error', reason: terminal.stopReason, error: terminal }
    : { type: 'done', reason: terminal.stopReason as 'stop' | 'toolUse', message: terminal });
}

test('native deadline-only Host call yields after actual usage drain, records control and reuses the same idle session', async () => {
  const aborted = deferred(), draining = deferred(), release = deferred();
  const events: AgentAuditEvent[] = [], contexts: Context[] = [];
  let calls = 0, settled = false;
  const models = { getModel: () => model, streamSimple: (_: unknown, context: Context, options: { signal: AbortSignal }) => {
    calls++; contexts.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    if (calls === 1) options.signal.addEventListener('abort', () => { aborted.resolve(); emit(stream, message('aborted')); }, { once: true });
    else emit(stream, message());
    return stream;
  } } as unknown as PiModels;
  const session = await new AgentHost(new PiModelCaller(config, models)).createSession({ role: 'comparison', systemPrompt: 'Test', audit: { append: async event => {
    events.push(event);
    if (event.type === 'agent.usage_reported' && calls === 1) { draining.resolve(); await release.promise; }
  } } });
  const yieldDeadline = { at: Date.now() + 40, reason };
  const work = session.work({ promptContent: 'Inspect sources', timeoutMs: 2_000, yieldDeadline }).then(result => { settled = true; return result; });
  await aborted.promise; await draining.promise;
  assert.equal(settled, false, 'an abort signal is not idle plus audited usage');
  assert.equal((await session.work({ promptContent: 'Too early', timeoutMs: 1_000 })).status, 'failed');
  assert.equal(calls, 1, 'no next generation during drain');
  release.resolve();
  const result = await work;
  assert.equal(result.status, 'yielded'); if (result.status === 'yielded') assert.equal(result.reason, reason);
  assert.deepEqual(events.find(event => event.type === 'agent.invocation_started')!.payload.yieldDeadline, yieldDeadline);
  assert.equal(events.filter(event => event.type === 'agent.invocation_yielded').length, 1);
  assert.equal(events.filter(event => event.type === 'agent.invocation_completed').length, 0);
  assert.equal((await session.work({ promptContent: 'Audit draft: source investigation was interrupted with no assessment', timeoutMs: 1_000 })).status, 'completed');
  assert.equal(calls, 2); assert.equal(events.filter(event => event.type === 'agent.session_started').length, 1);
  assert.ok(JSON.stringify(contexts[1]).includes('Inspect sources'), 'independent source transcript remains in the same review session');
});

for (const mode of ['user_cancel', 'global_timeout', 'provider_error', 'audit_error'] as const) test(`native local deadline cannot hide ${mode}`, async () => {
  const aborted = deferred(), draining = deferred(), release = deferred();
  const controller = new AbortController();
  let calls = 0;
  const events: AgentAuditEvent[] = [];
  const models = { getModel: () => model, streamSimple: (_: unknown, _context: unknown, options: { signal: AbortSignal }) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener('abort', () => { aborted.resolve(); emit(stream, message(mode === 'provider_error' ? 'error' : 'aborted', mode === 'provider_error' ? '401 unauthorized during local abort' : undefined)); }, { once: true });
    return stream;
  } } as unknown as PiModels;
  const session = await new AgentHost(new PiModelCaller(config, models)).createSession({ role: 'comparison', systemPrompt: 'Test', audit: { append: async event => {
    events.push(event);
    if (event.type === 'agent.usage_reported') {
      draining.resolve();
      if (mode === 'user_cancel' || mode === 'global_timeout') await release.promise;
      if (mode === 'audit_error') throw new Error('audit persistence failed');
    }
  } } });
  const work = session.work({ promptContent: 'Sources', timeoutMs: mode === 'global_timeout' ? 80 : 1_000, signal: controller.signal, yieldDeadline: { at: Date.now() + 30, reason } });
  await aborted.promise; await draining.promise;
  if (mode === 'user_cancel') controller.abort();
  const result = await work;
  release.resolve();
  assert.equal(result.status, mode === 'user_cancel' ? 'cancelled' : 'failed');
  if (result.status === 'failed') {
    assert.match(result.failure.message, mode === 'provider_error' ? /401 unauthorized/ : mode === 'audit_error' ? /audit persistence/ : /timeout/);
  }
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'agent.invocation_yielded'), false);
});

test('native deadline during model-input audit prevents upstream and leaves selected tools reusable', async () => {
  let calls = 0, writes = 0, first = true;
  const models = { getModel: () => model, streamSimple: () => { calls++; const stream = createAssistantMessageEventStream(); emit(stream, message()); return stream; } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [
    { name: 'write', description: 'Write', parameters: Type.Object({}), execute: async () => { writes++; return { content: 'Written' }; } },
  ], onModelRequest: async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 40)); } } });
  const result = await provider.append({ content: 'Sources', signal: new AbortController().signal, allowedToolNames: [], yieldDeadline: { at: Date.now() + 20, reason } });
  assert.deepEqual(result, { status: 'yielded', reason });
  assert.equal(calls, 0); assert.equal(writes, 0);
  assert.equal(await provider.append({ content: 'Draft', signal: new AbortController().signal }), 'Done');
  assert.equal(calls, 1);
});

test('native raw tool failure remains fatal when the local timer also expires', async () => {
  let calls = 0, effects = 0;
  const models = { getModel: () => model, streamSimple: () => {
    calls++; const stream = createAssistantMessageEventStream(); const terminal = message('toolUse');
    terminal.content = [{ type: 'toolCall', id: 'check', name: 'check', arguments: {} }]; emit(stream, terminal); return stream;
  } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [
    { name: 'check', description: 'Check', parameters: Type.Object({}), execute: async () => { effects++; await new Promise(resolve => setTimeout(resolve, 40)); throw new Error('Actual tool failure'); } },
  ] });
  await assert.rejects(provider.append({ content: 'Sources', signal: new AbortController().signal, yieldDeadline: { at: Date.now() + 20, reason } }), /Actual tool failure/);
  assert.equal(effects, 1); assert.equal(calls, 1);
});

test('expired deadline does not send a request; normal safe-turn yield clears its timer', async () => {
  let calls = 0;
  const models = { getModel: () => model, streamSimple: () => { calls++; const stream = createAssistantMessageEventStream(); emit(stream, message()); return stream; } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [] });
  assert.deepEqual(await provider.append({ content: 'Expired', signal: new AbortController().signal, yieldDeadline: { at: 0, reason } }), { status: 'yielded', reason });
  assert.equal(calls, 0);
  assert.deepEqual(await provider.append({ content: 'Normal yield', signal: new AbortController().signal, yieldAfterTurn: () => 'reviewMs', yieldDeadline: { at: Date.now() + 20, reason } }), { status: 'yielded', reason: 'reviewMs' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await provider.append({ content: 'Draft', signal: new AbortController().signal }), 'Done');
  assert.equal(calls, 2);
});

test('deadline control schema rejects malformed persisted control; unknown failures are not known local aborts', () => {
  assert.equal(Value.Check(AgentInvocationStartedSchema, { invocationId: 'legacy-record' }), true);
  assert.equal(Value.Check(AgentInvocationStartedSchema, { invocationId: 'new-record', yieldDeadline: { at: 1, reason } }), true);
  for (const invalid of [{ at: -1, reason }, { at: 1.5, reason }, { at: 1, reason: '' }, { at: 1, reason, extra: true }]) assert.equal(Value.Check(AgentInvocationStartedSchema, { invocationId: 'external-record', yieldDeadline: invalid }), false);
  const deadline = invocationYieldDeadline({ abort() {} }, new AbortController().signal, { at: 0, reason });
  deadline.recordFailure(new Error('401 raw error hidden by SDK aborted response'));
  assert.throws(() => deadline.reason(), /401 raw error/);
  deadline.dispose();
});

test('failure to persist invocation control prevents any native upstream request', async () => {
  let calls = 0;
  const models = { getModel: () => model, streamSimple: () => { calls++; throw new Error('Must not send'); } } as unknown as PiModels;
  const session = await new AgentHost(new PiModelCaller(config, models)).createSession({ role: 'comparison', systemPrompt: 'Test', audit: { append: async event => {
    if (event.type === 'agent.invocation_started') throw new Error('audit control persistence failed');
  } } });
  const result = await session.work({ promptContent: 'Sources', timeoutMs: 1_000, yieldDeadline: { at: Date.now() + 20, reason } });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.failure.code, 'audit_failure');
  assert.equal(calls, 0);
});

test('far-future absolute deadlines do not overflow the Node timer into immediate cancellation', async () => {
  let aborts = 0;
  const deadline = invocationYieldDeadline({ abort() { aborts++; } }, new AbortController().signal, { at: Date.now() + 2_147_483_648, reason });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborts, 0); assert.equal(deadline.reason(), undefined);
  deadline.dispose();
});

test('an independent upstream AbortError racing with a local timer remains fatal', () => {
  const active = new AbortController();
  const deadline = invocationYieldDeadline({ signal: active.signal, abort() { active.abort(); } }, new AbortController().signal, { at: 0, reason });
  const independent = new Error('Independent upstream AbortError'); independent.name = 'AbortError';
  deadline.recordFailure(independent);
  assert.throws(() => deadline.reason(), /Independent upstream/);
  deadline.dispose();
});

test('only this invocation signal reason and its explicit wrapped cause are recognized as local cancellation', () => {
  const active = new AbortController();
  const deadline = invocationYieldDeadline({ signal: active.signal, abort() { active.abort(); } }, new AbortController().signal, { at: 0, reason });
  deadline.recordFailure(new Error('Wrapped SDK cancellation', { cause: active.signal.reason }));
  assert.equal(deadline.reason(), reason);
  deadline.dispose();
});

test('an independent terminal aborted before the local signal cannot become a deadline yield during usage drain', async t => {
  const entered = deferred(), release = deferred();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock calls this saved method with its actual Agent instance below.
  const originalAbort = Agent.prototype.abort;
  const abort = t.mock.method(Agent.prototype, 'abort', function (this: Agent) { originalAbort.call(this); });
  let calls = 0;
  const models = { getModel: () => model, streamSimple: (_: unknown, _context: unknown, options: { signal: AbortSignal }) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    const stream = createAssistantMessageEventStream(); emit(stream, message('aborted', 'Independent terminal aborted')); return stream;
  } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [], onModelUsage: async () => { entered.resolve(); await release.promise; } });
  const work = provider.append({ content: 'Sources', signal: new AbortController().signal, yieldDeadline: { at: Date.now() + 30, reason } });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(abort.mock.callCount(), 1, 'the local timer actually fired even though the finished SDK run has already cleared its active signal');
  release.resolve();
  await assert.rejects(work, /Independent terminal aborted/);
  assert.equal(calls, 1);
});

test('visible assistant audit errors remain fatal when its awaited listener crosses the local deadline', async () => {
  let calls = 0, visibleCalls = 0;
  const models = { getModel: () => model, streamSimple: () => { calls++; const stream = createAssistantMessageEventStream(); emit(stream, message()); return stream; } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [], onAssistantVisible: async () => {
    visibleCalls++; await new Promise(resolve => setTimeout(resolve, 40)); throw new Error('audit visible text failed');
  } });
  await assert.rejects(provider.append({ content: 'Sources', signal: new AbortController().signal, yieldDeadline: { at: Date.now() + 20, reason } }), /audit visible text failed/);
  assert.equal(visibleCalls, 1); assert.equal(calls, 1);
});

for (const mode of ['tool', 'before_hook', 'after_hook'] as const) test(`synchronous ${mode} error is recorded before SDK catches it and the timer expires`, async () => {
  let calls = 0, effects = 0, failures = 0;
  const models = { getModel: () => model, streamSimple: () => {
    calls++; const stream = createAssistantMessageEventStream(), terminal = message('toolUse');
    terminal.content = [{ type: 'toolCall', id: 'check', name: 'check', arguments: {} }]; emit(stream, terminal); return stream;
  } } as unknown as PiModels;
  const fail = () => { failures++; throw new Error(`Synchronous ${mode} failure`); };
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [
    { name: 'check', description: 'Check', parameters: Type.Object({}), execute: () => { effects++; if (mode === 'tool') fail(); return Promise.resolve({ content: 'Checked' }); } },
  ], ...(mode === 'before_hook' ? { onBeforeToolCall: fail } : {}), ...(mode === 'after_hook' ? { onAfterToolCall: fail } : {}) });
  await assert.rejects(provider.append({ content: 'Sources', signal: new AbortController().signal, yieldDeadline: { at: Date.now() + 20, reason },
    yieldAfterTurn: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return undefined; },
  }), new RegExp(`Synchronous ${mode} failure`));
  assert.equal(failures, 1); assert.equal(effects, mode === 'before_hook' ? 0 : 1); assert.equal(calls, 1);
});

test('synchronous compaction completion throw is observed without an asynchronous rejection', async () => {
  const deadline = invocationYieldDeadline({ abort() {} }, new AbortController().signal, { at: 0, reason });
  let calls = 0;
  const usage = piRequestUsage({ completeSimple: () => { calls++; throw new Error('Synchronous compaction upstream failed'); } } as unknown as PiModels, {}, error => deadline.recordFailure(error));
  await assert.rejects(usage.models.completeSimple(model, { messages: [] }, { signal: new AbortController().signal }), /Synchronous compaction upstream failed/);
  assert.throws(() => deadline.reason(), /Synchronous compaction upstream failed/);
  assert.equal(calls, 1); deadline.dispose();
});
