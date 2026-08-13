import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, type SteeringContext } from '../src/agents/controller-agent.js';
import { PiAgentHost, type AgentAuditEvent, type PiTextCaller } from '../src/infrastructure/pi-agent-host.js';
import { Type } from '@sinclair/typebox';

function context(allowModelText = true): SteeringContext {
  return { runId: 'run-1', runState: 'awaiting_controller', task: { initialInput: { id: 'message-1', role: 'user', text: 'Implement it.' }, baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] }, privacy: { allowModelText, allowBinary: false, redactions: [] } }, current: { summary: 'Target is waiting.', evidenceRefs: ['event:current-1'] }, trajectory: { summary: 'No prior turns.', evidenceRefs: ['artifact:trace-1'] }, budget: { decisionsUsed: 1, decisionsLimit: 3 } };
}

function caller(responses: string[], sessions: Array<{ input: Parameters<PiTextCaller['createSession']>[0]; appended: string[] }> = []): PiTextCaller {
  return { createSession(input) { const record = { input, appended: [] as string[] }; sessions.push(record); return { append: async ({ content }) => { record.appended.push(content); return responses.shift() ?? ''; }, cancel() {} }; } };
}

test('AgentSessionHost repairs malformed JSON in the same isolated Controller session', async () => {
  const sessions: Array<{ input: Parameters<PiTextCaller['createSession']>[0]; appended: string[] }> = [];
  const controller = new ControllerAgent({ host: new PiAgentHost(caller(['not-json', JSON.stringify({ type: 'send', message: 'Please verify.', intent: 'verify', evidenceRefs: ['event:current-1'] })], sessions)), timeoutMs: 50, maxRepairAttempts: 1 });
  const result = await controller.decide(context());
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.type, 'send');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.appended.length, 2);
  assert.match(sessions[0]?.appended[1] ?? '', /Return only JSON/);
});

test('failed, timeout, and privacy-blocked requests never manufacture a Controller decision', async () => {
  const invalid = new ControllerAgent({ host: new PiAgentHost(caller([JSON.stringify({ type: 'send', message: 'x', intent: 'continue', evidenceRefs: ['event:foreign-1'] })])), timeoutMs: 50, maxRepairAttempts: 0 });
  const invalidResult = await invalid.decide(context());
  assert.deepEqual(invalidResult.status === 'failed' ? invalidResult.failure : undefined, { code: 'invalid_output', message: 'unknown evidence reference', attempts: 1 });

  const timedOut = new ControllerAgent({ host: new PiAgentHost({ createSession: () => ({ append: async () => new Promise<string>(() => {}), cancel() {} }) }), timeoutMs: 1, maxRepairAttempts: 0 });
  const timeout = await timedOut.decide(context());
  assert.equal(timeout.status, 'failed');
  if (timeout.status === 'failed') assert.equal(timeout.failure.code, 'agent_timeout');

  let calls = 0;
  const blocked = new ControllerAgent({ host: new PiAgentHost({ createSession: () => { calls += 1; throw new Error('must not be called'); } }), timeoutMs: 50, maxRepairAttempts: 0 });
  const blockedResult = await blocked.decide(context(false));
  assert.equal(blockedResult.status, 'failed');
  if (blockedResult.status === 'failed') assert.equal(blockedResult.failure.code, 'privacy_blocked');
  assert.equal(calls, 0);
});

test('Controller sessions are continuous per run and isolated between runs', async () => {
  const sessions: Array<{ input: Parameters<PiTextCaller['createSession']>[0]; appended: string[] }> = [];
  const controller = new ControllerAgent({ host: new PiAgentHost(caller([JSON.stringify({ type: 'send', message: 'Continue.', intent: 'continue' }), JSON.stringify({ type: 'done', reason: 'satisfied' }), JSON.stringify({ type: 'done', reason: 'blocked' })], sessions)), timeoutMs: 50, maxRepairAttempts: 0 });
  await controller.decide(context());
  await controller.decide(context());
  await controller.decide({ ...context(), runId: 'run-2' });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.appended.length, 2);
});

test('Host executes only registered tools and redacts write contents from audit facts', async () => {
  const events: AgentAuditEvent[] = [];
  let written = '';
  const host = new PiAgentHost({ createSession: (input) => ({ append: async () => { const tool = input.tools[0]; if (!tool) throw new Error('missing tool'); await tool.execute({ path: 'safe.txt', content: 'secret text' }, new AbortController().signal); return JSON.stringify({ ok: true }); }, cancel() {} }) });
  const result = await host.request({ role: 'test', systemPrompt: 'test', context: {}, schema: Type.Object({ ok: Type.Boolean() }), timeoutMs: 50, maxRepairAttempts: 0, allowModelText: true, tools: [{ name: 'write', description: 'test write', parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (params) => { written = (params as { content: string }).content; return { content: 'ok' }; } }], audit: { append: async (event) => { events.push(event); } } });
  assert.equal(result.status, 'completed');
  assert.equal(written, 'secret text');
  assert.match(JSON.stringify(events), /byteLength/);
  assert.doesNotMatch(JSON.stringify(events), /secret text/);
});
