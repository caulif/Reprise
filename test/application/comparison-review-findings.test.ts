import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ComparisonReviewFindingsClosure } from '../../src/agents/comparison-review-findings.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import type { ComparisonWorkPass } from '../../src/agents/comparison-invocation-boundaries.js';

test('expired findings closure stops once without inventing another actual model request or certifying saved readiness', async () => {
  let calls = 0;
  const closure = new ComparisonReviewFindingsClosure({ reviewFindings: true, enforcePhaseBoundaries: true,
    findingsReady: () => true, hasReviewDraftMaterial: () => true, getFindingsState: () => 'saved but not audited' });
  const result = await closure.run(async () => {
    calls++;
    return { status: 'yielded', sessionId: 'session', reason: 'bounded_source_timeout' };
  }, 'session', true);
  assert.equal(calls, 1);
  assert.equal(result?.status, 'failed');
  if (result?.status === 'failed') {
    assert.equal(result.failure.kind, 'timeout');
    assert.equal(result.failure.attempts, 0);
    assert.doesNotMatch(result.failure.message, /two actual calls/);
  }
});

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context: ComparisonContext = { task: { caseId: 'case', summary: 'Compare' }, attemptId: 'attempt', baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
function response(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse' | 'length' = 'stop'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const stop = () => response([{ type: 'text', text: 'Actual completed phase or promise only' }]);
const length = () => response([{ type: 'thinking', thinking: 'Unfinished private reasoning is not a saved finding' }], 'length');
const calls = (...names: string[]) => response(names.map((name, index) => ({ type: 'toolCall', name, id: `${name}-${index}`, arguments: { path: index === 1 ? 'unregistered' : 'registered' } })), 'toolUse');

for (const sourcePending of [false, true]) test(`direct independent source save ${sourcePending ? 'opens only one supplement' : 'skips redundant closure'} and retains full audit`, async () => {
  let ready = true, state = 'Old saved hypotheses', updates = 0, reads = 0, forbidden = 0, material = false, formal = false, previewed = false, audits = 0;
  const events: AgentAuditEvent[] = [], inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  const responses = [stop(), stop(), calls('write', 'preview_report', 'read', 'update_comparison_findings'), calls('inspect_comparison_draft'),
    ...(sourcePending ? [calls('read'), stop(), calls('update_comparison_findings')] : []),
    calls('inspect_comparison_draft'), calls('preview_report')];
  const models = { getModel: () => model, streamSimple: (_model: unknown, actual: unknown) => {
    const input = actual as typeof inputs[number]; inputs.push({ tools: input.tools.map(tool => ({ name: tool.name })), messages: structuredClone(input.messages) });
    const next = responses.shift(); assert.ok(next, 'direct source save must not open an unnecessary closure or extra supplement');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: next.stopReason as 'stop' | 'toolUse', message: next }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Source observation from the boundary-test fixture; no product semantic approval.' }; } },
    { name: 'write', execute: async () => { forbidden++; return { content: 'Unexpected write' }; } },
    { name: 'update_comparison_findings', execute: async () => { updates++; ready = !sourcePending || updates === 2; state = `Actual saved revision ${updates}: ${ready ? 'supported or unavailable' : 'original pending question with nextCheck'}`;
      formal = false; return { content: 'status=accepted\nActual current saved state' }; } },
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual current full draft fixture including the decisive unknown' }), onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { assert.equal(audits, 1, 'source save cannot bypass full audit'); previewed = true; return { content: 'Actual current matching preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({ path: Type.Optional(Type.String()) }) }));
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} }).compare(context, tools,
    { append: async event => { events.push(event); } }, new AbortController().signal, {
      enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => ready, getFindingsState: () => state,
      hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
      onDraftAuditStarted: () => { audits++; formal = false; },
      getSubmittedResult: async () => ready && formal && previewed ? { status: 'completed', reportPath: 'report.html', headline: 'Scoped fixture', evidenceRefs: [] } : undefined,
    });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(updates, sourcePending ? 2 : 1); assert.equal(reads, sourcePending ? 2 : 1); assert.equal(forbidden, 0); assert.equal(audits, 1);
  assert.equal(responses.length, 0);
  assert.ok(inputs[2]!.tools.some(tool => tool.name === 'update_comparison_findings'));
  assert.ok(inputs[2]!.tools.every(tool => !['write', 'preview_report', 'inspect_comparison_draft'].includes(tool.name)));
  assert.match(JSON.stringify(inputs[2]!.messages), /Current saved findings \(hypotheses only\)[\s\S]*Old saved hypotheses/);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.find(event => event.payload.pass === 'sources')!.payload.yieldReason, sourcePending ? 'independent_findings_pending' : 'independent_findings_ready');
  assert.equal(phases.filter(event => event.payload.pass === 'review-findings').length, sourcePending ? 1 : 0);
  assert.equal(phases.filter(event => event.payload.pass === 'review-supplement').length, sourcePending ? 1 : 0);
  assert.ok(phases.some(event => event.payload.pass === 'inspection')); assert.ok(phases.some(event => event.payload.pass === 'audit')); assert.ok(phases.some(event => event.payload.pass === 'preview'));
  assert.match(JSON.stringify(inputs.at(-1)!.messages), /Actual current full draft fixture/);
});

