import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, COMPARISON_SOURCE_REVIEW_PROMPT, COMPARISON_TURN_PROMPTS, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { composeComparisonAuthorSystemPrompt, COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { parseCommittedEventLog, reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import type { ComparisonFindingsDelta, ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { sha256 } from '../../src/core/identity.js';
import { isRecord } from '../../src/core/json.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context: ComparisonContext = { attemptId: 'fresh-author', task: { caseId: 'case', summary: 'TASK_SOURCE_REQUIRED' }, promptContent: 'TASK_SOURCE_REQUIRED: use the frozen evidence ev-1.', baseline: { summary: 'Historical output', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true, replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' }, metrics: { baseline: { elapsedMs: 100, costUsd: .4 }, candidate: { elapsedMs: 400, costUsd: .08 } } } };
function response(tool?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: tool ? [{ type: 'toolCall', id: `${tool}-${Date.now()}`, name: tool, arguments: {} }] : [{ type: 'text', text: 'Actual completed turn' }], stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function call(name: string, args: unknown): AssistantMessage {
  const result = response(name); result.content = [{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> }]; return result;
}
function actualInput(actual: Context): Context {
  return JSON.parse(JSON.stringify({ systemPrompt: actual.systemPrompt, messages: actual.messages,
    tools: actual.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) })) as Context;
}

test('author role is short, localized and does not inherit investigation or envelope instructions', () => {
  const zh = composeComparisonAuthorSystemPrompt('zh'), en = composeComparisonAuthorSystemPrompt('en');
  assert.ok(zh.length < 1800); assert.match(zh, /Simplified Chinese/); assert.match(en, /Report prose.*English/);
  for (const text of [zh, en]) {
    assert.match(text, /provisional report|hypotheses pending independent review/);
    assert.match(text, /insufficient_evidence.*undetermined/); assert.match(text, /accepted draft ends your author turn immediately/);
    assert.doesNotMatch(text, /orientAndInvestigate|shell_exec|render_artifact|register_evidence|Return.*JSON|Final JSON|find and investigate/i);
  }
});

