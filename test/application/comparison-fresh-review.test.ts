import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import type { ProviderAdapter } from '../../src/infrastructure/agent/types.js';
import { sha256 } from '../../src/core/identity.js';
import { Type } from '@sinclair/typebox';

const context: ComparisonContext = {
  task: { caseId: 'case-1', summary: 'Compare originals.' }, attemptId: 'attempt-1',
  promptContent: 'Frozen navigation: INDEX.md and briefing/decision-map.md',
  baseline: { summary: 'Baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'baseline', candidate: 'candidate' },
  reportFacts: { run: { runId: 'run-1', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } },
};
const value = { status: 'completed' as const, reportPath: 'report.html' as const, headline: 'A scoped difference', evidenceRefs: [] };
type Input = Parameters<ProviderAdapter['createSession']>[0];
function fixture(action?: (session: number, content: string, input: Input, signal: AbortSignal) => Promise<string>) {
  const events: AgentAuditEvent[] = [];
  const sessions: { sessionId: string; messages: string[]; cancelled: number }[] = [];
  let completedRequests = 0;
  const host = new AgentHost({ createSession: input => {
    const index = sessions.length;
    const state = { sessionId: input.sessionId, messages: [] as string[], cancelled: 0 };
    sessions.push(state);
    return { append: async ({ content, signal }) => {
      state.messages.push(content);
      await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: state.messages.length, images: [] });
      completedRequests++;
      const result = action ? await action(index, content, input, signal) : 'done';
      await input.onModelUsage?.({ model: 'fixture', scope: 'generation', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
      return result;
    }, cancel: () => { state.cancelled++; } };
  } });
  return { host, sessions, events, audit: { append: async (event: AgentAuditEvent) => { events.push(event); } },
    completedRequests: () => completedRequests };
}

test('draft review uses fresh conversation and repair keeps that session with one shared attempt audit', async () => {
  const f = fixture();
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0 });
  let checked = 0;
  const started: string[] = [];
  const result = await agent.compare(context, [], f.audit, undefined, {
    getSubmittedResult: async () => ++checked === 1 ? undefined : value,
    onReviewStarted: sessionId => {
      assert.equal(f.sessions.at(-1)?.messages.length, 0);
      started.push(sessionId);
    },
    getFindingsState: () => 'Unverified earlier conclusion', getSubmissionState: () => 'Needs preview',
  });
  assert.equal(result.status, 'completed');
  assert.equal(f.sessions.length, 2);
  assert.deepEqual(started, [f.sessions[1]!.sessionId]);
  assert.equal(f.sessions[0]!.messages.length, 2);
  assert.match(f.sessions[0]!.messages[1]!, /Unverified earlier conclusion/);
  assert.equal(f.sessions[1]!.messages.length, 3);
  const firstReview = f.sessions[1]!.messages[0]!;
  assert.match(firstReview, /independent source pass/);
  assert.match(firstReview, /Frozen navigation/);
  assert.match(firstReview, /Read the original task.*briefing\/task\/initial-input\.txt/);
  assert.match(firstReview, /briefing\/decision-map\.md/);
  assert.match(firstReview, /actual delivered output/);
  assert.match(firstReview, /counterexample/);
  assert.doesNotMatch(firstReview, /[Ii]nspect the current accepted draft/);
  for (const prompt of f.sessions[1]!.messages) assert.doesNotMatch(prompt, /Unverified earlier conclusion/);
  assert.doesNotMatch(firstReview, /Current phase: (?:investigate|compose)/);
  assert.match(f.sessions[1]!.messages[1]!, /Now inspect the current accepted draft/);
  assert.match(f.sessions[1]!.messages[2]!, /Continue the current review turn/);
  assert.equal(result.sessionId, f.sessions[1]!.sessionId);
  assert.equal(f.sessions[0]!.cancelled, 1);
  assert.equal(f.sessions[1]!.cancelled, 0);
  const completion = f.events.find(event => event.type === 'comparison.resources_completed')!;
  assert.equal(completion.payload.modelRequests, 5);
  assert.equal(completion.payload.usageReports, 5);
  assert.equal(f.events.filter(event => event.type === 'agent.session_started').length, 2);
  await agent.release(context.attemptId);
  assert.equal(f.sessions[1]!.cancelled, 1);
});

test('fresh review does not reset the attempt model request budget', async () => {
  const f = fixture();
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxModelRequests: 2 } });
  const result = await agent.compare(context, [], f.audit, undefined, { getSubmittedResult: async () => value });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.match(result.failure.message, /maxModelRequests/);
  assert.equal(f.completedRequests(), 2);
  assert.equal(f.events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 2);
});

test('fresh review does not reset the attempt tool budget', async () => {
  let executed = 0;
  const f = fixture(async (_session, _content, input, signal) => {
    await input.tools[0]!.execute({}, signal);
    return 'done';
  });
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxToolCalls: 2 } });
  const result = await agent.compare(context, [{ name: 'read', description: 'read', parameters: Type.Object({}),
    execute: async () => { executed++; return { content: 'source' }; } }], f.audit, undefined, { getSubmittedResult: async () => value });
  assert.equal(result.status, 'failed');
  assert.equal(executed, 2);
  if (result.status === 'failed') assert.equal(result.failure.kind, 'tool');
  assert.match(String(f.events.find(event => event.type === 'agent.tool_failed')?.payload.message), /maxToolCalls/);
  assert.equal(f.events.find(event => event.type === 'comparison.resources_completed')!.payload.toolCalls, 3);
});

