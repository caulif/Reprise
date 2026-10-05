import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { PiProviderAdapter } from '../../src/infrastructure/agent/providers/pi/adapter.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config = { schemaVersion: 2 as const, provider: { kind: 'pi-catalog' as const, id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' as const };
function message(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content'], errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
    usage: { input: 1, output: 16_384, cacheRead: 0, cacheWrite: 0, totalTokens: 16_385, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function models(responses: AssistantMessage[], contexts: string[]): PiModels {
  return { getModel: () => model, streamSimple: (_model: unknown, context: unknown) => {
    contexts.push(JSON.stringify(context));
    const response = responses.shift(); if (!response) throw new Error('Unexpected automatic continuation after output truncation');
    const stream = createAssistantMessageEventStream();
    if (response.stopReason === 'error' || response.stopReason === 'aborted') stream.push({ type: 'error', reason: response.stopReason, error: response });
    else stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'length' | 'toolUse', message: response });
    return stream;
  } } as unknown as PiModels;
}

for (const surface of ['thinking', 'visible'] as const) test(`native ${surface} output truncation yields without certifying completed-turn readiness`, async () => {
  const events: AgentAuditEvent[] = [], contexts: string[] = [];
  let readyPolicies = 0;
  const content: AssistantMessage['content'] = surface === 'thinking' ? [{ type: 'thinking', thinking: 'Unfinished private reasoning' }] : [{ type: 'text', text: 'Unfinished visible answer' }];
  const session = await new AgentHost(new PiModelCaller(config, models([message('length', content)], contexts))).createSession({ role: 'comparison', systemPrompt: 'Test', audit: { append: async event => { events.push(event); } } });
  const result = await session.work({ promptContent: 'Audit the actual current draft', timeoutMs: 1_000, yieldAfterTurn: () => { readyPolicies++; return 'final_inspection_ready'; } });
  assert.equal(result.status, 'yielded'); if (result.status === 'yielded') assert.equal(result.reason, 'output_limit');
  assert.equal(readyPolicies, 0, 'a truncated terminal cannot invoke completion or formal-inspection certification');
  assert.equal(contexts.length, 1); assert.equal(events.filter(event => event.type === 'agent.usage_reported').length, 1);
  assert.equal(events.filter(event => event.type === 'agent.invocation_completed').length, 0);
  assert.equal(events.find(event => event.type === 'agent.invocation_yielded')!.payload.reason, 'output_limit');
});

test('length after executed tools preserves results, rejects truncated calls and does not replay effects', async () => {
  const contexts: string[] = [];
  let effects = 0, policies = 0;
  const responses = [message('toolUse', [{ type: 'toolCall', id: 'saved', name: 'save', arguments: {} }]),
    message('length', [{ type: 'toolCall', id: 'truncated', name: 'save', arguments: {} }]), message('stop', [{ type: 'text', text: 'Explicit continuation completed' }])];
  const session = new PiModelCaller(config, models(responses, contexts)).createSession({ sessionId: 'tools', systemPrompt: 'Test', tools: [
    { name: 'save', description: 'Save once', parameters: Type.Object({}), execute: async () => { effects++; return { content: 'Actual saved-once result' }; } },
  ] });
  assert.deepEqual(await session.append({ content: 'Original audit prompt', signal: new AbortController().signal, yieldAfterTurn: () => { policies++; return undefined; } }), { status: 'yielded', reason: 'output_limit' });
  assert.equal(effects, 1, 'SDK must reject every tool call in the truncated message'); assert.equal(policies, 1, 'only the earlier complete tool turn invokes completion policy');
  assert.equal(contexts.length, 2, 'output truncation cannot autonomously request another generation');
  assert.equal(await session.append({ content: 'Explicit continuation', signal: new AbortController().signal }), 'Explicit continuation completed');
  assert.equal(effects, 1); assert.equal(contexts.length, 3); assert.match(contexts[2]!, /Actual saved-once result/);
  assert.equal(contexts[2]!.split('Original audit prompt').length - 1, 1);
});

for (const mode of ['yield', 'cancel', 'audit_error', 'local_deadline'] as const) test(`length waits for usage drain and preserves ${mode} priority`, async () => {
  let entered!: () => void, release!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const contexts: string[] = [], controller = new AbortController();
  let settled = false, policies = 0;
  const provider = new PiProviderAdapter({ models: models([message('length', [{ type: 'text', text: 'Truncated' }])], contexts), model, config }).createSession({
    sessionId: 'drain', systemPrompt: 'Test', tools: [], onModelUsage: async () => { entered(); await released; if (mode === 'audit_error') throw new Error('Actual usage audit failure'); },
  });
  const work = provider.append({ content: 'Audit', signal: controller.signal, yieldAfterTurn: () => { policies++; return 'final_inspection_ready'; },
    ...(mode === 'local_deadline' ? { yieldDeadline: { at: Date.now() + 20, reason: 'bounded_source_timeout' } } : {}) }).finally(() => { settled = true; });
  await draining;
  assert.equal(settled, false); assert.equal(contexts.length, 1); assert.equal(policies, 0);
  if (mode === 'cancel') controller.abort();
  if (mode === 'local_deadline') await new Promise(resolve => setTimeout(resolve, 40));
  release();
  if (mode === 'cancel') await assert.rejects(work);
  else if (mode === 'audit_error') await assert.rejects(work, /Actual usage audit failure/);
  else assert.deepEqual(await work, { status: 'yielded', reason: mode === 'local_deadline' ? 'bounded_source_timeout' : 'output_limit' });
  assert.equal(policies, 0);
});