test('production fresh author submits recorded hypotheses then independently updates, inspects and publishes actual report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-production-fresh-author-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# actual fixture output\n');
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final remains unchecked' })), findings: [], importantLimitations: ['Quality remains unverified'], decisionQuestions: [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'SAVED_PROVISIONAL_FINDING could change model preference', status: 'unavailable', evidenceRefs: [], resolution: 'No final quality check' }] };
  const draft = { status: 'insufficient_evidence', decisionShape: 'single_difference', category: 'Results', headline: 'Quality remains unverified.', decisionSummary: 'The usefulness of both final outputs remains unknown.', decisionBoundary: 'Final quality could change model preference.', decisionBasis: [], conclusionScope: 'undetermined', findingDispositions: [], comparisonHtml: '<p>No supported replacement choice.</p>' };
  const seen: Context[] = []; let investigations = 0;
  const models = { getModel: () => model, streamSimple: (_: unknown, actual: Context) => {
    seen.push(actualInput(actual)); const content = actual.messages.filter(m => m.role === 'user').at(-1)!.content;
    const prompt = typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    let turn: AssistantMessage;
    if (prompt.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) turn = call('update_comparison_findings', { ...initial,
      decisionQuestions: initial.decisionQuestions.map(({ resolution: _resolution, ...question }) => ({ ...question, status: 'pending', nextCheck: 'Inspect final sources before any quality verdict.' })) });
    else if (prompt.includes(COMPARISON_TURN_PROMPTS.orientAndInvestigate)) {
      investigations++;
      if (investigations === 1) turn = call('write', { path: 'scratch/investigation.txt', content: 'RAW_INVESTIGATION_ONLY_SENTINEL ' + 'x'.repeat(12000) });
      else if (investigations === 2) turn = call('read', { path: 'scratch/investigation.txt' });
      else if (investigations === 3) { assert.match(JSON.stringify(actual.messages), /RAW_INVESTIGATION_ONLY_SENTINEL/); turn = call('update_comparison_findings', initial); }
      else { assert.equal(investigations, 4); turn = response(); }
    } else if (prompt.includes(COMPARISON_TURN_PROMPTS.compose) || prompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) {
      assert.match(actual.systemPrompt!, /short provisional report/); assert.doesNotMatch(JSON.stringify(actual), /RAW_INVESTIGATION_ONLY_SENTINEL/);
      assert.match(prompt, /SAVED_PROVISIONAL_FINDING/); turn = call('submit_comparison_draft', draft);
    } else if (prompt.includes(COMPARISON_SOURCE_REVIEW_PROMPT)) {
      assert.doesNotMatch(JSON.stringify(actual), /RAW_INVESTIGATION_ONLY_SENTINEL|SAVED_PROVISIONAL_FINDING|No supported replacement choice/); turn = response();
    } else if (prompt.includes('This is the actual draft inspection checkpoint')) turn = call('inspect_comparison_draft', {});
    else if (prompt.includes('This is the independent review findings closure')) {
      const state = JSON.parse(prompt.split('Current saved findings (hypotheses only): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { binding: ComparisonFindingsDelta['binding']; findingIds: string[]; questionIds: string[] };
      turn = call('update_comparison_findings', { kind: 'delta', binding: state.binding, findingDecisions: state.findingIds.map(id => ({ id, action: 'retain' })), questionDecisions: state.questionIds.map(id => ({ id, action: 'retain' })) });
    } else if (prompt.includes('The initial checkpoint is not formal certification: after this full audit')) turn = call('inspect_comparison_draft', {});
    else if (prompt.includes('This is the preview-only closure')) { assert.deepEqual(actual.tools?.map(t => t.name), ['preview_report']); turn = call('preview_report', {}); }
    else throw Error('Unexpected production author isolation request');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: turn.stopReason as 'stop' | 'toolUse', message: turn }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0, resources: { investigationModelRequests: 8 }, host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  const parsed = parseCommittedEventLog(await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8'));
  assert.equal(parsed.diagnostic, undefined);
  const events = parsed.events.map(e => { assert.ok(isRecord(e.payload)); return { ...e, payload: e.payload }; });
  const store = ExperimentStore.committedReader(result.experimentRoot, base.experimentId, events);
  const sessions = events.filter(e => e.type === 'agent.session_started' && e.payload.role === 'comparison'); assert.equal(sessions.length, 3);
  const comparisonIds = new Set(sessions.map(e => e.payload.sessionId));
  const attemptEvents = events.filter(e => e.payload.attemptId === sessions[0]!.payload.attemptId);
  const resolver = Object.assign(experimentModelInputResolver(store), { forRun: (runId: string | undefined) => experimentModelInputResolver(store, runId) });
  const replay = await reconstructModelRequests(attemptEvents, resolver);
  assert.equal(replay.diagnostic, undefined); assert.ok(replay.requests.every(r => r.contextSource === 'generation_snapshot' && r.contentComplete));
  assert.ok(replay.requests.every(r => comparisonIds.has(r.sessionId)));
  const author = replay.requests.find(r => r.systemPrompt?.includes('short provisional report'))!;
  assert.ok(author); assert.doesNotMatch(JSON.stringify(author.messages), /RAW_INVESTIGATION_ONLY_SENTINEL/); assert.match(JSON.stringify(author.messages), /SAVED_PROVISIONAL_FINDING/);
  assert.match(author.systemPrompt, /Current Host-owned metric pair/);
  const lastInspection = events.filter(e => e.type === 'agent.tool_completed' && e.payload.tool === 'inspect_comparison_draft' && !e.payload.nativeHook).at(-1)!;
  const preview = events.find(e => e.type === 'agent.tool_completed' && e.payload.tool === 'preview_report' && !e.payload.nativeHook)!;
  assert.ok(lastInspection.sequence < preview.sequence); assert.ok(events.some(e => e.type === 'agent.model_request' && e.sequence > lastInspection.sequence && e.sequence < preview.sequence && 'generationInput' in e.payload));
  assert.ok(events.some(e => e.type === 'comparison.draft_audit_started')); assert.ok(events.some(e => e.type === 'comparison.completed' && e.payload.status === 'completed'));
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Quality remains unverified/);
});

for (const strict of [true, false]) test(`actual Pi author isolation retains task/findings/metrics and full review lifecycle; strict=${strict}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fresh-author-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const store = await ExperimentStore.open(root, 'experiment'); await store.acquireWriter(); t.after(() => store.close());
  const seen: Context[] = []; let accepted = false, material = false, formal = false, epoch = false, previews = 0;
  const turns = [response('read'), response(), response('submit_comparison_draft'), response(), response('inspect_comparison_draft'), response('update_comparison_findings'), response('inspect_comparison_draft'), response('preview_report')];
  const models = { getModel: () => model, streamSimple: (_: unknown, actual: Context) => {
    seen.push(actualInput(actual)); const turn = turns.shift(); assert.ok(turn, 'No generation after matching preview');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: turn.stopReason as 'stop' | 'toolUse', message: turn }); return stream;
  } } as unknown as PiModels;
  const tools = [
    { name: 'read', execute: async () => ({ content: 'RAW_INVESTIGATION_ONLY_SENTINEL ' + 'x'.repeat(12000) }) },
    { name: 'submit_comparison_draft', execute: async () => { accepted = true; return { content: 'status=accepted\nAUTHOR_DRAFT_HYPOTHESIS' }; } },
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'ACTUAL_CURRENT_FULL_DRAFT: decisive unknown; draftDigest=current' }), onCompleted: async () => { material = true; formal = epoch; } },
    { name: 'update_comparison_findings', execute: async () => ({ content: 'status=accepted\nreadyToCompose=true' }) },
    { name: 'preview_report', execute: async () => { assert.equal(formal, true); previews++; return { content: 'ACTUAL_CURRENT_MATCHING_PREVIEW' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const result = await new ComparisonAgent({ host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)), timeoutMs: 1000, maxRepairAttempts: 0 }).compare(context, tools, experimentAgentAuditSink(store, 'run'), undefined, {
    reviewFindings: true, enforcePhaseBoundaries: strict, hasAcceptedDraft: () => accepted, findingsReady: () => true,
    getFindingsState: () => 'SAVED_PROVISIONAL_FINDING: recorded observation ev-1; critical branch unknown.',
    hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
    onReviewStarted: () => { material = false; formal = false; }, onDraftAuditStarted: () => { epoch = true; formal = false; },
    getSubmittedResult: async () => formal && previews === 1 ? { status: 'completed', reportPath: 'report.html', evidenceRefs: [] } : undefined,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(previews, 1);
  const sessions = store.events().filter(e => e.type === 'agent.session_started'); assert.equal(sessions.length, strict ? 3 : 2);
  assert.match(JSON.stringify(seen[1]), /RAW_INVESTIGATION_ONLY_SENTINEL/);
  const author = seen[2]!, source = seen[3]!;
  assert.match(JSON.stringify(author), /TASK_SOURCE_REQUIRED/); assert.match(JSON.stringify(author), /SAVED_PROVISIONAL_FINDING/);
  assert.match(author.systemPrompt!, /"costUsd":0.4/); assert.match(author.systemPrompt!, /"costUsd":0.08/);
  if (strict) { assert.doesNotMatch(JSON.stringify(author), /RAW_INVESTIGATION_ONLY_SENTINEL/); assert.match(author.systemPrompt!, /short provisional report/); }
  else assert.match(JSON.stringify(author), /RAW_INVESTIGATION_ONLY_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(source), /RAW_INVESTIGATION_ONLY_SENTINEL|SAVED_PROVISIONAL_FINDING|AUTHOR_DRAFT_HYPOTHESIS/);
  assert.match(JSON.stringify(source), /TASK_SOURCE_REQUIRED/);
  const phases = store.events().filter(e => e.type === 'comparison.phase_completed').map(e => { assert.ok(isRecord(e.payload)); return { ...e, payload: e.payload }; });
  assert.deepEqual(phases.map(e => e.payload.pass ?? e.payload.phase), ['investigate', 'compose', 'sources', 'inspection', 'review-findings', 'audit', 'preview']);
  const replay = await reconstructModelRequests(store.events(), experimentModelInputResolver(store, 'run'));
  assert.equal(replay.diagnostic, undefined); assert.equal(replay.requests.length, seen.length);
  assert.ok(replay.requests.every(r => r.contextSource === 'generation_snapshot' && r.contentComplete));
  assert.equal(replay.requests[2]!.systemPrompt, author.systemPrompt);
  assert.match(JSON.stringify(replay.requests.at(-1)!.messages.filter(m => isRecord(m) && m.role === 'toolResult')), /ACTUAL_CURRENT_FULL_DRAFT/);
});

for (const mode of ['cancel', 'hard', 'cancel_release', 'elapsed_release'] as const) test(`fresh author rotation respects ${mode} before creating a paid session`, async t => {
  if (mode === 'elapsed_release') t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const controller = new AbortController(); let sessions = 0, requests = 0;
  const host = new AgentHost({ createSession: input => { sessions++; return { append: async ({ content }) => {
    requests++; await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    if (mode === 'hard') await input.onModelUsage?.({ model: 'fixture', scope: 'generation', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
    return 'Investigated';
  }, cancel() {} }; } });
  const invocation = new ComparisonAgent({ host, timeoutMs: 1000, maxRepairAttempts: 0, resources: mode === 'hard' ? { maxEstimatedCostUsd: 1 } : mode === 'elapsed_release' ? { maxElapsedMs: 100 } : {} }).compare(context, [], { append: async e => {
    if (mode === 'cancel' && e.type === 'comparison.phase_completed' && e.payload.phase === 'investigate') controller.abort();
    if (e.type === 'agent.session_completed') {
      if (mode === 'cancel_release') controller.abort();
      if (mode === 'elapsed_release') t.mock.timers.tick(101);
    }
  } }, controller.signal,
    { reviewFindings: true, enforcePhaseBoundaries: true, findingsReady: () => true, getSubmittedResult: async () => undefined,
      estimateUsageCost: () => mode === 'hard' ? 1 : 0 });
  if (mode === 'hard' || mode === 'elapsed_release') {
    await assert.rejects(invocation, mode === 'hard' ? /maxEstimatedCostUsd before fresh Comparison session/ : /maxElapsedMs before fresh Comparison session after release/);
  } else assert.equal((await invocation).status, 'cancelled');
  assert.equal(sessions, 1); assert.equal(requests, 1);
});
