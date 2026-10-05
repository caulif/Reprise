import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { closeBoundedInvestigation } from '../../src/agents/comparison-investigation-closure.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import type { ComparisonFindingsSubmission } from '../../src/core/schema.js';
const context: ComparisonContext = { task: { caseId: 'case', summary: 'Compare' }, attemptId: 'attempt', baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
for (const mode of ['missing', 'invalid_refs', 'persist', 'audit', 'not_ready', 'cancel'] as const) test(`actual submitted entry stops before another model call when Host deadline closure has ${mode}`, async () => {
  let calls = 0, closures = 0, reviews = 0;
  const controller = new AbortController();
  const host = new AgentHost({ createSession: () => ({ append: async () => {
    calls++; assert.equal(calls, 1, 'failed Host closure cannot start paid findings, compose or review');
    return { status: 'yielded' as const, reason: 'bounded_investigation_timeout' };
  }, cancel() {} }) });
  const result = await new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: 0 }).compare(context, [], undefined, controller.signal, {
    getSubmittedResult: async () => undefined, findingsReady: () => false,
    onReviewStarted: () => { reviews++; },
    closeBoundedInvestigation: async boundary => {
      closures++; assert.equal(boundary.reason, 'bounded_investigation_timeout');
      if (mode === 'cancel') controller.abort();
      else if (mode !== 'not_ready') throw new Error(`Actual ${mode} callback failure`);
    },
  });
  assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(result));
  assert.equal(calls, 1); assert.equal(closures, 1); assert.equal(reviews, 0);
});

test('Host closure opt-in never converts other boundaries or failures into saved findings', async () => {
  let closures = 0;
  const options = { findingsReady: () => false, closeBoundedInvestigation: async () => { closures++; } };
  const outcomes = [
    { status: 'completed' as const, sessionId: 'session', value: {} },
    { status: 'yielded' as const, sessionId: 'session', reason: 'output_limit' },
    { status: 'yielded' as const, sessionId: 'session', reason: 'investigationMs' },
    { status: 'failed' as const, sessionId: 'session', failure: { code: 'invalid_output' as const, kind: 'protocol' as const, attempts: 1, message: 'Failed' } },
    { status: 'cancelled' as const, sessionId: 'session' },
  ];
  for (const outcome of outcomes) assert.equal(await closeBoundedInvestigation(options, outcome, new ComparisonResourceTracker({}), new AbortController().signal), outcome);
  const deadline = { status: 'yielded' as const, sessionId: 'session', reason: 'bounded_investigation_timeout' };
  assert.equal(await closeBoundedInvestigation({}, deadline, new ComparisonResourceTracker({}), new AbortController().signal), deadline, 'legacy without callback is unchanged');
  assert.equal(closures, 0);
  await assert.rejects(closeBoundedInvestigation(options, deadline, new ComparisonResourceTracker({ maxElapsedMs: 0 }), new AbortController().signal), /resource limit/);
  assert.equal(closures, 0, 'hard protection runs before the callback');
});

test('native actual deadline closes saved questions before compose and still requires independent actual findings update', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-native-host-closure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Not independently located' })),
    findings: [], importantLimitations: ['Quality remains unknown'], decisionQuestions: [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'Could change preference', status: 'pending', nextCheck: 'Inspect actual final', evidenceRefs: [] }] };
  const events: AgentAuditEvent[] = [], inputs: { messages: unknown[]; tools: { name: string }[] }[] = [];
  let authorDraft = false, material = false, formal = false, previewed = false, hostClosures = 0;
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const models = { getModel: () => model, streamSimple: (_model: unknown, actual: unknown, options: { signal: AbortSignal }) => {
    const input = actual as typeof inputs[number]; inputs.push({ messages: structuredClone(input.messages), tools: input.tools.map(tool => ({ name: tool.name })) });
    const index = inputs.length, stream = createAssistantMessageEventStream(); assert.ok(index <= 8);
    if (index === 2) options.signal.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: message([], 'aborted') }), { once: true });
    else {
      if (index === 3) {
        assert.match(JSON.stringify(input.messages), /Host may have marked saved pending questions unavailable/);
        assert.match(JSON.stringify(input.messages), /Host process boundary[\s\S]*unverified/);
        assert.equal(discovery.snapshot()!.submission.decisionQuestions[0]!.status, 'unavailable');
      }
      const name = index === 1 || index === 6 ? 'update_comparison_findings' : index === 3 ? 'submit_comparison_draft' : index === 5 || index === 7 ? 'inspect_comparison_draft' : index === 8 ? 'preview_report' : undefined;
      if (index === 6) assert.deepEqual(input.tools.map(tool => tool.name), ['update_comparison_findings']);
      const response = name ? message([{ type: 'toolCall', id: `call-${index}`, name, arguments: name === 'update_comparison_findings' ? index === 1 ? initial : discovery.snapshot()!.submission : {} }], 'toolUse')
        : message([{ type: 'text', text: 'Independent retained source observations; quality remains unknown' }], 'stop');
      stream.push({ type: 'done', reason: response.stopReason as 'toolUse' | 'stop', message: response });
    }
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [discovery.tool(), ...[
    { name: 'submit_comparison_draft', execute: async () => { authorDraft = true; return { content: 'status=accepted\nActual draft' }; } },
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual full current draft' }), onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual matching preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }))];
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 2_000, maxRepairAttempts: 0, resources: { investigationMs: 250 } }).compare(context, tools,
    { append: async event => { events.push(event); } }, undefined, {
      findingsReady: () => discovery.readyToCompose(), getFindingsState: () => discovery.state(), hasSavedFindings: () => !!discovery.snapshot(),
      closeBoundedInvestigation: async (_boundary, signal) => { hostClosures++; await discovery.closeAtInvestigationDeadline(signal); },
      hasAcceptedDraft: () => authorDraft, reviewFindings: true, hasReviewDraftMaterial: () => material,
      hasCurrentReviewInspection: () => formal, onDraftAuditStarted: () => { formal = false; },
      getSubmittedResult: async () => formal && previewed ? { status: 'completed', reportPath: 'report.html', headline: 'Conditional result', evidenceRefs: [] } : undefined,
    });
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(inputs.length, 8); assert.equal(hostClosures, 1);
  assert.equal(events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'findings').length, 0);
  assert.equal(events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'update_comparison_findings' && !event.payload.nativeHook).length, 2);
  assert.equal(events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings')!.payload.yieldReason, 'review_findings_ready');
  assert.match(JSON.stringify(inputs[7]!.messages), /Actual full current draft/);
});

