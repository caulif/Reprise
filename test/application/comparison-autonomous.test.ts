import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AutonomousComparisonAgent } from '../../src/agents/comparison-autonomous.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import type { ComparisonContext, ComparisonResult } from '../../src/agents/comparison-contract.js';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { PiProviderAdapter, type PiModels } from '../../src/infrastructure/agent/providers/pi/adapter.js';
import { usagePricing } from '../../src/application/session-usage.js';

const context: ComparisonContext = {
  attemptId: 'attempt', task: { caseId: 'case', summary: 'Compare text deliveries.' },
  baseline: { summary: 'Baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [],
  allowModelText: true, replayScope: { historical: '', candidate: '' },
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
    delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } },
};
const report: ComparisonResult = { status: 'completed', reportPath: 'report.html', evidenceRefs: [] };

test('actual Pi retry wiring publishes a separately priced fallback and preserves returned usage totals', async () => {
  const model: Model<'openai-completions'> = { id: 'deepseek-v4.1-flash', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
    reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const events: AgentAuditEvent[] = [];
  let calls = 0;
  const models = { streamSimple: () => {
    const failed = calls++ === 0;
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: failed ? [] : [{ type: 'text', text: 'Report submitted.' }], stopReason: failed ? 'error' : 'stop',
      ...(failed ? { errorMessage: '502 Bad Gateway' } : {}), timestamp: Date.now(),
      usage: { input: failed ? 0 : 100, output: failed ? 0 : 10, cacheRead: 0, cacheWrite: 0, totalTokens: failed ? 0 : 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    if (failed) stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  }, getProviders: () => [], getModels: () => [], getModel: () => model, getAuth: () => undefined } as unknown as PiModels;
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost(new PiProviderAdapter({ models, model,
    config: { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: model.id, effort: 'low' } })) });
  const result = await agent.compare(context, [], { append: async event => { events.push(event); } }, undefined, {
    getSubmittedResult: async () => report,
    estimateUsageCost: payload => {
      const usage = payload.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
      return usagePricing({ parts: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreation: usage.cacheWrite },
        display: usage.totalTokens, inputIncludesCache: false }, String(payload.model));
    },
  });
  assert.equal(result.status, 'completed');
  const requests = events.filter(event => event.type === 'agent.model_request');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.payload.requestId, requests[1]!.payload.requestId);
  const estimate = events.find(event => event.type === 'agent.usage_estimated')!.payload;
  assert.equal(estimate.pricingModelId, model.id);
  assert.equal(estimate.pricingVersion, '2026-10-15-static-pricing');
  assert.deepEqual(estimate.rates, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheCreation: 0 });
  const summary = events.find(event => event.type === 'comparison.resources_completed')!.payload;
  assert.equal(summary.usageReports, 1);
  assert.equal(summary.fallbackRequests, 1);
  assert.equal(summary.costBasis, 'includes_fallback');
  assert.equal(summary.estimatedCostUsd, Number(summary.knownEstimatedCostUsd) + Number(summary.fallbackEstimatedCostUsd));
});

test('autonomous Comparison uses one prompt and leaves all tools available without findings or stage callbacks', async () => {
  let sessions = 0;
  let calls = 0;
  const used: string[] = [];
  const events: AgentAuditEvent[] = [];
  const names = ['read', 'shell_exec', 'write', 'submit_report', 'preview_report'];
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession(input) {
    sessions++;
    assert.match(input.systemPrompt, /no mandatory findings snapshots/);
    assert.match(input.systemPrompt, /History and Current/);
    assert.match(input.systemPrompt, /Host resolved model identity/);
    assert.match(input.systemPrompt, /Preserve original quotations verbatim/);
    assert.match(input.systemPrompt, /yield_time_ms bound one wait, not the process lifetime/);
    return { append: async ({ content, signal }) => {
      calls++;
      assert.match(content, /Compare text deliveries/);
      assert.match(content, /Total remaining session budget: \d+ ms/);
      assert.ok(content.indexOf('Task: Compare text deliveries.') < content.indexOf('Deliverable:'));
      assert.ok(content.indexOf('Deliverable:') < content.indexOf('Optional Host metrics'));
      for (const name of names) {
        const tool = input.tools.find(item => item.name === name)!;
        const result = await tool.execute({}, signal);
        assert.equal(result.content, name);
        assert.match(JSON.stringify(result.contentBlocks), /Host total-time budget remaining: \d+ ms/);
      }
      return '';
    }, cancel() {} };
  } }) });
  const result = await agent.compare(context, names.map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => { used.push(name); return { content: name }; } })), { append: async event => { events.push(event); } }, undefined,
  { getSubmittedResult: async () => report, onReviewStarted: () => { assert.fail('No separate reviewer'); },
    hasSavedFindings: () => { assert.fail('No mandatory findings'); }, enforcePhaseBoundaries: true });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(sessions, 1);
  assert.equal(calls, 1);
  assert.deepEqual(used, names);
  assert.ok(events.some(event => event.type === 'comparison.resources_completed'));
  assert.equal(events.at(-1)?.type, 'agent.session_completed');
  assert.ok(events.some(event => event.type === 'agent.tool_completed' && JSON.stringify(event.payload.body).includes('Host total-time budget remaining')));
  await agent.release('attempt');
});

