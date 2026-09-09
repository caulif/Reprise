import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { PiAgentHost, type AgentAuditEvent } from '../src/infrastructure/agent/host.js';
import { projectTimelineEvent } from '../src/tui/timeline.js';
import type { EventEnvelope } from '../src/core/schema.js';

const schema = Type.Object({ ok: Type.Boolean() });
function request(overrides: { timeoutMs?: number; maxRepairAttempts?: number; signal?: AbortSignal } = {}) {
  return { context: {}, schema, timeoutMs: overrides.timeoutMs ?? 50, maxRepairAttempts: overrides.maxRepairAttempts ?? 0, ...(overrides.signal ? { signal: overrides.signal } : {}) };
}

test('two Host requests on one Session share transcript and keep distinct invocation ids', async () => {
  const appended: string[] = [];
  const events: AgentAuditEvent[] = [];
  const host = new PiAgentHost({
    createSession: () => ({
      append: async ({ content }) => {
        appended.push(content);
        return JSON.stringify({ ok: true, seen: appended.length });
      },
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: 'recovery',
    systemPrompt: 'fixed',
    allowModelText: true,
    audit: { append: async (event) => { events.push(event); } },
  });
  const first = await session.request({ ...request(), requestId: 'inv-1' });
  const second = await session.request({ ...request(), requestId: 'inv-2' });
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  if (first.status === 'completed') assert.equal(first.invocationId, 'inv-1');
  if (second.status === 'completed') assert.equal(second.invocationId, 'inv-2');
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(appended.length, 2);
  assert.deepEqual(events.map((event) => event.type).filter((type) => type.startsWith('agent.invocation') || type === 'agent.session_completed'), [
    'agent.invocation_started',
    'agent.invocation_completed',
    'agent.invocation_started',
    'agent.invocation_completed',
  ]);
  await session.close();
  assert.equal(events.at(-1)?.type, 'agent.session_completed');
  const closed = await session.request(request());
  assert.equal(closed.status, 'failed');
  if (closed.status === 'failed') assert.match(closed.failure.message, /closed/);
});

test('a second concurrent invocation on the same Session is rejected', async () => {
  let resolve!: (value: string) => void;
  const host = new PiAgentHost({
    createSession: () => ({
      append: async () => await new Promise<string>((done) => { resolve = done; }),
      cancel() {},
    }),
  });
  const session = await host.createSession({ role: 'recovery', systemPrompt: 'fixed', allowModelText: true });
  const pending = session.request(request());
  await new Promise((done) => setImmediate(done));
  const concurrent = await session.request(request());
  assert.equal(concurrent.status, 'failed');
  if (concurrent.status === 'failed') {
    assert.equal(concurrent.failure.code, 'concurrent_invocation');
    assert.match(concurrent.failure.message, /already has an invocation in flight/);
  }
  resolve(JSON.stringify({ ok: true }));
  assert.equal((await pending).status, 'completed');
});

test('late provider text after cancel cannot complete the invocation', async () => {
  let resolve!: (value: string) => void;
  const events: AgentAuditEvent[] = [];
  const host = new PiAgentHost({
    createSession: () => ({
      append: async () => await new Promise<string>((done) => { resolve = done; }),
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: 'controller',
    systemPrompt: 'fixed',
    allowModelText: true,
    audit: { append: async (event) => { events.push(event); } },
  });
  const pending = session.request({ ...request({ timeoutMs: 0 }), requestId: 'late-1' });
  await new Promise((done) => setImmediate(done));
  await session.cancel('event:stop');
  assert.equal((await pending).status, 'cancelled');
  resolve(JSON.stringify({ ok: true }));
  assert.equal((await pending).status, 'cancelled');
  assert.ok(events.some((event) => event.type === 'agent.invocation_cancelled'));
  assert.ok(events.some((event) => event.type === 'agent.session_cancelled'));
  assert.equal(events.some((event) => event.type === 'agent.invocation_completed'), false);
});

test('one-shot Host.request closes the Session after the invocation', async () => {
  const events: AgentAuditEvent[] = [];
  const host = new PiAgentHost({
    createSession: () => ({ append: async () => JSON.stringify({ ok: true }), cancel() {} }),
  });
  const result = await host.request({
    role: 'comparison',
    systemPrompt: 'fixed',
    context: {},
    schema,
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    audit: { append: async (event) => { events.push(event); } },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.map((event) => event.type), [
    'agent.session_started',
    'agent.invocation_started',
    'agent.message_appended',
    'agent.model_output',
    'agent.invocation_completed',
    'agent.session_completed',
  ]);
});

test('invocation lifecycle events stay off the run timeline', () => {
  const envelope = (type: string): EventEnvelope => ({
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: '2026-09-08T00:00:00.000Z',
    type,
    payload: { role: 'recovery' },
    checksum: '0'.repeat(64),
  });
  for (const type of ['agent.invocation_started', 'agent.invocation_completed', 'agent.invocation_failed', 'agent.invocation_cancelled']) {
    assert.deepEqual(projectTimelineEvent(envelope(type)), []);
  }
});

test('Host freeform request completes without JSON repair', async () => {
  const events: AgentAuditEvent[] = [];
  const appended: string[] = [];
  const host = new PiAgentHost({
    createSession: () => ({
      append: async ({ content }) => {
        appended.push(content);
        return 'investigating both workspaces; not JSON';
      },
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: 'comparison',
    systemPrompt: 'fixed',
    allowModelText: true,
    audit: { append: async (event) => { events.push(event); } },
  });
  const result = await session.requestFreeform({
    promptContent: 'Read observations/user-inputs/INDEX.tsv first.',
    timeoutMs: 50,
  });
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal('value' in result, false);
  assert.deepEqual(appended, ['Read observations/user-inputs/INDEX.tsv first.']);
  assert.ok(events.some((event) => event.type === 'agent.message_appended'));
  assert.ok(events.some((event) => event.type === 'agent.model_output'));
  assert.ok(events.some((event) => event.type === 'agent.invocation_completed'));
  assert.equal(events.some((event) => event.type === 'agent.invalid_output'), false);
  await session.close();
});

test('Host freeform request rejects JSON repair attempts', async () => {
  const host = new PiAgentHost({
    createSession: () => ({ append: async () => 'unused', cancel() {} }),
  });
  const session = await host.createSession({ role: 'comparison', systemPrompt: 'fixed', allowModelText: true });
  await assert.rejects(
    () => session.requestFreeform({
      promptContent: 'Do not return JSON.',
      timeoutMs: 50,
      maxRepairAttempts: 1,
    }),
    /cannot run JSON repair/,
  );
  await session.close();
});