for (const mode of ['actual-ready', 'missing-getter', 'empty-state', 'changed-state', 'fake-receipt', 'no-update', 'unfinished-source'] as const) test(`direct source closure shortcut requires accepted current saved state: ${mode}`, async () => {
  let state = mode === 'empty-state' ? '' : 'Current actual snapshot', calls = 0;
  const closure = new ComparisonReviewFindingsClosure({ enforcePhaseBoundaries: true, reviewFindings: true,
    getSubmittedResult: async () => undefined, findingsReady: () => true, hasReviewDraftMaterial: () => true,
    ...(mode === 'missing-getter' ? {} : { getFindingsState: () => state }),
  });
  const [tool] = closure.bind([{ name: 'update_comparison_findings', description: 'update', parameters: Type.Object({}),
    execute: async () => ({ content: mode === 'fake-receipt' ? 'status=accepted_by_assumption' : 'status=accepted\nActual receipt' }) }], new ComparisonResourceTracker({}));
  closure.begin('sources');
  if (mode !== 'no-update') await tool!.execute({}, new AbortController().signal);
  if (mode === 'changed-state') state = 'A later binding changed the snapshot';
  closure.begin('inspection');
  const result = await closure.run(async (_phase, _prompt, pass) => {
    calls++; assert.equal(pass, 'review-findings'); closure.begin(pass);
    if (mode === 'fake-receipt') return { status: 'completed', sessionId: 'review', value: {} };
    await tool!.execute({}, new AbortController().signal);
    return { status: 'completed', sessionId: 'review', value: {} };
  }, 'review', true, mode !== 'unfinished-source');
  assert.equal(calls, mode === 'actual-ready' ? 0 : mode === 'fake-receipt' ? 2 : 1);
  assert.equal(result?.status, mode === 'fake-receipt' ? 'failed' : undefined);
});

test('direct source execute and completion guards reject hidden authoring and publication', async () => {
  let effects = 0;
  const closure = new ComparisonReviewFindingsClosure({ getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true, reviewFindings: true });
  const tools = closure.bind(['write', 'edit', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report'].map(name => ({
    name, description: name, parameters: Type.Object({}), execute: async () => { effects++; return { content: 'status=accepted' }; }, onCompleted: async () => { effects++; },
  })), new ComparisonResourceTracker({}));
  closure.begin('sources'); assert.deepEqual(closure.toolNames(tools), []);
  for (const tool of tools) {
    const result = await tool.execute({}, new AbortController().signal);
    assert.match(result.content, /source_review_not_ready/); await tool.onCompleted?.(result);
  }
  assert.equal(effects, 0);
});