for (const primary of ['provider', 'cancelled', 'publication'] as const) {
  test(`autonomous finalization retains ${primary}, resource audit and close failures`, async () => {
    const abort = new AbortController();
    let closes = 0;
    const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({
      append: async () => {
        if (primary === 'cancelled') abort.abort();
        if (primary === 'provider') throw Object.assign(new Error('Original upstream failure'), { status: 503 });
        return '';
      },
      cancel() { closes++; throw new Error('Session close failure'); },
    }) }) });
    await assert.rejects(agent.compare(context, [], { append: async event => {
      if (event.type === 'comparison.resources_completed') throw new Error('Resources audit failure');
    } }, abort.signal), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 3);
      const errors = error.errors as Error[];
      assert.match(errors[0]!.message, primary === 'provider' ? /Original upstream failure/ : primary === 'cancelled' ? /Comparison cancelled/ : /No current submitted/);
      assert.equal(errors[1]!.message, 'Resources audit failure');
      assert.equal(errors[2]!.message, 'Session close failure');
      return true;
    });
    assert.equal(closes, 1);
    await agent.release(context.attemptId);
    assert.equal(closes, 1, 'Outer release remains idempotent after finalization failure');
  });
}

test('autonomous attempt remains active through delayed failing finalization and clears afterward', async () => {
  let releaseAudit!: () => void;
  let auditStarted!: () => void;
  const started = new Promise<void>(resolve => { auditStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releaseAudit = resolve; });
  let sessions = 0;
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => {
    sessions++;
    return { append: async () => '', cancel() {} };
  } }) });
  const first = agent.compare(context, [], { append: async event => {
    if (event.type === 'comparison.resources_completed') {
      auditStarted();
      await blocked;
      throw new Error('Delayed finalization failure');
    }
  } });
  await started;
  await assert.rejects(agent.compare(context), /unique active attempt ID/);
  assert.equal(sessions, 1);
  releaseAudit();
  await assert.rejects(first, AggregateError);
  assert.equal((await agent.compare(context)).status, 'failed');
  assert.equal(sessions, 2, 'A completed failed finalization must not leave active state or reuse the closed Session');
});

test('autonomous finalization retains a thrown undefined primary cause', async () => {
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({ append: async () => '', cancel() {} }) }) });
  await assert.rejects(agent.compare(context, [], { append: async event => {
    if (event.type === 'comparison.resources_completed') throw new Error('Audit failed after undefined');
  } }, undefined, { getSubmittedResult: async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Inject a legal JavaScript throw value to verify error preservation.
    throw undefined;
  } }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], undefined);
    assert.equal((error.errors[1] as Error).message, 'Audit failed after undefined');
    return true;
  });
});

test('cancellation during asynchronous autonomous publication validation cannot return completed', async () => {
  const abort = new AbortController();
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0,
    host: new AgentHost({ createSession: () => ({ append: async () => '', cancel() {} }) }) });
  const result = await agent.compare(context, [], undefined, abort.signal, { getSubmittedResult: async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    abort.abort();
    return report;
  } });
  assert.equal(result.status, 'cancelled');
});

test('autonomous budget feedback respects a shorter invocation timeout and preserves structured tool results', async () => {
  const agent = new AutonomousComparisonAgent({ timeoutMs: 5000, host: new AgentHost({ createSession(input) {
    return { append: async ({ content, signal }) => {
      const initial = Number(/Total remaining session budget: (\d+) ms/.exec(content)?.[1]);
      assert.ok(initial > 0 && initial <= 5000);
      const result = await input.tools[0]!.execute({}, signal);
      assert.equal(result.content, '{"status":"ok"}');
      assert.deepEqual(result.contentBlocks?.[0], { type: 'text', text: '{"status":"ok"}' });
      const remaining = Number(/remaining: (\d+) ms/.exec(JSON.stringify(result.contentBlocks))?.[1]);
      assert.ok(remaining > 0 && remaining <= initial);
      return '';
    }, cancel() {} };
  } }) });
  assert.equal((await agent.compare(context, [{ name: 'read', description: 'read', parameters: Type.Object({}),
    execute: async () => ({ content: '{"status":"ok"}', contentBlocks: [{ type: 'text', text: '{"status":"ok"}' }] }) }],
  undefined, undefined, { getSubmittedResult: async () => report })).status, 'completed');
  await agent.release('attempt');
});

test('autonomous Comparison refuses missing publication and propagates cancellation and provider failure', async () => {
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({ append: async () => 'Done', cancel() {} }) }) });
  assert.equal((await agent.compare(context)).status, 'failed');
  await agent.release('attempt');
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await agent.compare(context, [], undefined, cancelled.signal)).status, 'cancelled');
  await agent.cancel('attempt');
  await agent.release('attempt');
  const failed = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({
    append: async () => { throw new Error('Provider unavailable'); }, cancel() {} }) }) });
  assert.equal((await failed.compare(context)).status, 'failed');
  await failed.release('attempt');
});
