import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { PiProviderAdapter } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { sha256 } from '../../src/core/identity.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config = { schemaVersion: 2 as const, provider: { kind: 'pi-catalog' as const, id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' as const };
function response(name?: string, error?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    content: name ? [{ type: 'toolCall', id: `call-${name}`, name, arguments: {} }] : [{ type: 'text', text: 'Done' }],
    stopReason: error ? 'error' : name ? 'toolUse' : 'stop', ...(error ? { errorMessage: error } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function modelsFor(responses: AssistantMessage[], contexts: Context[]): PiModels {
  return { getModel: () => model, streamSimple: (_model: unknown, context: Context) => {
    contexts.push(JSON.parse(JSON.stringify(context)) as Context);
    const message = responses.shift();
    if (!message) throw new Error('Unexpected request');
    const stream = createAssistantMessageEventStream();
    stream.push(message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message }
      : { type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    return stream;
  } } as unknown as PiModels;
}

test('native closure exposes only selected schemas, forged hidden calls have no effects, and next invocation restores the same session', async () => {
  const events: AgentAuditEvent[] = [], contexts: Context[] = [];
  let saved = false, hiddenEffects = 0;
  const models = modelsFor([response('write'), response('update_comparison_findings'), response('write'), response()], contexts);
  const session = await new AgentHost(new PiModelCaller(config, models)).createSession({ role: 'comparison', systemPrompt: 'Test',
    audit: { append: async event => { events.push(event); } }, tools: [
      { name: 'write', description: 'Write', parameters: Type.Object({}), execute: async () => { hiddenEffects++; return { content: 'Written' }; } },
      { name: 'update_comparison_findings', description: 'Update', parameters: Type.Object({}), execute: async () => { saved = true; return { content: 'status=accepted' }; } },
    ] });
  const result = await session.work({ promptContent: 'Close findings', timeoutMs: 1_000, allowedToolNames: ['update_comparison_findings'], yieldAfterTurn: () => saved ? 'findings_ready' : undefined });
  assert.equal(result.status, 'yielded');
  assert.equal(hiddenEffects, 0);
  assert.ok(contexts.slice(0, 2).every(context => context.tools?.map(tool => tool.name).join(',') === 'update_comparison_findings'));
  assert.match(JSON.stringify(contexts[1]!.messages), /write/);
  assert.equal((await session.work({ promptContent: 'Compose', timeoutMs: 1_000 })).status, 'completed');
  assert.equal(hiddenEffects, 1);
  assert.deepEqual(contexts[2]!.tools?.map(tool => tool.name), ['write', 'update_comparison_findings']);
  assert.equal(events.filter(event => event.type === 'agent.session_started').length, 1);
  const envelopes = events.map((event, index) => {
    const body = { schemaVersion: 1, sequence: index + 1, eventId: `e${index}`, occurredAt: '2026-10-05T00:00:00Z', ...event, payload: { ...event.payload, sessionId: event.sessionId, role: event.role } };
    return { ...body, checksum: sha256(JSON.stringify(body)) };
  });
  const replay = await reconstructModelRequests(envelopes);
  assert.equal(replay.diagnostic, undefined);
  assert.deepEqual(replay.requests.map(request => request.tools.map(tool => tool.name)), contexts.map(context => context.tools!.map(tool => tool.name)));
  assert.ok(replay.requests.every(request => request.contextSource === 'generation_snapshot'));
});

for (const mode of ['failure', 'cancel'] as const) test(`native selected tool set restores after ${mode} without giving hidden tools a side effect`, async () => {
  const contexts: Context[] = [];
  const controller = new AbortController();
  const models = modelsFor([mode === 'failure' ? response(undefined, '401 unauthorized') : response('update'), response('write'), response()], contexts);
  let writes = 0;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [
    { name: 'write', description: 'Write', parameters: Type.Object({}), execute: async () => { writes++; return { content: 'Written' }; } },
    { name: 'update', description: 'Update', parameters: Type.Object({}), execute: async () => { controller.abort(); return { content: 'Saved' }; } },
  ] });
  await assert.rejects(provider.append({ content: 'Close', allowedToolNames: ['update'], signal: controller.signal }), mode === 'failure' ? /401/ : /abort/i);
  await provider.waitForIdle?.();
  assert.equal(writes, 0);
  assert.deepEqual(contexts[0]!.tools?.map(tool => tool.name), ['update']);
  assert.equal(await provider.append({ content: 'Continue', signal: new AbortController().signal }), 'Done');
  assert.deepEqual(contexts[1]!.tools?.map(tool => tool.name), ['write', 'update']);
  assert.equal(writes, 1);
});

test('unknown selection cannot silently become all tools, empty selection is empty, and runTurns restores default selection', async () => {
  const contexts: Context[] = [];
  const models = modelsFor([response(), response(), response()], contexts);
  const session = await new AgentHost(new PiModelCaller(config, models)).createSession({ role: 'comparison', systemPrompt: 'Test', tools: [
    { name: 'update', description: 'Update', parameters: Type.Object({}), execute: async () => ({ content: 'Saved' }) },
  ] });
  const unknown = await session.work({ promptContent: 'Unknown', timeoutMs: 1_000, allowedToolNames: ['unregistered'] });
  assert.equal(unknown.status, 'failed');
  assert.equal(contexts.length, 0);
  assert.equal((await session.runTurns([
    { promptContent: 'No tools', timeoutMs: 1_000, allowedToolNames: [] },
    { promptContent: 'Selected', timeoutMs: 1_000, allowedToolNames: ['update'] },
    { promptContent: 'Default', timeoutMs: 1_000 },
  ])).status, 'completed');
  assert.deepEqual(contexts.map(context => context.tools?.map(tool => tool.name)), [[], ['update'], ['update']]);
});

test('legacy Provider remains compatible with selection request without claiming hidden schemas', async () => {
  let supplied: readonly string[] | undefined;
  const session = await new AgentHost({ createSession: () => ({ append: async input => { supplied = input.allowedToolNames; return 'Done'; }, cancel() {} }) }).createSession({ role: 'comparison', systemPrompt: 'Test' });
  assert.equal((await session.work({ promptContent: 'Close', timeoutMs: 1_000, allowedToolNames: ['update'] })).status, 'completed');
  assert.deepEqual(supplied, ['update']);
});

test('direct concurrent Pi append cannot change an in-flight selected schema list', async () => {
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  const contexts: Context[] = [];
  const models = { getModel: () => model, streamSimple: (_model: unknown, context: Context) => {
    contexts.push(JSON.parse(JSON.stringify(context)) as Context);
    const stream = createAssistantMessageEventStream();
    void completed.then(() => stream.push({ type: 'done', reason: 'stop', message: response() }));
    return stream;
  } } as unknown as PiModels;
  const provider = new PiProviderAdapter({ models, model, config }).createSession({ sessionId: 'session', systemPrompt: 'Test', tools: [
    { name: 'update', description: 'Update', parameters: Type.Object({}), execute: async () => ({ content: 'Saved' }) },
    { name: 'write', description: 'Write', parameters: Type.Object({}), execute: async () => ({ content: 'Written' }) },
  ] });
  const first = provider.append({ content: 'Close', allowedToolNames: ['update'], signal: new AbortController().signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(provider.append({ content: 'Concurrent', allowedToolNames: ['write'], signal: new AbortController().signal }), /invocation in flight/);
  assert.deepEqual(contexts[0]!.tools?.map(tool => tool.name), ['update']);
  release();
  await first;
  await provider.append({ content: 'Default', signal: new AbortController().signal });
  assert.deepEqual(contexts[1]!.tools?.map(tool => tool.name), ['update', 'write']);
});

for (const scope of ['generation', 'compaction'] as const) test(`cancellation before or during ${scope} input audit prevents the actual upstream call`, async () => {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const pendingAudit = new Promise<void>(resolve => { release = resolve; });
  let upstreamCalls = 0, audits = 0;
  const models = { streamSimple: () => { upstreamCalls++; throw new Error('Cancelled upstream must not be called'); },
    completeSimple: async () => { upstreamCalls++; throw new Error('Cancelled upstream must not be called'); } } as unknown as PiModels;
  const usage = piRequestUsage(models, { onModelRequest: async () => { audits++; start(); await pendingAudit; } });
  const controller = new AbortController();
  const context: Context = { systemPrompt: 'Test', tools: [], messages: [] };
  const request = scope === 'generation' ? usage.stream : usage.models.completeSimple;
  await assert.rejects(request(model, context, { signal: AbortSignal.abort() }), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(audits, 0);
  const active = request(model, context, { signal: controller.signal });
  const rejected = assert.rejects(active, error => error instanceof Error && error.name === 'AbortError');
  await started;
  controller.abort();
  release();
  await rejected;
  assert.equal(audits, 1);
  assert.equal(upstreamCalls, 0);
});