test('compose spending and elapsed time remain charged before fresh review', async t => {
  const cost = fixture();
  const pricedAgent = new ComparisonAgent({ host: cost.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxEstimatedCostUsd: 0.5 } });
  await assert.rejects(pricedAgent.compare(context, [], cost.audit, undefined, {
    getSubmittedResult: async () => value, estimateUsageCost: () => 0.3,
  }), /maxEstimatedCostUsd/);
  assert.equal(cost.completedRequests(), 2);
  assert.equal(cost.sessions.length, 1);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const timed = fixture(async () => { t.mock.timers.tick(20); return 'done'; });
  const timedAgent = new ComparisonAgent({ host: timed.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxElapsedMs: 25 } });
  await assert.rejects(timedAgent.compare(context, [], timed.audit, undefined, { getSubmittedResult: async () => value }), /maxElapsedMs/);
  assert.equal(timed.sessions.length, 1);
  assert.equal(timed.events.find(event => event.type === 'comparison.resources_completed')!.payload.elapsedMs, 40);
  await pricedAgent.release(context.attemptId);
  await timedAgent.release(context.attemptId);
});

test('cancel targets the active fresh review session', async () => {
  let entered!: () => void;
  const reviewing = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(async (session, _content, _input, signal) => {
    if (session === 0) return 'done';
    entered();
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0 });
  const pending = agent.compare(context, [], f.audit, undefined, { getSubmittedResult: async () => value });
  await reviewing;
  await agent.cancel(context.attemptId, 'stop-review');
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.sessionId, f.sessions[1]!.sessionId);
  assert.equal(f.sessions[1]!.cancelled, 1);
  assert.equal(f.sessions[1]!.messages.length, 1);
  assert.match(f.sessions[1]!.messages[0]!, /independent source pass/);
});

test('source review reads originals before draft and rejects all three draft tools until the next pass', async () => {
  const execution: string[] = [];
  const denied: string[] = [];
  const f = fixture(async (session, prompt, input, signal) => {
    if (session === 0) return 'done';
    if (prompt.includes('This is the independent source pass')) {
      for (const path of ['briefing/task/initial-input.txt', 'finals/original.txt', 'candidate/original.txt']) {
        await input.tools.find(tool => tool.name === 'read')!.execute({ path }, signal);
      }
      for (const name of ['inspect_comparison_draft', 'submit_comparison_draft', 'preview_report']) {
        denied.push((await input.tools.find(tool => tool.name === name)!.execute({}, signal)).content);
      }
    } else {
      for (const name of ['inspect_comparison_draft', 'submit_comparison_draft', 'preview_report']) {
        await input.tools.find(tool => tool.name === name)!.execute({}, signal);
      }
    }
    return 'done';
  });
  const tools = ['read', 'inspect_comparison_draft', 'submit_comparison_draft', 'preview_report'].map(name => ({
    name, description: name, parameters: Type.Object({}), execute: async (params: unknown) => {
      execution.push(name === 'read' ? `read:${(params as { path: string }).path}` : name);
      return { content: name === 'submit_comparison_draft' ? 'status=accepted' : 'available' };
    },
  }));
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0 });
  assert.equal((await agent.compare(context, tools, f.audit, undefined, {
    enforcePhaseBoundaries: true, getSubmittedResult: async () => value,
  })).status, 'completed');
  assert.deepEqual(execution, ['read:briefing/task/initial-input.txt', 'read:finals/original.txt', 'read:candidate/original.txt',
    'inspect_comparison_draft', 'submit_comparison_draft', 'preview_report']);
  assert.equal(denied.length, 3);
  for (const content of denied) assert.equal((JSON.parse(content) as { code: string }).code, 'source_review_not_ready');
  assert.equal(f.sessions.length, 2);
  assert.equal(f.sessions[1]!.messages.length, 2);
  const reviews = f.events.filter(event => event.type === 'comparison.phase_completed' && event.payload.phase === 'review');
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map(event => (event.payload.resources as { modelRequests: number }).modelRequests), [3, 4]);
  await agent.release(context.attemptId);
});

