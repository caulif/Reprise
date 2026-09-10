import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { sha256 } from '../../src/core/identity.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { persistAgentAuditEvent, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { PiAgentHost } from '../../src/infrastructure/agent/host.js';
import {
  INCOMPLETE_MODEL_INPUT_COPY,
  INLINE_MODEL_INPUT_BYTES,
  inlineBody,
  inspectModelInputBody,
  parseCommittedEventLog,
  reconstructModelRequests,
  redactModelVisibleText,
} from '../../src/infrastructure/agent/model-input.js';

const occurredAt = '2026-09-08T00:00:00.000Z';

function envelope(sequence: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  const body = { schemaVersion: 1, sequence, eventId: `event${sequence}`, occurredAt, type, payload };
  return { ...body, checksum: sha256(JSON.stringify(body)) };
}

test('redaction strips bearer tokens before anything is recorded or sent', () => {
  const redacted = redactModelVisibleText('Authorization: Bearer ultra-secret-token');
  assert.equal(redacted.redacted, true);
  assert.doesNotMatch(redacted.text, /ultra-secret-token/);
});

test('reconstructed requests include a repair prompt and a compacted working set', async () => {
  const events = [
    envelope(1, 'agent.session_started', {
      sessionId: 'session-1',
      role: 'recovery',
      systemPrompt: 'Stay on the evidence.',
      tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }],
    }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      body: inlineBody('first look'),
    }),
    envelope(3, 'agent.model_output', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      body: inlineBody('not-json'),
    }),
    envelope(4, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 2,
      repair: true,
      body: inlineBody('Your prior response was invalid. Return only JSON.'),
    }),
    envelope(5, 'agent.context_compacted', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 2,
      summary: 'Keep the cited evidence.',
      retainedTail: inlineBody(JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'tail-only' }] }])),
    }),
  ];
  const rebuilt = await reconstructModelRequests(events);
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests.length, 2);
  assert.equal(rebuilt.requests[0]?.repair, false);
  assert.match(rebuilt.requests[0]?.messages.map((message) => JSON.stringify(message)).join('\n') ?? '', /first look/);
  assert.equal(rebuilt.requests[1]?.repair, true);
  assert.equal(rebuilt.requests[1]?.compacted, true);
  assert.match(JSON.stringify(rebuilt.requests[1]?.messages), /Keep the cited evidence/);
  assert.match(JSON.stringify(rebuilt.requests[1]?.messages), /tail-only/);
  assert.doesNotMatch(JSON.stringify(rebuilt.requests[1]?.messages), /first look/);
  assert.equal(rebuilt.requests[0]?.contentComplete, true);
});

test('legacy events without bodies keep a readable gap and do not invent prompt text', async () => {
  const rebuilt = await reconstructModelRequests([
    envelope(1, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      byteLength: 12,
    }),
  ]);
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests[0]?.contentComplete, false);
  assert.deepEqual(rebuilt.requests[0]?.messages, []);
  const gap = inspectModelInputBody(undefined);
  assert.equal(gap.ok, false);
  if (!gap.ok) assert.equal(gap.diagnostic.message, INCOMPLETE_MODEL_INPUT_COPY);
});

test('unknown model input schemaVersion fails closed', async () => {
  const rebuilt = await reconstructModelRequests([
    envelope(1, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      body: { encoding: 'inline', schemaVersion: 2, text: 'secret-future-format' },
    }),
  ]);
  assert.equal(rebuilt.diagnostic?.code, 'unsupported_schema');
  assert.doesNotMatch(JSON.stringify(rebuilt.requests), /secret-future-format/);
});

test('unknown event envelope schemaVersion is diagnosed without later lines', async () => {
  const parsed = parseCommittedEventLog(`${JSON.stringify({
    schemaVersion: 2, sequence: 1, eventId: 'event1', occurredAt, type: 'run.attempt_created', payload: {}, checksum: 'a'.repeat(64),
  })}\n`);
  assert.equal(parsed.diagnostic?.code, 'unsupported_schema');
  assert.equal(parsed.events.length, 0);
});

test('committed event checksum mismatches stop before later lines', () => {
  const ok = envelope(1, 'run.attempt_created', {});
  const bad = { ...envelope(2, 'run.attempt_created', { text: 'x' }), checksum: 'a'.repeat(64) };
  const parsed = parseCommittedEventLog(`${JSON.stringify(ok)}\n${JSON.stringify(bad)}\n`);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.diagnostic?.code, 'checksum_mismatch');
});

test('legacy session_completed is read as request completion without inventing output', async () => {
  const rebuilt = await reconstructModelRequests([
    envelope(1, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      body: inlineBody('ask'),
    }),
    envelope(3, 'agent.session_completed', { sessionId: 'session-1', role: 'recovery' }),
  ]);
  assert.equal(rebuilt.requests[0]?.legacyRequestComplete, true);
  assert.equal(rebuilt.requests[0]?.contentComplete, true);
  assert.doesNotMatch(JSON.stringify(rebuilt.requests[0]?.messages), /assistant/);
});

test('incomplete tails, illegal JSON, and missing attachments are diagnosed', async () => {
  const truncated = parseCommittedEventLog('{"schemaVersion":1');
  assert.equal(truncated.diagnostic?.code, 'incomplete_tail');
  const illegal = parseCommittedEventLog('{not json}\n');
  assert.equal(illegal.diagnostic?.code, 'invalid_json');
  const missing = await reconstructModelRequests([
    envelope(1, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      body: { encoding: 'artifact', schemaVersion: 1, artifactId: 'miab', contentHash: 'a'.repeat(64), byteLength: 4 },
    }),
  ]);
  assert.equal(missing.diagnostic?.code, 'missing_attachment');
});