for (const finalPending of [false, true]) test(`strict independent review opens one source supplement and ${finalPending ? 'rejects pending publication' : 'publishes only after actual audit'}`, async () => {
  let ready = true, updates = 0, material = false, formal = false, previewed = false, checks = 0, forbidden = 0;
  const events: AgentAuditEvent[] = [], inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  const responses = [stop(), stop(), stop(), calls('inspect_comparison_draft'), calls('update_comparison_findings'),
    calls('read', 'write', 'preview_report'), stop(), calls('update_comparison_findings'), calls('inspect_comparison_draft'), calls('preview_report')];
  const models = { getModel: () => model, streamSimple: (_model: unknown, actual: unknown) => {
    const current = actual as typeof inputs[number]; inputs.push({ tools: current.tools.map(tool => ({ name: tool.name })), messages: structuredClone(current.messages) });
    const next = responses.shift(); assert.ok(next, 'no extra model recovery is permitted');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: next.stopReason as 'stop' | 'toolUse', message: next }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { checks++; return { content: 'Actual source observation for the original pending question' }; } },
    { name: 'write', execute: async () => { forbidden++; return { content: 'Forbidden side effect' }; } },
    { name: 'update_comparison_findings', execute: async () => { updates++; ready = updates === 2 && !finalPending; formal = false; return { content: 'status=accepted\nActual revision changed' }; } },
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual latest bound draft with decisive limitation' }), onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual current matching preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({ path: Type.Optional(Type.String()) }) }));
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} }).compare(context, tools,
    { append: async event => { events.push(event); } }, new AbortController().signal, {
      enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => ready,
      getFindingsState: () => 'Original question, original decisionImpact; actual check remains unknown',
      hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
      onDraftAuditStarted: () => { formal = false; },
      getSubmittedResult: async () => ready && formal && previewed ? { status: 'completed', reportPath: 'report.html', headline: 'Conditional', evidenceRefs: [] } : undefined,
    });
  assert.equal(result.status, finalPending ? 'failed' : 'completed', JSON.stringify(result));
  assert.equal(updates, 2); assert.equal(checks, 1); assert.equal(forbidden, 0); assert.equal(previewed, !finalPending);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.filter(event => event.payload.pass === 'review-supplement').length, 1);
  assert.equal(phases.find(event => event.payload.pass === 'review-findings')!.payload.yieldReason, 'review_findings_pending');
  assert.deepEqual(inputs[5]!.tools.map(tool => tool.name), ['read']);
  assert.match(JSON.stringify(inputs[7]!.messages), /final bounded findings closure/);
  if (!finalPending) {
    assert.match(JSON.stringify(inputs.at(-1)!.messages), /Actual latest bound draft/);
    assert.ok(phases.find(event => event.payload.pass === 'audit'));
  }
});

test('supplement execute and completion guards reject hidden publication side effects', async () => {
  let effects = 0;
  const closure = new ComparisonReviewFindingsClosure({ enforcePhaseBoundaries: true, reviewFindings: true });
  const tools = closure.bind(['write', 'edit', 'update_comparison_findings', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report'].map(name => ({
    name, description: name, parameters: Type.Object({}), execute: async () => { effects++; return { content: 'status=accepted' }; }, onCompleted: async () => { effects++; },
  })), new ComparisonResourceTracker({}));
  closure.begin('review-supplement'); assert.deepEqual(closure.toolNames(tools), []);
  for (const tool of tools) {
    const result = await tool.execute({}, new AbortController().signal);
    assert.match(result.content, /review_supplement_only/); await tool.onCompleted?.(result);
  }
  assert.equal(effects, 0);
});

