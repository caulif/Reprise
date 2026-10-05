import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ComparisonReviewFindingsClosure } from '../../src/agents/comparison-review-findings.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';

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