test('error and aborted terminals never become output-limit or certification yields', async () => {
  for (const stopReason of ['error', 'aborted'] as const) {
    const contexts: string[] = []; let policies = 0;
    const provider = new PiProviderAdapter({ models: models([message(stopReason, [], '401 unauthorized')], contexts), model, config }).createSession({ sessionId: 'error', systemPrompt: 'Test', tools: [] });
    await assert.rejects(provider.append({ content: 'Audit', signal: new AbortController().signal, yieldAfterTurn: () => { policies++; return 'final_inspection_ready'; } }), /401 unauthorized/);
    assert.equal(policies, 0); assert.equal(contexts.length, 1);
  }
});

test('transient recovery ending in length cannot hide the latched upstream failure or certify completion', async () => {
  const contexts: string[] = []; let policies = 0;
  const provider = new PiProviderAdapter({ models: models([message('error', [], 'Upstream request failed'), message('length', [{ type: 'text', text: 'Truncated recovery' }])], contexts), model, config }).createSession({ sessionId: 'recovery', systemPrompt: 'Test', tools: [] });
  await assert.rejects(provider.append({ content: 'Audit', signal: new AbortController().signal, yieldAfterTurn: () => { policies++; return 'final_inspection_ready'; } }), /Upstream request failed/);
  assert.equal(policies, 0); assert.equal(contexts.length, 2);
});

for (const mode of ['before_hook', 'after_hook', 'execute', 'visible'] as const) test(`native ${mode} failure cannot be hidden by a length yield without an expired deadline`, async () => {
  const contexts: string[] = [];
  const fail = () => { throw new Error(`Actual ${mode} audit or execution failure`); };
  const truncated = message('length', [{ type: 'text', text: 'Truncated audit response' }]);
  const responses = mode === 'visible' ? [truncated] : [message('toolUse', [{ type: 'toolCall', id: 'check', name: 'check', arguments: {} }]), truncated];
  const provider = new PiProviderAdapter({ models: models(responses, contexts), model, config }).createSession({ sessionId: 'latched-error', systemPrompt: 'Test', tools: [
    { name: 'check', description: 'Check', parameters: Type.Object({}), execute: async () => { if (mode === 'execute') fail(); return { content: 'Actual tool result' }; } },
  ],
    ...(mode === 'before_hook' ? { onBeforeToolCall: async () => { fail(); } } : {}),
    ...(mode === 'after_hook' ? { onAfterToolCall: async () => { fail(); } } : {}),
    ...(mode === 'visible' ? { onAssistantVisible: async () => { fail(); } } : {}),
  });
  await assert.rejects(provider.append({ content: 'Audit', signal: new AbortController().signal, yieldAfterTurn: () => undefined }), new RegExp(`Actual ${mode} audit or execution failure`));
  assert.equal(contexts.length, mode === 'visible' ? 1 : 2, 'latched SDK error survives through actual length terminal, with no consumer continuation');
});

test('latched recoverable tool errors do not change ordinary completed invocation semantics', async () => {
  const contexts: string[] = [];
  const provider = new PiProviderAdapter({ models: models([
    message('toolUse', [{ type: 'toolCall', id: 'check', name: 'check', arguments: {} }]),
    message('stop', [{ type: 'text', text: 'Completed with handled tool failure' }]),
  ], contexts), model, config }).createSession({ sessionId: 'handled-tool', systemPrompt: 'Test', tools: [
    { name: 'check', description: 'Check', parameters: Type.Object({}), execute: async () => { throw new Error('Recoverable check error'); } },
  ] });
  assert.equal(await provider.append({ content: 'Handle check failure', signal: new AbortController().signal, yieldAfterTurn: () => undefined }), 'Completed with handled tool failure');
  assert.equal(contexts.length, 2);
});

test('plain and structured callers without completion-yield opt-in retain existing length behavior', async () => {
  const contexts: string[] = [];
  const caller = new PiModelCaller(config, models([message('length', [{ type: 'text', text: 'Legacy partial text' }]), message('length', [{ type: 'text', text: '{"ok":true}' }])], contexts));
  const plain = caller.createSession({ sessionId: 'plain', systemPrompt: 'Test', tools: [] });
  assert.equal(await plain.append({ content: 'Plain', signal: new AbortController().signal }), 'Legacy partial text');
  const result = await new AgentHost(caller).request({ role: 'comparison', systemPrompt: 'Test', allowModelText: true, promptContent: 'Structured', schema: Type.Object({ ok: Type.Boolean() }), timeoutMs: 1_000, maxRepairAttempts: 0 });
  assert.equal(result.status, 'completed'); if (result.status === 'completed') assert.deepEqual(result.value, { ok: true });
  assert.equal(contexts.length, 2);
});