test('supplement cancellation and actual source persistence errors stay fatal', async () => {
  for (const cancelled of [false, true]) {
    let ready = false, passes = 0;
    const controller = new AbortController();
    const closure = new ComparisonReviewFindingsClosure({ enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => ready, hasReviewDraftMaterial: () => true });
    const tools = closure.bind([{ name: 'update_comparison_findings', description: 'update', parameters: Type.Object({}), execute: async () => ({ content: 'status=accepted' }) },
      { name: 'register_evidence', description: 'register', parameters: Type.Object({}), execute: async () => { throw new Error('Actual persistence failure'); } }], new ComparisonResourceTracker({}));
    const work = async (_phase: 'review', _prompt: string, pass?: ComparisonWorkPass) => {
      passes++; closure.begin(pass);
      if (pass === 'review-findings') { await tools[0]!.execute({}, controller.signal); return { status: 'yielded' as const, sessionId: 'review', reason: 'review_findings_pending' }; }
      if (cancelled) { controller.abort(); return { status: 'cancelled' as const, sessionId: 'review' }; }
      await tools[1]!.execute({}, controller.signal); ready = true;
      return { status: 'completed' as const, sessionId: 'review', value: {} };
    };
    if (cancelled) assert.equal((await closure.run(work, 'review', true))?.status, 'cancelled');
    else await assert.rejects(closure.run(work, 'review', true), /Actual persistence failure/);
    assert.equal(passes, 2, 'no final update after cancellation or persistence failure');
  }
});

for (const reason of ['bounded_audit_timeout', 'output_limit']) test(`strict incomplete audit ${reason} cannot publish an inspected draft`, async () => {
  let material = false, formal = false, previews = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ allowedToolNames, signal }) => {
    if (allowedToolNames?.length === 1 && allowedToolNames[0] === 'inspect_comparison_draft') { material = true; formal = true; }
    else if (allowedToolNames?.length === 1 && allowedToolNames[0] === 'update_comparison_findings') await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal);
    else if (allowedToolNames?.includes('inspect_comparison_draft')) { formal = true; return { status: 'yielded' as const, reason }; }
    return 'Actual turn';
  }, cancel() {} }) });
  const result = await new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} }).compare(context, [
    { name: 'update_comparison_findings', description: 'update', parameters: Type.Object({}), execute: async () => ({ content: 'status=accepted' }) },
    { name: 'inspect_comparison_draft', description: 'inspect', parameters: Type.Object({}), execute: async () => ({ content: 'Actual draft' }) },
    { name: 'preview_report', description: 'preview', parameters: Type.Object({}), execute: async () => { previews++; return { content: 'Preview' }; } },
  ], undefined, undefined, { enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => true,
    hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal, onDraftAuditStarted: () => { formal = false; },
    getSubmittedResult: async () => formal && previews ? { status: 'completed', reportPath: 'report.html', evidenceRefs: [] } : undefined });
  assert.equal(result.status, 'failed', JSON.stringify(result)); assert.equal(previews, 0);
});

