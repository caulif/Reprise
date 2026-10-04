import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Model } from '@earendil-works/pi-ai';
import { callerLoopHooks } from '../../src/infrastructure/agent/audit.js';
import { piRequestUsage } from '../../src/infrastructure/agent/providers/pi/request-usage.js';
import type { PiModels } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { inlineBody, inspectModelInputBody, reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { readCommittedModelLog } from '../../src/infrastructure/agent/history-read.js';
import { readCommittedExperimentHistory } from '../../src/application/experiment-history-read.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { sha256 } from '../../src/core/identity.js';

test('paid compaction captures the exact sanitized context and reconstructs checked text/image attachments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compaction-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const audit = experimentAgentAuditSink(store, 'run-1');
  await audit.append({ type: 'agent.session_started', sessionId: 'summary-session', role: 'comparison', payload: { systemPrompt: 'Compare', tools: [] } });
  await audit.append({ type: 'agent.message_appended', sessionId: 'summary-session', role: 'comparison', payload: { invocationId: 'inv-1', requestIndex: 1, body: inlineBody('Investigate') } });
  const cursor = { invocationId: 'inv-1', requestIndex: 1 };
  const hooks = callerLoopHooks('summary-session', 'comparison', cursor, audit);
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let sent: Context | undefined;
  const models = { completeSimple: async (_model: unknown, context: Context) => {
    sent = context;
    return { role: 'assistant', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } };
  } } as unknown as PiModels;
  const usage = piRequestUsage(models, hooks);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  const context: Context = { systemPrompt: 'Summarize the inspected sources', tools: [{ name: 'read', description: 'read sources', parameters: { type: 'object', properties: {} } }], messages: [
    { role: 'user', timestamp: 1, content: [{ type: 'text', text: `Authorization: Bearer secret-token\n${'evidence '.repeat(1200)}` }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] },
  ] };
  await usage.models.completeSimple(model, context);
  assert.ok(sent);
  assert.doesNotMatch(JSON.stringify(sent), /secret-token/);
  const requestEvent = store.events().find(event => event.type === 'agent.model_request');
  assert.ok(requestEvent);
  const payload = requestEvent.payload as { compactionInput: { encoding: string }; digest: string };
  assert.equal(payload.compactionInput.encoding, 'artifact');
  assert.equal(payload.digest, sha256(JSON.stringify({ model, context: sent })));
  assert.doesNotMatch(JSON.stringify(store.events()), /secret-token/);
  const replayed = await reconstructModelRequests(store.events(), experimentModelInputResolver(store, 'run-1'));
  assert.equal(replayed.diagnostic, undefined);
  assert.equal(replayed.requests.length, 1);
  assert.equal(replayed.requests[0]?.modelRequestDigest, undefined);
  const restored = replayed.compactionRequests?.[0];
  assert.equal(restored?.contentComplete, true);
  assert.equal(restored?.context?.systemPrompt, sent.systemPrompt);
  assert.deepEqual(restored?.context?.tools, sent.tools);
  assert.match(JSON.stringify(restored?.context?.messages), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(restored?.context), new RegExp(png.toString('base64')));
  assert.equal(restored?.nativeImages?.[0]?.contentHash, sha256(png));
  const missing = await reconstructModelRequests(store.events());
  assert.equal(missing.diagnostic?.code, 'missing_attachment');
  const corrupt = await reconstructModelRequests(store.events(), async () => 'corrupted attachment');
  assert.equal(corrupt.diagnostic?.code, 'attachment_checksum');
  await store.close();
  const historyLog = await readCommittedModelLog(join(root, 'events.jsonl'), experimentModelInputResolver(store, 'run-1'));
  assert.equal(historyLog.compactionRequests?.[0]?.contentComplete, true);
  assert.deepEqual(historyLog.compactionRequests?.[0]?.context, restored?.context);
  assert.equal(historyLog.compactionRequests?.[0]?.nativeImages?.[0]?.contentHash, sha256(png));
  assert.equal((await readCommittedExperimentHistory(root, 'experiment-1')).incompleteModelInput, false);
  const body = inspectModelInputBody(payload.compactionInput);
  assert.ok(body.ok && body.body.encoding === 'artifact');
  await rm(join(root, 'runs', 'run-1', 'artifacts', body.body.artifactId));
  const missingHistory = await readCommittedExperimentHistory(root, 'experiment-1');
  assert.equal(missingHistory.incompleteModelInput, true);
  assert.equal(missingHistory.diagnosticCode, 'missing_attachment');
});

test('History marks legacy compaction without an input body as incomplete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-legacy-compaction-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [
    { type: 'agent.session_started', payload: { sessionId: 'session-1', role: 'comparison', systemPrompt: 'Compare', tools: [] } },
    { type: 'agent.model_request', payload: { sessionId: 'session-1', role: 'comparison', invocationId: 'inv-1', requestIndex: 1, scope: 'compaction', model: 'fixture', digest: 'a'.repeat(64), images: [] } },
  ];
  const log = events.map((event, index) => {
    const body = { schemaVersion: 1, sequence: index + 1, eventId: `event-${index + 1}`, occurredAt: '2026-10-05T00:00:00.000Z', ...event };
    return `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`;
  }).join('');
  await writeFile(join(root, 'events.jsonl'), log);
  const historyLog = await readCommittedModelLog(join(root, 'events.jsonl'));
  assert.equal(historyLog.compactionRequests?.[0]?.contentComplete, false);
  assert.equal(historyLog.diagnostic, undefined);
  assert.equal((await readCommittedExperimentHistory(root)).incompleteModelInput, true);
});
