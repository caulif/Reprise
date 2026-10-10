import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, COMPARISON_TURN_PROMPTS } from '../../src/agents/comparison-agent.js';
import { COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT } from '../../src/agents/comparison-review-findings.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import type { ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { parseCommittedEventLog, reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { retainComparisonFindings } from '../comparison-findings-support.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const call = (name: string, args: unknown): AssistantMessage['content'][number] => ({ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> });
const turn = (name: string, args: unknown) => response([call(name, args)]);
const candidateUnknown = 'candidate_far_leg_contact_unchecked';
const baselineUnknown = 'baseline_reduced_motion_pose_unchecked';
const wireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

for (const mode of ['repaired', 'unfinished'] as const) test(`production native full findings audit preserves scope-summary uncertainty and ${mode} publication boundary`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-scope-summary-audit-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# frozen source\n');
  const findings: ComparisonFindingsSubmission = { criteria: ['Animation usefulness'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Unverified final' })),
    findings: [{ id: 'animation', criterion: 'Animation usefulness', difference: 'No verified contact comparison', userConsequence: 'Contact could reverse model choice',
      observations: (['baseline', 'candidate'] as const).map(side => ({ side, method: 'unavailable', timing: 'comparison_check', evidenceRefs: [],
        result: 'Actual output remains unverified', scope: 'Final animation', supportBoundary: { relationship: 'Actual drawn contact', domain: 'Final animation including motion modes',
          supportStage: 'unavailable', coveredInstances: [], uncheckedInstances: [side === 'baseline' ? baselineUnknown : candidateUnknown] } })),
      limitations: ['Missing contact check could reverse preference'], counterEvidenceRefs: [] }],
    importantLimitations: ['Actual contact remains unknown'], decisionQuestions: [] };
  const provisional = { kind: 'decision', status: 'insufficient_evidence', category: 'Animation', headline: 'No verified preference', decisionShape: 'single_difference',
    decisionSummary: 'Neither output is verified preferable.', decisionBoundary: 'Verification could reverse choice.', conclusionScope: 'undetermined',
    findingDispositions: [{ findingId: 'animation', disposition: 'basis', explanation: 'Verification affects choice' }],
    scopeSummaries: [{ findingId: 'animation', baseline: 'Final unverified.', candidate: 'Final unverified.' }] };
  const corrected = { ...provisional, scopeSummaries: [{ findingId: 'animation',
    baseline: `Final animation: ${baselineUnknown}.`, candidate: `Final animation: ${candidateUnknown}; this could reverse choice.` }] };
  let auditRequests = 0;
  const actualContexts: Context[] = [];
  const models = { getModel: () => model, streamSimple: (_: unknown, context: Context) => {
    actualContexts.push({ ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}), messages: structuredClone(context.messages),
      ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })) } : {}) });
    const content = context.messages.filter(item => item.role === 'user').at(-1)!.content;
    const prompt = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let message: AssistantMessage;
    if (prompt.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) message = turn('update_comparison_findings', { ...findings, findings: [] });
    else if (prompt.includes(COMPARISON_TURN_PROMPTS.orientAndInvestigate)) message = turn('update_comparison_findings', findings);
    else if (prompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) message = turn('submit_comparison_draft', provisional);
    else if (prompt.includes(COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT)) message = response([{ type: 'text', text: 'Output contact remains unavailable.' }], 'stop');
    else if (prompt.includes('This is the actual draft inspection checkpoint')) message = turn('inspect_comparison_draft', {});
    else if (prompt.includes('This is the independent review findings closure')) message = turn('update_comparison_findings_delta', retainComparisonFindings(prompt));
    else if (prompt.includes('The initial checkpoint is not formal certification: after this full audit')) {
      auditRequests++;
      const fullState = JSON.parse(prompt.split('decision-changing uncertainty): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { record: { submission: ComparisonFindingsSubmission } };
      assert.deepEqual(fullState.record.submission.findings[0]!.observations, findings.findings[0]!.observations, 'actual audit generation receives both original complete side scopes');
      const deliveredDraft = context.messages.filter(item => item.role === 'toolResult').map(item => JSON.stringify(item.content)).join('\n');
      if (auditRequests === 1) {
        assert.doesNotMatch(deliveredDraft, new RegExp(candidateUnknown), 'initial structurally accepted presentation omitted the decisive scope unknown');
        if (mode === 'unfinished') message = response([{ type: 'text', text: 'Audit is still unfinished.' }], 'length');
        else message = response([call('submit_comparison_draft', provisional), call('inspect_comparison_draft', {}),
          call('submit_comparison_draft', corrected), call('preview_report', {})]);
      } else {
        if (mode === 'unfinished') message = response([{ type: 'text', text: 'Audit remains unfinished.' }], 'length');
        else {
          assert.match(deliveredDraft, /Tool preview_report not found/);
          assert.match(deliveredDraft, /status=accepted/);
          message = turn('inspect_comparison_draft', {});
        }
      }
    } else if (prompt.includes('The previous generation reached its output limit')) {
      assert.equal(mode, 'unfinished');
      message = response([{ type: 'text', text: 'Audit remains unfinished.' }], 'length');
    } else if (prompt.includes('This is the preview-only closure')) {
      assert.equal(mode, 'repaired');
      assert.match(JSON.stringify(context.messages), new RegExp(candidateUnknown));
      message = turn('preview_report', {});
    } else throw new Error('Unexpected production scope-summary generation');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0,
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, mode === 'repaired' ? 'completed' : 'failed', JSON.stringify(result.comparison.result));
  const parsed = parseCommittedEventLog(await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8'));
  assert.equal(parsed.diagnostic, undefined);
  const events = parsed.events.map(event => ({ ...event, payload: event.payload as Record<string, unknown> }));
  const attemptId = events.find(event => event.type === 'comparison.requested')!.payload.attemptId;
  const comparisonEvents = events.filter(event => event.payload.attemptId === attemptId);
  const store = ExperimentStore.committedReader(result.experimentRoot, base.experimentId, events);
  const resolver = Object.assign(experimentModelInputResolver(store), { forRun: (runId: string | undefined) => experimentModelInputResolver(store, runId) });
  const replay = await reconstructModelRequests(comparisonEvents, resolver);
  assert.equal(replay.diagnostic, undefined);
  assert.ok(replay.requests.every(request => request.contextSource === 'generation_snapshot' && request.contentComplete));
  assert.deepEqual(wireValue(replay.requests.map(request => request.messages)), wireValue(actualContexts.map(context => context.messages)), 'persisted snapshots match the actual native Provider inputs on the JSON wire');
  const auditInputs = replay.requests.filter(request => JSON.stringify(request.messages).includes('Current complete findings for audit'));
  assert.ok(auditInputs.length > 0);
  for (const request of auditInputs) {
    assert.match(JSON.stringify(request.messages), new RegExp(candidateUnknown));
    assert.match(JSON.stringify(request.messages), new RegExp(baselineUnknown));
    const actualAuditPrompt = (request.messages as Context['messages']).map(item => item.role === 'user'
      ? typeof item.content === 'string' ? item.content : item.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '')
      .find(text => text.includes('Current complete findings for audit'))!;
    const fullState = JSON.parse(actualAuditPrompt.split('decision-changing uncertainty): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { record: { submission: ComparisonFindingsSubmission } };
    assert.deepEqual(fullState.record.submission, findings, 'recorded actual generation snapshots preserve the entire findings record while presentation changes');
  }
  const previewCalls = comparisonEvents.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report' && !event.payload.nativeHook);
  const accepts = comparisonEvents.filter(event => event.type === 'comparison.draft_accepted');
  assert.ok(accepts.length > 0, 'the incomplete presentation really was structurally accepted without semantic certification');
  if (mode === 'unfinished') {
    assert.equal(previewCalls.length, 0);
    assert.equal(comparisonEvents.some(event => event.type === 'comparison.completed' && event.payload.status === 'completed'), false);
    return;
  }
  assert.equal(previewCalls.length, 1, 'the audit preview attempt never executes; only final preview after new inspection succeeds');
  const rejectedPreview = comparisonEvents.find(event => event.type === 'agent.tool_failed' && event.payload.tool === 'preview_report'
    && event.payload.nativeHook === 'sdk_rejected' && event.payload.code === 'sdk_pre_execution_rejected');
  assert.ok(rejectedPreview, 'actual unavailable preview attempt is safely audited as an SDK pre-execution rejection');
  assert.equal(comparisonEvents.filter(event => event.type === 'agent.tool_called' && event.payload.tool === 'preview_report' && !event.payload.nativeHook).length, 1);
  const inspections = comparisonEvents.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft' && !event.payload.nativeHook);
  const finalAccept = accepts.at(-1)!, previousAccept = accepts.at(-2)!;
  assert.notEqual(finalAccept.payload.draftDigest, previousAccept.payload.draftDigest, 'scope summary changes the draft binding');
  const finalInspection = inspections.at(-1)!;
  assert.ok(finalAccept.sequence < rejectedPreview.sequence && rejectedPreview.sequence < finalInspection.sequence && finalInspection.sequence < previewCalls[0]!.sequence);
  assert.ok(comparisonEvents.some(event => event.type === 'agent.model_request' && event.sequence > finalInspection.sequence && event.sequence < previewCalls[0]!.sequence && event.payload.generationInput));
  const html = await readFile(join(result.experimentRoot, 'report.html'), 'utf8');
  assert.match(html, new RegExp(candidateUnknown)); assert.match(html, new RegExp(baselineUnknown));
});