for (const mode of ['success', 'late', 'length', 'repeat_length', 'length_after_update', 'verbal', 'rejected', 'malformed', 'cancel', 'hard', 'provider', 'usage_audit', 'legacy'] as const) test(`native independent findings closure preserves ${mode} boundaries`, async () => {
  const events: AgentAuditEvent[] = [], inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  const controller = new AbortController();
  let material = false, formal = false, previewed = false, updates = 0, reads = 0, forbiddenEffects = 0, auditStarts = 0;
  const closure = mode === 'length' ? [length(), calls('update_comparison_findings')]
    : mode === 'repeat_length' ? [length(), length()]
    : mode === 'length_after_update' ? [calls('update_comparison_findings'), length(), calls('update_comparison_findings')]
    : mode === 'verbal' || mode === 'late' ? [stop(), ...(mode === 'late' ? [calls('update_comparison_findings')] : [stop()])]
    : mode === 'rejected' || mode === 'malformed' ? [calls('update_comparison_findings'), stop(), calls('update_comparison_findings'), stop()]
    : mode === 'legacy' ? [] : [calls('read', 'read', 'update_comparison_findings', 'shell_exec', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report')];
  const responses = [stop(), stop(), stop(), calls('inspect_comparison_draft'), ...closure, calls('inspect_comparison_draft'), calls('preview_report')];
  const models = { getModel: () => model, streamSimple: (_model: unknown, actual: unknown) => {
    const current = actual as typeof inputs[number]; inputs.push({ tools: current.tools.map(tool => ({ name: tool.name })), messages: structuredClone(current.messages) });
    if (inputs.length === 5 && mode === 'provider') throw Object.assign(new Error('Actual closure upstream failure'), { status: 503 });
    const next = responses.shift(); if (!next) throw new Error('Unexpected extra generation');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: next.stopReason as 'stop' | 'toolUse' | 'length', message: next }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Actual registered repair page' }; } },
    ...['shell_exec', 'submit_comparison_draft'].map(name => ({ name, execute: async () => { forbiddenEffects++; return { content: 'Forbidden closure effect' }; } })),
    { name: 'update_comparison_findings', execute: async () => { updates++; if (mode === 'cancel') controller.abort(); return {
      content: mode === 'rejected' ? 'status=rejected\ncode=invalid_findings' : mode === 'malformed' ? 'status=accepted_by_assumption' : 'status=accepted\nSame valid snapshot, unchanged revision=1',
    }; } },
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual full accepted draft' }), onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual matching digest preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({ path: Type.Optional(Type.String()) }) }));
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0,
    resources: mode === 'hard' ? { maxModelRequests: 4 } : {} }).compare(context, tools, { append: async event => {
      events.push(event); if (mode === 'usage_audit' && event.type === 'agent.usage_reported' && inputs.length === 5) throw new Error('Actual closure usage audit failure');
    } }, controller.signal, {
      reviewFindings: mode !== 'legacy', findingsReady: () => mode !== 'length_after_update' || updates !== 1, getFindingsState: () => 'Old ready snapshot is a hypothesis, unchecked relationship unavailable',
      hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
      onDraftAuditStarted: () => { auditStarts++; formal = false; },
      isRepairRead: async params => (params as { path?: string }).path === 'registered',
      getSubmittedResult: async () => formal && previewed ? { status: 'completed', reportPath: 'report.html', headline: 'Conditional result', evidenceRefs: [] } : undefined,
    });
  const closurePhases = events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings');
  if (mode === 'success' || mode === 'late' || mode === 'length' || mode === 'length_after_update' || mode === 'legacy') {
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(updates, mode === 'legacy' ? 0 : mode === 'length_after_update' ? 2 : 1); assert.equal(auditStarts, 1);
    assert.equal(closurePhases.length, mode === 'legacy' ? 0 : mode === 'late' || mode === 'length' || mode === 'length_after_update' ? 2 : 1);
    if (mode !== 'legacy') assert.equal(closurePhases.at(-1)!.payload.yieldReason, 'review_findings_ready');
    assert.equal(events.filter(event => event.type === 'agent.session_started').length, 2);
    assert.deepEqual(inputs.at(-1)!.tools.map(tool => tool.name), ['preview_report']);
    assert.match(JSON.stringify(inputs.at(-1)!.messages), /Actual full accepted draft/);
    const auditInput = inputs.at(-2)!; assert.ok(auditInput.tools.some(tool => tool.name === 'update_comparison_findings'), 'full audit retains lawful findings repairs');
    assert.ok(!auditInput.tools.some(tool => tool.name === 'preview_report'));
  } else {
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(result)); assert.equal(auditStarts, 0); assert.equal(previewed, false);
    if (mode === 'verbal' || mode === 'repeat_length' || mode === 'rejected' || mode === 'malformed') { assert.equal(closurePhases.length, 2); assert.equal(updates, mode === 'verbal' || mode === 'repeat_length' ? 0 : 2); }
    assert.ok(!closurePhases.some(event => event.payload.yieldReason === 'review_findings_ready'), 'old ready state or rejected receipts cannot satisfy actual review findings update');
  }
  if (mode !== 'legacy' && mode !== 'hard') {
    assert.deepEqual(inputs[4]!.tools.map(tool => tool.name), ['read', 'update_comparison_findings']);
    assert.match(JSON.stringify(inputs[4]!.messages), /Current saved findings \(hypotheses only\)[\s\S]*Old ready snapshot/);
  }
  assert.equal(forbiddenEffects, 0);
  if (mode === 'length' || mode === 'length_after_update' || mode === 'repeat_length') {
    assert.equal(closurePhases[0]!.payload.yieldReason, 'output_limit');
    assert.ok(inputs[5]!.tools.every(tool => ['read', 'update_comparison_findings'].includes(tool.name)), 'length remains in the same narrow closure, without restarting audit');
    if (mode === 'repeat_length') assert.equal(inputs.length, 6, 'two truncated closure invocations cannot expand to a third');
  }
  assert.equal(reads, mode === 'success' || mode === 'cancel' ? 1 : 0, 'only the strictly registered repair page can execute');
});

