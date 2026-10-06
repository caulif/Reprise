import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, COMPARISON_TURN_PROMPTS } from '../../src/agents/comparison-agent.js';
import { COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT } from '../../src/agents/comparison-review-findings.js';
import { closeBoundedInvestigation } from '../../src/agents/comparison-investigation-closure.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import type { ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const deadline = { status: 'yielded' as const, sessionId: 'session', reason: 'bounded_investigation_timeout' };
test('only an explicit missing-record getter preserves the real deadline outcome without Host synthesis', async () => {
  let closures = 0;
  const options = { findingsReady: () => false, closeBoundedInvestigation: async () => { closures++; throw new Error('Actual closure failure'); } };
  const signal = new AbortController().signal;
  assert.equal(await closeBoundedInvestigation({ ...options, hasSavedFindings: () => false }, deadline, new ComparisonResourceTracker({}), signal), deadline);
  assert.equal(closures, 0);
  for (const present of [undefined, true]) {
    const result = await closeBoundedInvestigation({ ...options, ...(present === undefined ? {} : { hasSavedFindings: () => present }) }, deadline, new ComparisonResourceTracker({}), signal);
    assert.equal(result.status, 'failed');
  }
  assert.equal(closures, 2);
});

for (const mode of ['invalid_refs', 'persist', 'audit', 'not_ready'] as const) test(`an existing record ${mode} failure cannot enter the missing-record recovery branch`, async () => {
  let closures = 0;
  const result = await closeBoundedInvestigation({ findingsReady: () => false, hasSavedFindings: () => true,
    closeBoundedInvestigation: async () => { closures++; if (mode !== 'not_ready') throw new Error(mode); } }, deadline, new ComparisonResourceTracker({}), new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(closures, 1);
});

test('hard limit and parent cancellation take precedence over the missing-record branch', async () => {
  let missingChecks = 0, closures = 0;
  const options = { findingsReady: () => false, hasSavedFindings: () => { missingChecks++; return false; }, closeBoundedInvestigation: async () => { closures++; } };
  const controller = new AbortController(); controller.abort();
  assert.equal((await closeBoundedInvestigation(options, deadline, new ComparisonResourceTracker({}), controller.signal)).status, 'cancelled');
  await assert.rejects(closeBoundedInvestigation(options, deadline, new ComparisonResourceTracker({ maxElapsedMs: 0 }), new AbortController().signal), /maxElapsedMs/);
  assert.equal(missingChecks, 0); assert.equal(closures, 0);
});

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const turn = (name: string, args: unknown) => response([{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> }]);
type Event = { sequence: number; type: string; payload: Record<string, unknown> };

for (const mode of ['success', 'save_fail', 'verbal', 'not_ready', 'cancel', 'hard'] as const) test(`production native missing initial findings uses the existing bounded model-only save path: ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-missing-findings-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# frozen source\n');
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final remains unchecked' })),
    findings: [], importantLimitations: ['Quality remains unverified'], decisionQuestions: [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'Could change preference', status: 'unavailable', evidenceRefs: [], resolution: 'No quality check was completed' }] };
  const draft = { status: 'insufficient_evidence', decisionShape: 'single_difference', category: 'Results', headline: 'Quality remains unverified.', decisionSummary: 'The usefulness of both final outputs remains unknown.',
    decisionBoundary: 'Final quality could change model preference.', decisionBasis: [], conclusionScope: 'undetermined', findingDispositions: [], comparisonHtml: '<p>No supported replacement choice.</p>' };
  let initialRequests = 0, investigationRequests = 0, closureRequests = 0, requests = 0, sourceRequests = 0;
  const models = { getModel: () => model, streamSimple: (_: unknown, context: Context, options: { signal: AbortSignal }) => {
    requests++; const stream = createAssistantMessageEventStream();
    const content = context.messages.filter(item => item.role === 'user').at(-1)!.content;
    const prompt = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let message: AssistantMessage;
    if (prompt.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
      initialRequests++; assert.deepEqual(context.tools?.map(tool => tool.name), ['update_comparison_findings']);
      if (initialRequests === 1) message = turn('update_comparison_findings', {
        ...initial, finals: initial.finals.map(final => ({ ...final, status: 'located', sourceRefs: ['ev-999999'] })),
      });
      else {
        assert.equal(initialRequests, 2);
        options.signal.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: response([], 'aborted') }), { once: true });
        return stream;
      }
    } else if (prompt.includes(COMPARISON_TURN_PROMPTS.orientAndInvestigate)) {
      investigationRequests++; throw new Error('Investigation cannot run without an accepted initial record');
    } else if (prompt.includes('Use this bounded closure turn only to submit update_comparison_findings')) {
      closureRequests++; assert.deepEqual(context.tools?.map(tool => tool.name), ['update_comparison_findings', 'update_comparison_findings_delta']);
      assert.match(prompt, /possibly during an unfinished generation[\s\S]*not a completed-turn boundary/);
      const stop = mode === 'verbal' || ((mode === 'save_fail' || mode === 'not_ready') && closureRequests % 2 === 0);
      const submission = mode === 'save_fail' ? { invalid: true } : mode === 'not_ready'
        ? { ...initial, decisionQuestions: [{ ...initial.decisionQuestions[0], status: 'pending', nextCheck: 'Check original outputs', resolution: undefined }] } : initial;
      message = stop ? response([{ type: 'text', text: 'A verbal promise is not a saved finding.' }], 'stop') : turn('update_comparison_findings', submission);
    } else if (prompt.includes(COMPARISON_TURN_PROMPTS.compose) || prompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) message = turn('submit_comparison_draft', draft);
    else if (prompt.includes(COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT)) {
      sourceRequests++; assert.ok(context.tools?.some(tool => tool.name === 'update_comparison_findings'));
      assert.ok(context.tools?.every(tool => !['write', 'submit_comparison_draft', 'preview_report'].includes(tool.name)));
      message = response([{ type: 'text', text: 'No final quality check is supported; preserve the limitation.' }], 'stop');
    }
    else if (prompt.includes('This is the independent review findings closure')) message = turn('update_comparison_findings', initial);
    else if (prompt.includes('This is the actual draft inspection checkpoint') || prompt.includes('The initial checkpoint is not formal certification: after this full audit')) message = turn('inspect_comparison_draft', {});
    else if (prompt.includes('This is the preview-only closure')) message = turn('preview_report', {});
    else throw new Error(`Unexpected production request ${requests}`);
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0,
    resources: { investigationMs: 500, ...(mode === 'hard' ? { maxModelRequests: 2 } : {}) },
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const handle = startExperiment({ ...base, comparison });
  if (mode === 'cancel') {
    const original = models.streamSimple;
    models.streamSimple = (...args: Parameters<PiModels['streamSimple']>) => { const stream = original(...args); if (closureRequests === 1) void handle.cancel(); return stream; };
  }
  const result = await handle.result;
  assert.equal(result.comparison.result.status, mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(result.comparison.result));
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Event);
  assert.equal(initialRequests, 2); assert.equal(investigationRequests, 0);
  const boundary = events.find(event => event.type === 'agent.invocation_yielded' && event.payload.reason === 'bounded_investigation_timeout')!; assert.ok(boundary);
  assert.equal(events.some(event => event.type === 'comparison.investigation_closed'), false, 'Host cannot close or synthesize a record that never existed');
  const saves = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'update_comparison_findings' && !event.payload.nativeHook);
  const rejectedInitial = saves.filter(event => event.sequence < boundary.sequence);
  assert.equal(rejectedInitial.length, 1, 'the real initial pass receives rejection without persisting a record');
  assert.match((rejectedInitial[0]!.payload.body as { text: string }).text, /status=rejected\ncode=final_source_mismatch/);
  const acceptedSaves = events.filter(event => event.type === 'comparison.findings_updated');
  assert.ok(acceptedSaves.every(event => event.sequence > boundary.sequence), 'all accepted actual model saves occur after the real initial checkpoint deadline');
  const preview = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report' && !event.payload.nativeHook);
  if (mode !== 'success') {
    assert.equal(preview, undefined); assert.equal(sourceRequests, 0);
    if (mode === 'hard') { assert.equal(requests, 2); assert.equal(closureRequests, 0); assert.equal(acceptedSaves.length, 0); }
    if (mode === 'cancel') { assert.equal(closureRequests, 1); assert.equal(acceptedSaves.length, 0); }
    const closureCalls = events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'findings');
    assert.ok(closureCalls.length <= 2); if (mode === 'verbal' || mode === 'not_ready' || mode === 'save_fail') assert.equal(closureCalls.length, 2);
    return;
  }
  assert.equal(requests, 9); assert.equal(closureRequests, 1); assert.equal(saves.length, 3); assert.equal(acceptedSaves.length, 1, 'unchanged independent snapshot reuses the actual persisted revision');
  for (const saved of saves.slice(1)) assert.match((saved.payload.body as { text: string }).text, /^status=accepted\n/);
  const accepted = events.find(event => event.type === 'comparison.findings_updated')!; assert.ok(accepted.sequence > boundary.sequence);
  const findingsClosure = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings')!;
  const audit = events.find(event => event.type === 'comparison.draft_audit_started')!;
  const inspect = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft' && !event.payload.nativeHook).at(-1)!;
  assert.ok(saves[2]!.sequence < findingsClosure.sequence && findingsClosure.sequence < audit.sequence && audit.sequence < inspect.sequence && inspect.sequence < preview!.sequence);
  assert.ok(events.some(event => event.type === 'agent.model_request' && event.sequence > inspect.sequence && event.sequence < preview!.sequence && 'generationInput' in event.payload));
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Quality remains unverified/);
});