test('Host records filtered user text before calling the model and refuses to call if that write fails', async () => {
  let modelCalls = 0;
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const host = new PiAgentHost({
    createSession: () => ({
      append: async ({ content }) => {
        modelCalls += 1;
        assert.doesNotMatch(content, /ultra-secret-token/);
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const failed = await host.request({
    role: 'recovery',
    systemPrompt: 'fixed',
    context: {},
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    promptContent: 'Authorization: Bearer ultra-secret-token',
    audit: {
      append: async (event) => {
        if (event.type === 'agent.message_appended') throw new Error('disk full');
      },
    },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(modelCalls, 0);
  const ok = await host.request({
    role: 'recovery',
    systemPrompt: 'fixed',
    context: {},
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    promptContent: 'Authorization: Bearer ultra-secret-token',
    audit: {
      append: async (event) => {
        events.push({ type: event.type, payload: { sessionId: event.sessionId, role: event.role, ...event.payload } });
      },
    },
  });
  assert.equal(ok.status, 'completed');
  assert.equal(modelCalls, 1);
  const recorded = events.find((event) => event.type === 'agent.message_appended');
  assert.doesNotMatch(JSON.stringify(recorded), /ultra-secret-token/);
  const rebuilt = await reconstructModelRequests(events.map((event, index) => envelope(index + 1, event.type, event.payload)));
  assert.equal(rebuilt.requests[0]?.repair, false);
  assert.match(JSON.stringify(rebuilt.requests[0]?.messages), /REDACTED/);
});

test('checksum mismatches on resolved artifacts are diagnosed', async () => {
  const rebuilt = await reconstructModelRequests([
    envelope(1, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] }),
    envelope(2, 'agent.message_appended', {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      requestIndex: 1,
      repair: false,
      body: { encoding: 'artifact', schemaVersion: 1, artifactId: 'miab', contentHash: 'a'.repeat(64), byteLength: 4 },
    }),
  ], async () => 'nope');
  assert.equal(rebuilt.diagnostic?.code, 'attachment_checksum');
});

test('Host does not report success if model output cannot be recorded', async () => {
  let modelCalls = 0;
  const types: string[] = [];
  const host = new PiAgentHost({
    createSession: () => ({
      append: async () => {
        modelCalls += 1;
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const result = await host.request({
    role: 'recovery',
    systemPrompt: 'fixed',
    context: {},
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    audit: {
      append: async (event) => {
        types.push(event.type);
        if (event.type === 'agent.model_output') throw new Error('disk full');
      },
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(modelCalls, 1);
  assert.equal(types.includes('agent.invocation_completed'), false);
});

test('an empty process rebuilds compacted and repaired requests from the event log and artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-model-input-'));
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const sessionId = 'session-1';
    const spilled = `first look ${'x'.repeat(INLINE_MODEL_INPUT_BYTES)}`;
    await persistAgentAuditEvent(store, 'run-1', {
      type: 'agent.session_started',
      sessionId,
      role: 'recovery',
      payload: {
        systemPrompt: 'Stay on the evidence.',
        tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }],
      },
    });
    await persistAgentAuditEvent(store, 'run-1', {
      type: 'agent.message_appended',
      sessionId,
      role: 'recovery',
      payload: { invocationId: 'inv-1', requestIndex: 1, repair: false, body: inlineBody(spilled) },
    });
    await persistAgentAuditEvent(store, 'run-1', {
      type: 'agent.model_output',
      sessionId,
      role: 'recovery',
      payload: { invocationId: 'inv-1', requestIndex: 1, body: inlineBody('not-json') },
    });
    await persistAgentAuditEvent(store, 'run-1', {
      type: 'agent.message_appended',
      sessionId,
      role: 'recovery',
      payload: { invocationId: 'inv-1', requestIndex: 2, repair: true, body: inlineBody('Your prior response was invalid. Return only JSON.') },
    });
    await persistAgentAuditEvent(store, 'run-1', {
      type: 'agent.context_compacted',
      sessionId,
      role: 'recovery',
      payload: {
        invocationId: 'inv-1',
        requestIndex: 2,
        summary: 'Keep the cited evidence.',
        retainedTail: inlineBody(JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'tail-only' }] }])),
      },
    });
    await store.close();
    const parsed = parseCommittedEventLog(await readFile(join(root, 'events.jsonl'), 'utf8'));
    assert.equal(parsed.diagnostic, undefined);
    const reopened = await ExperimentStore.open(root, 'experiment-1');
    const rebuilt = await reconstructModelRequests(parsed.events, experimentModelInputResolver(reopened, 'run-1'));
    assert.equal(rebuilt.diagnostic, undefined);
    assert.equal(rebuilt.requests.length, 2);
    assert.match(JSON.stringify(rebuilt.requests[0]?.messages), /first look/);
    assert.equal(rebuilt.requests[1]?.repair, true);
    assert.equal(rebuilt.requests[1]?.compacted, true);
    assert.match(JSON.stringify(rebuilt.requests[1]?.messages), /Keep the cited evidence/);
    assert.match(JSON.stringify(rebuilt.requests[1]?.messages), /tail-only/);
    assert.doesNotMatch(JSON.stringify(rebuilt.requests[1]?.messages), /first look/);
    assert.equal(JSON.stringify(parsed.events).includes(spilled), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