test('an adapter ignoring closure exposure cannot execute arbitrary reads or expanded tools', async () => {
  let effects = 0;
  const closure = new ComparisonReviewFindingsClosure({ reviewFindings: true, findingsReady: () => true, isRepairRead: async () => false });
  const resources = new ComparisonResourceTracker({}); resources.phase('review');
  const tools = closure.bind(['read', 'write', 'edit', 'shell_exec', 'ls', 'grep', 'render_artifact', 'register_evidence', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report', 'update_comparison_findings'].map(name => ({
    name, description: name, parameters: Type.Object({}), execute: async () => { effects++; return { content: 'status=accepted\nActual accepted receipt' }; },
  })), resources);
  closure.begin('review-findings'); assert.equal(closure.ready(), false, 'old ready state alone is insufficient');
  for (const tool of tools.filter(tool => tool.name !== 'update_comparison_findings')) assert.match((await tool.execute({}, new AbortController().signal)).content, /review_findings_only/);
  assert.equal(effects, 0);
  await tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, new AbortController().signal);
  assert.equal(effects, 1); assert.equal(closure.ready(), true);
  closure.begin('review-findings'); assert.equal(closure.ready(), false, 'a second invocation cannot inherit accepted execution from the first');
  closure.begin('audit'); await tools.find(tool => tool.name === 'write')!.execute({}, new AbortController().signal);
  assert.equal(effects, 2, 'full audit keeps its lawful repair tool surface');
});

test('an adapter returning output limit after actual accepted-ready updates cannot start audit', async () => {
  let material = false, updates = 0, auditStarts = 0, previews = 0, closureCalls = 0;
  const events: AgentAuditEvent[] = [];
  const tools = [
    { name: 'update_comparison_findings', execute: async () => { updates++; return { content: 'status=accepted\nActual ready snapshot' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { material = true; return { content: 'Actual draft material' }; } },
    { name: 'preview_report', execute: async () => { previews++; return { content: 'Unexpected preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, allowedToolNames }) => {
    if (content.includes('This is the actual draft inspection checkpoint')) await input.tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
    if (content.includes('This is the independent review findings closure')) {
      closureCalls++; assert.deepEqual(allowedToolNames, ['update_comparison_findings']);
      assert.match((await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal)).content, /^status=accepted\n/);
      return { status: 'yielded' as const, reason: 'output_limit' };
    }
    return '';
  }, cancel() {} }) });
  const result = await new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0 }).compare(context, tools,
    { append: async event => { events.push(event); } }, new AbortController().signal, {
      reviewFindings: true, findingsReady: () => true, hasReviewDraftMaterial: () => material,
      onDraftAuditStarted: () => { auditStarts++; },
      getSubmittedResult: async () => undefined,
    });
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(closureCalls, 2); assert.equal(updates, 2); assert.equal(auditStarts, 0); assert.equal(previews, 0);
  const phases = events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings');
  assert.equal(phases.length, 2); assert.ok(phases.every(event => event.payload.yieldReason === 'output_limit'));
});
