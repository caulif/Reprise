import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { callerLoopHooks } from '../../src/infrastructure/agent/audit.js';
import { instrumentTools } from '../../src/infrastructure/agent/tools.js';
import { PiProviderAdapter, type PiModels } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { inlineBody, reconstructModelRequests, redactModelVisibleValue, redactModelVisibleText, type ModelInputResolver } from '../../src/infrastructure/agent/model-input.js';
import { readCommittedModelLog } from '../../src/infrastructure/agent/history-read.js';
import { sha256 } from '../../src/core/identity.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const large of [false, true]) test(`generation captures actual native errors, arguments and whole tool batch after transform/prune: ${large}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-generation-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const audit = experimentAgentAuditSink(store, 'run-1');
  const cursor = { invocationId: 'inv-1', requestIndex: 1 };
  const outbound: Context[] = [];
  const goodArgs = { payload: { value: 37, apiKey: 'standalone-api-secret', authorization: 'standalone-auth-secret' } };
  const responses = [response([{ type: 'toolCall', id: 'native-bad', name: 'save', arguments: { payload: '{"apiKey":"bad-native-secret"}', authorization: 'bad-native-auth' } }]),
    response([{ type: 'toolCall', id: 'native-good', name: 'save', arguments: goodArgs }, { type: 'toolCall', id: 'native-inspect', name: 'inspect_comparison_draft', arguments: {} }]),
    response([{ type: 'text', text: 'Done' }], 'stop')];
  const models = { getModel: () => model, streamSimple: (_model: unknown, context: Context) => {
    outbound.push(JSON.parse(JSON.stringify(context)) as Context);
    const message = responses.shift();
    if (!message) throw new Error('Unexpected generation');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    return stream;
  } } as unknown as PiModels;
  const inspection = 'ACTUAL-FULL-INSPECTION';
  const tools = instrumentTools([
    { name: 'save', description: 'Save '.repeat(1800), parameters: Type.Object({ payload: Type.Object({ value: Type.Number(), apiKey: Type.String(), authorization: Type.String() }) }), execute: async () => ({ content: large ? 'body '.repeat(4000) : 'Saved' }) },
    { name: 'inspect_comparison_draft', description: 'Inspect', parameters: Type.Object({}), execute: async () => ({ content: inspection }) },
  ], 'session-1', 'comparison', cursor, audit);
  await audit.append({ type: 'agent.session_started', sessionId: 'session-1', role: 'comparison', payload: { systemPrompt: 'Test', tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } });
  await audit.append({ type: 'agent.message_appended', sessionId: 'session-1', role: 'comparison', payload: { ...cursor, body: inlineBody('Go'), images: [] } });
  const adapter = new PiProviderAdapter({ models, model, config: { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' } });
  const session = adapter.createSession({ sessionId: 'session-1', systemPrompt: 'Test', tools, ...callerLoopHooks('session-1', 'comparison', cursor, audit) });
  await session.append({ content: 'Go', signal: new AbortController().signal });
  const rebuilt = await reconstructModelRequests(store.events(), experimentModelInputResolver(store, 'run-1'));
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests.length, outbound.length);
  for (const [index, request] of rebuilt.requests.entries()) {
    assert.equal(request.contextSource, 'generation_snapshot');
    assert.equal(request.contentComplete, true);
    assert.deepEqual(request.messages, outbound[index]!.messages);
    assert.deepEqual(request.tools, outbound[index]!.tools);
    assert.equal(request.systemPrompt, outbound[index]!.systemPrompt);
  }
  const actual = JSON.stringify(rebuilt.requests.at(-1)!.messages);
  assert.match(actual, /native-bad/);
  assert.match(actual, /isError":true/);
  assert.match(actual, /"value":37/);
  assert.match(actual, /ACTUAL-FULL-INSPECTION/);
  assert.doesNotMatch(actual, /standalone-api-secret|standalone-auth-secret|bad-native-secret|bad-native-auth/);
  assert.doesNotMatch(JSON.stringify(store.events()), /standalone-api-secret|standalone-auth-secret|bad-native-secret|bad-native-auth/);
  const recorded = store.events().filter(event => event.type === 'agent.model_request');
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every(event => (event.payload as { generationInput: { encoding: string } }).generationInput.encoding === 'artifact'));
  assert.equal((await reconstructModelRequests(store.events())).diagnostic?.code, 'missing_attachment');
  assert.equal((await reconstructModelRequests(store.events(), async () => 'corrupt')).diagnostic?.code, 'attachment_checksum');
  assert.equal(store.events().some(event => event.type === 'agent.context_compacted'), large);
  await store.close();
  const history = await readCommittedModelLog(join(root, 'events.jsonl'), experimentModelInputResolver(store, 'run-1'));
  assert.deepEqual(history.requests, rebuilt.requests);
});

function replayEvents(generationInput?: unknown): EventEnvelope[] {
  const rows = [
    { type: 'agent.session_started', payload: { sessionId: 'session', role: 'comparison', systemPrompt: 'Old system', tools: [] } },
    { type: 'agent.message_appended', payload: { sessionId: 'session', invocationId: 'inv', requestIndex: 1, body: inlineBody('Old event projection') } },
    { type: 'agent.model_request', payload: { sessionId: 'session', invocationId: 'inv', requestIndex: 1, scope: 'generation', model: 'fixture', digest: 'a'.repeat(64), messageCount: 0, images: [], ...(generationInput === undefined ? {} : { generationInput }) } },
  ];
  return rows.map((row, index) => {
    const body = { schemaVersion: 1, sequence: index + 1, eventId: `e${index}`, occurredAt: '2026-10-05T00:00:00Z', ...row };
    return { ...body, checksum: sha256(JSON.stringify(body)) };
  });
}