test('source-pass provider failure never enters draft audit or reads a submitted result', async () => {
  const f = fixture(async (session) => { if (session === 1) throw new Error('Source audit failed'); return 'done'; });
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0 });
  let submittedChecks = 0;
  const result = await agent.compare(context, [], f.audit, undefined, {
    getSubmittedResult: async () => { submittedChecks++; return value; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(submittedChecks, 0);
  assert.equal(f.sessions[1]!.messages.length, 1);
  assert.match(f.sessions[1]!.messages[0]!, /independent source pass/);
});

test('source and draft passes share the same request and tool limits', async () => {
  const f = fixture();
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxModelRequests: 3 } });
  const result = await agent.compare(context, [], f.audit, undefined, { getSubmittedResult: async () => value });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.match(result.failure.message, /maxModelRequests/);
  assert.equal(f.completedRequests(), 3);
  assert.equal(f.events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 3);
  const toolFixture = fixture(async (_session, _prompt, input, signal) => { await input.tools[0]!.execute({}, signal); return 'done'; });
  let reads = 0;
  const toolAgent = new ComparisonAgent({ host: toolFixture.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxToolCalls: 3 } });
  const toolResult = await toolAgent.compare(context, [{ name: 'write', description: 'write', parameters: Type.Object({}),
    execute: async () => { reads++; return { content: 'source' }; } }], toolFixture.audit, undefined, { getSubmittedResult: async () => value });
  assert.equal(toolResult.status, 'failed');
  assert.equal(reads, 3);
  assert.equal(toolFixture.events.find(event => event.type === 'comparison.resources_completed')!.payload.toolCalls, 4);
});

test('a source-pass time limit asks for a scoped return before the Host enables draft audit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let feedback = '';
  let reads = 0;
  const f = fixture(async (session, prompt, input, signal) => {
    if (session === 1 && prompt.includes('This is the independent source pass')) {
      t.mock.timers.tick(10);
      feedback = (await input.tools[0]!.execute({}, signal)).content;
    }
    return 'done';
  });
  const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0, resources: { investigationMs: 10 } });
  const result = await agent.compare(context, [{ name: 'read', description: 'read', parameters: Type.Object({}),
    execute: async () => { reads++; return { content: 'source' }; } }], f.audit, undefined, { getSubmittedResult: async () => value });
  assert.equal(result.status, 'completed');
  assert.equal(reads, 0);
  const receipt = JSON.parse(feedback) as { status: string; reason: string; message: string };
  assert.equal(receipt.status, 'source_review_limit');
  assert.equal(receipt.reason, 'reviewMs');
  assert.match(receipt.message, /Return your independently supported observations/);
  assert.match(receipt.message, /Host starts draft audit next/);
  assert.equal(f.sessions[1]!.messages.length, 2);
  await agent.release(context.attemptId);
});

test('compose failure never creates a fresh review session and legacy remains one session', async () => {
  let calls = 0;
  const failure = fixture(async () => { if (++calls === 2) throw new Error('Compose failed'); return 'done'; });
  const failedAgent = new ComparisonAgent({ host: failure.host, timeoutMs: 0, maxRepairAttempts: 0 });
  assert.equal((await failedAgent.compare(context, [], failure.audit, undefined, { getSubmittedResult: async () => value })).status, 'failed');
  assert.equal(failure.sessions.length, 1);
  const legacy = fixture(async () => JSON.stringify({ status: 'completed', headline: 'Difference', evidenceRefs: [] }));
  const legacyAgent = new ComparisonAgent({ host: legacy.host, timeoutMs: 0, maxRepairAttempts: 0 });
  assert.equal((await legacyAgent.compare(context, [], legacy.audit)).status, 'completed');
  assert.equal(legacy.sessions.length, 1);
  assert.equal(legacy.sessions[0]!.messages.length, 4);
  await legacyAgent.release(context.attemptId);
});

test('cancel and release during old-session close prevent a new paid review', async () => {
  for (const action of ['cancel', 'release'] as const) {
    let enteredClose!: () => void;
    const closeStarted = new Promise<void>(resolve => { enteredClose = resolve; });
    let finishClose!: () => void;
    const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
    const f = fixture();
    const agent = new ComparisonAgent({ host: f.host, timeoutMs: 0, maxRepairAttempts: 0 });
    const comparing = agent.compare(context, [], { append: async event => {
      f.events.push(event);
      if (event.type === 'agent.session_completed') { enteredClose(); await closeGate; }
    } }, undefined, { getSubmittedResult: async () => value });
    await closeStarted;
    await assert.rejects(agent.compare(context), /already active/);
    await agent[action](context.attemptId);
    finishClose();
    assert.equal((await comparing).status, 'cancelled');
    assert.equal(f.sessions.length, 1);
    assert.equal(f.completedRequests(), 2);
    const completion = f.events.find(event => event.type === 'comparison.resources_completed')!;
    assert.equal(completion.payload.modelRequests, 2);
    const next = await agent.compare(context, [], f.audit, undefined, { getSubmittedResult: async () => value });
    assert.equal(next.status, 'completed');
    await agent.release(context.attemptId);
  }
});

test('failed session creation clears the active attempt cancellation lifetime', async () => {
  const f = fixture();
  let first = true;
  const host = new AgentHost({ createSession: () => {
    if (first) { first = false; throw new Error('Session initialization failed'); }
    return { append: async () => 'done', cancel() {} };
  } });
  const agent = new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: 0 });
  const failed = await agent.compare(context);
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed') assert.match(failed.failure.message, /Session initialization failed/);
  assert.equal((await agent.compare(context, [], f.audit, undefined, { getSubmittedResult: async () => value })).status, 'completed');
  await agent.release(context.attemptId);
});
