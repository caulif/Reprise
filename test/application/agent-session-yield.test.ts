import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AgentHost, FakeProviderAdapter, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';

test('Host yield waits for idle, records a distinct terminal and resumes the same session', async () => {
  let release!: () => void;
  const idle = new Promise<void>(resolve => { release = resolve; });
  const events: AgentAuditEvent[] = [];
  let turns = 0;
  const host = new AgentHost({ createSession: () => ({
    append: async ({ yieldAfterTurn }) => { turns++; const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : 'resumed'; },
    waitForIdle: () => idle, cancel() {},
  }) });
  const session = await host.createSession({ role: 'comparison', systemPrompt: 'test', audit: { append: async event => { events.push(event); } } });
  let settled = false;
  const first = session.work({ promptContent: 'investigate', timeoutMs: 1_000, yieldAfterTurn: () => 'investigationMs' }).then(result => { settled = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(events.some(event => event.type === 'agent.invocation_yielded'), false);
  release();
  assert.equal((await first).status, 'yielded');
  assert.equal(events.some(event => event.type === 'agent.invocation_completed'), false);
  assert.equal(events.find(event => event.type === 'agent.invocation_yielded')!.payload.reason, 'investigationMs');
  assert.equal((await session.work({ promptContent: 'continue', timeoutMs: 1_000 })).status, 'completed');
  assert.equal(turns, 2);
});

test('external cancel, hard timeout, real provider error and unsupported yield never become yielded', async () => {
  const events: AgentAuditEvent[] = [];
  const errors = new AgentHost({ createSession: () => ({ append: async () => { throw new Error('401 unauthorized'); }, cancel() {} }) });
  const failed = await errors.createSession({ role: 'comparison', systemPrompt: 'test', audit: { append: async event => { events.push(event); } } });
  assert.equal((await failed.work({ promptContent: 'test', timeoutMs: 1_000, yieldAfterTurn: () => 'soft' })).status, 'failed');
  const hung = new AgentHost({ createSession: () => ({ append: async () => ({ status: 'yielded' as const, reason: 'soft' }), waitForIdle: () => new Promise<void>(() => {}), cancel() {} }) });
  const timeout = await hung.createSession({ role: 'comparison', systemPrompt: 'test' });
  const result = await timeout.work({ promptContent: 'test', timeoutMs: 20, yieldAfterTurn: () => 'soft' });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.failure.kind, 'timeout');
  const cancelled = await new AgentHost(new FakeProviderAdapter('done')).createSession({ role: 'comparison', systemPrompt: 'test' });
  assert.equal((await cancelled.work({ promptContent: 'test', timeoutMs: 1_000, signal: AbortSignal.abort(), yieldAfterTurn: () => 'soft' })).status, 'cancelled');
  const unsupported = await new AgentHost({ createSession: () => ({ append: async () => ({ status: 'yielded' as const, reason: 'unexpected' }), cancel() {} }) }).createSession({ role: 'comparison', systemPrompt: 'test' });
  assert.equal((await unsupported.work({ promptContent: 'test', timeoutMs: 1_000 })).status, 'failed');
  assert.equal(events.some(event => event.type === 'agent.invocation_yielded'), false);
});

test('cancellation or timeout during yield audit cannot return a yielded invocation', async () => {
  for (const mode of ['cancel', 'timeout'] as const) {
    const controller = new AbortController();
    const session = await new AgentHost(new FakeProviderAdapter('done')).createSession({ role: 'comparison', systemPrompt: 'test', audit: { append: async event => {
      if (event.type !== 'agent.invocation_yielded') return;
      if (mode === 'cancel') controller.abort();
      else await new Promise<void>(resolve => setTimeout(resolve, 30));
    } } });
    const result = await session.work({ promptContent: 'test', timeoutMs: mode === 'timeout' ? 10 : 1_000, signal: controller.signal, yieldAfterTurn: () => 'soft' });
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
    if (result.status === 'failed') assert.equal(result.failure.kind, 'timeout');
  }
});

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function message(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content'], errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function pi(responses: AssistantMessage[], seen: string[]) {
  const models = { getModel: () => model, streamSimple: (_model: unknown, context: unknown) => {
    seen.push(JSON.stringify(context));
    const next = responses.shift(); if (!next) throw new Error('Unexpected extra generation');
    const stream = createAssistantMessageEventStream();
    if (next.stopReason === 'error' || next.stopReason === 'aborted') stream.push({ type: 'error', reason: next.stopReason, error: next });
    else stream.push({ type: 'done', reason: next.stopReason as 'stop' | 'length' | 'toolUse', message: next });
    return stream;
  } } as unknown as PiModels;
  return new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
}

test('native Pi yield finishes the whole tool batch and preserves its actual results for the next generation', async () => {
  const seen: string[] = []; const writes: string[] = [];
  const session = pi([
    message('toolUse', [{ type: 'toolCall', id: 'a', name: 'write', arguments: { value: 'one' } }, { type: 'toolCall', id: 'b', name: 'write', arguments: { value: 'two' } }]),
    message('stop', [{ type: 'text', text: 'resumed' }]),
  ], seen).createSession({ sessionId: 'yield-native', systemPrompt: 'test', tools: [{ name: 'write', description: 'record', parameters: Type.Object({ value: Type.String() }), execute: async value => {
    const { value: text } = value as { value: string }; writes.push(text); return { content: `saved-${text}` };
  } }] });
  assert.deepEqual(await session.append({ content: 'first', signal: new AbortController().signal, yieldAfterTurn: () => 'soft_budget' }), { status: 'yielded', reason: 'soft_budget' });
  assert.deepEqual(writes, ['one', 'two']); assert.equal(seen.length, 1);
  assert.equal(await session.append({ content: 'second', signal: new AbortController().signal }), 'resumed');
  assert.match(seen[1]!, /saved-one/); assert.match(seen[1]!, /saved-two/);
});

test('native Pi failure or hard policy rejection wins over a requested soft yield', async () => {
  for (const reason of ['error', 'aborted'] as const) {
    const session = pi([message(reason, [], '401 unauthorized')], []).createSession({ sessionId: 'failed-yield', systemPrompt: 'test', tools: [] });
    await assert.rejects(session.append({ content: 'test', signal: new AbortController().signal, yieldAfterTurn: () => 'soft_budget' }), /401 unauthorized/);
  }
  const session = pi([message('stop', [{ type: 'text', text: 'done' }])], []).createSession({ sessionId: 'hard-yield', systemPrompt: 'test', tools: [] });
  await assert.rejects(session.append({ content: 'test', signal: new AbortController().signal, yieldAfterTurn: () => { throw new Error('Comparison resource limit: maxElapsedMs'); } }), /maxElapsedMs/);
});