test('actual empty generation context replaces plausible legacy projection without granting legacy exactness', async () => {
  const legacy = await reconstructModelRequests(replayEvents());
  assert.equal(legacy.requests[0]!.contextSource, 'event_projection');
  assert.equal(legacy.requests[0]!.contentComplete, true, 'complete projection is not exact generation provenance');
  const current = await reconstructModelRequests(replayEvents(inlineBody(JSON.stringify({ systemPrompt: 'Actual system', messages: [], tools: [] }))));
  assert.equal(current.diagnostic, undefined);
  assert.equal(current.requests[0]!.contextSource, 'generation_snapshot');
  assert.equal(current.requests[0]!.systemPrompt, 'Actual system');
  assert.deepEqual(current.requests[0]!.messages, []);
});

for (const [body, code] of [
  [{ encoding: 'inline', schemaVersion: 2, text: '{}' }, 'unsupported_schema'],
  [{ encoding: 'unknown', schemaVersion: 1 }, 'incomplete_content'],
  [inlineBody('{bad JSON'), 'schema'],
  [inlineBody(JSON.stringify({ messages: 'bad' })), 'schema'],
  [inlineBody(JSON.stringify({ messages: [], tools: [{ name: '' }] })), 'schema'],
] as const) test(`invalid actual snapshot cannot fall back to old projection: ${code}`, async () => {
  const rebuilt = await reconstructModelRequests(replayEvents(body));
  assert.equal(rebuilt.diagnostic?.code, code);
  assert.equal(rebuilt.requests.some(request => request.contextSource === 'generation_snapshot'), false);
});

test('generation image snapshots use checked artifacts and missing/corrupt image payload cannot certify completeness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-generation-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const audit = experimentAgentAuditSink(store, 'run-1');
  const cursor = { invocationId: 'inv', requestIndex: 1 };
  await audit.append({ type: 'agent.session_started', sessionId: 'session', role: 'comparison', payload: { systemPrompt: 'Compare', tools: [] } });
  await audit.append({ type: 'agent.message_appended', sessionId: 'session', role: 'comparison', payload: { ...cursor, body: inlineBody('Go') } });
  const png = Buffer.from('test image bytes');
  const context: Context = { systemPrompt: 'Compare', tools: [], messages: [{ role: 'user', timestamp: 1, content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }] };
  const models = { streamSimple: () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: response([{ type: 'text', text: 'Done' }], 'stop') });
    return stream;
  } } as unknown as PiModels;
  const usage = piRequestUsage(models, callerLoopHooks('session', 'comparison', cursor, audit));
  await usage.stream(model, context);
  await usage.flush();
  const resolver = experimentModelInputResolver(store, 'run-1');
  const rebuilt = await reconstructModelRequests(store.events(), resolver);
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests[0]!.contextSource, 'generation_snapshot');
  assert.equal(rebuilt.requests[0]!.contentComplete, true);
  assert.equal(rebuilt.requests[0]!.nativeImages![0]!.contentHash, sha256(png));
  assert.doesNotMatch(JSON.stringify(store.events()), new RegExp(png.toString('base64')));
  const missing: ModelInputResolver = Object.assign(resolver, { image: async () => { throw new Error('missing'); } });
  assert.equal((await reconstructModelRequests(store.events(), missing)).diagnostic?.code, 'missing_attachment');
  const corrupt: ModelInputResolver = Object.assign(experimentModelInputResolver(store, 'run-1'), { image: async () => Buffer.from('wrong bytes') });
  assert.equal((await reconstructModelRequests(store.events(), corrupt)).diagnostic?.code, 'attachment_checksum');
  const incomplete = await reconstructModelRequests(replayEvents(inlineBody(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', contentHash: sha256(png), byteLength: png.length }] }] }))));
  assert.equal(incomplete.requests[0]!.contentComplete, false);
});

test('structured credential strings are redacted while native tool schemas and ordinary object arguments remain intact', () => {
  const value = { arguments: { apiKey: 'raw-api', authorization: 'raw-auth', password: 'raw-password', accessToken: 'raw-token', client_secret: 'raw-secret', nested: { value: 37 } },
    tools: [{ parameters: { properties: { token: { type: 'string', description: 'Session token' }, apiKey: { type: 'string' } } } }] };
  const sanitized = redactModelVisibleValue(value);
  assert.deepEqual(sanitized.arguments.nested, { value: 37 });
  assert.deepEqual(sanitized.tools, value.tools);
  assert.doesNotMatch(JSON.stringify(sanitized), /raw-api|raw-auth|raw-password|raw-token|raw-secret/);
  assert.equal(value.arguments.apiKey, 'raw-api', 'redaction cannot mutate native model/tool state');
});

test('quoted JSON credentials in native error text are redacted in ordinary and escaped forms', () => {
  const ordinary = 'Native validation failed: {"apiKey":"quoted-secret","authorization":"raw-auth","value":37}';
  const escaped = String.raw`Native validation failed: {\"apiKey\":\"escaped-secret\",\"password\":\"escaped-password\",\"value\":37}`;
  const result = redactModelVisibleText(`${ordinary}\n${escaped}`).text;
  assert.doesNotMatch(result, /quoted-secret|raw-auth|escaped-secret|escaped-password/);
  assert.match(result, /"value":37/);
  assert.match(result, /\\"value\\":37/);
  assert.equal(redactModelVisibleText(result).text, result, 'snapshot redaction must be idempotent');
});
