import { sha256 } from '../../src/core/identity.js';
import type { ArtifactRenderer } from '../../src/infrastructure/artifact-renderer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, COMPARISON_TURN_PROMPTS } from '../../src/agents/comparison-agent.js';
import { COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT, COMPARISON_DIRECT_AUDIT_PROMPT } from '../../src/agents/comparison-review-findings.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import type { ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { retainComparisonFindings } from '../comparison-findings-support.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const turn = (name: string, args: unknown) => response([{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> }]);
type Event = { sequence: number; type: string; payload: Record<string, unknown> };

for (const revise of [false, true]) test(`plain decision traverses production publication with ${revise ? 'a revised audit and forced final inspection' : 'unchanged audit'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-decision-publication-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# frozen source\n');
  const findings: ComparisonFindingsSubmission = { criteria: ['Task use'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Unchecked final' })),
    findings: [], importantLimitations: ['Quality unknown'],
    decisionQuestions: [{ id: 'quality', question: 'Does the output meet the task?', decisionImpact: 'Could reverse choice', status: 'unavailable',
      evidenceRefs: [], resolution: 'Final quality remains unverified' }] };
  const decision = { kind: 'decision', status: 'insufficient_evidence', category: 'Results', headline: 'Quality unknown', decisionShape: 'single_difference',
    decisionSummary: 'Neither final output is confirmed usable.', decisionBoundary: 'Final quality could reverse the choice.', conclusionScope: 'undetermined', findingDispositions: [], scopeSummaries: [] };
  let investigationRequests = 0, requests = 0;
  const actualOutputs: AssistantMessage[] = [];
  const models = { getModel: () => model, streamSimple: (_: unknown, context: Context) => {
    requests++;
    const content = context.messages.filter(item => item.role === 'user').at(-1)!.content;
    const prompt = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let message: AssistantMessage;
    if (prompt.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
      assert.deepEqual(context.tools?.map(tool => tool.name), ['update_comparison_findings']);
      message = turn('update_comparison_findings', { ...findings, importantLimitations: [],
        decisionQuestions: [{ id: 'quality', question: 'Does the output meet the task?', decisionImpact: 'Could reverse choice', status: 'pending',
          evidenceRefs: [], nextCheck: 'Inspect both final outputs' }] });
    } else if (prompt.includes(COMPARISON_TURN_PROMPTS.orientAndInvestigate)) {
      investigationRequests++; assert.equal(investigationRequests, 1, 'an actual ready saved snapshot ends strict investigation immediately');
      const receiptMessage = context.messages.find(item => item.role === 'toolResult' && item.toolName === 'update_comparison_findings');
      assert.ok(receiptMessage?.role === 'toolResult');
      const receiptText = receiptMessage.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      const saved = JSON.parse(receiptText.split('\n')[1]!) as { binding: { revision: number; digest: string; catalogRevision: number } };
      message = turn('update_comparison_findings_delta', { kind: 'delta', binding: saved.binding, findingDecisions: [],
        questionDecisions: [{ id: 'quality', action: 'replace', replacement: findings.decisionQuestions[0] }] });
    } else if (prompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) {
      assert.deepEqual(context.tools?.map(tool => tool.name).sort(), ['submit_comparison_draft', 'update_comparison_findings']);
      message = turn('submit_comparison_draft', decision);
    }
    else if (prompt.includes(COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT)) {
      assert.ok(context.tools?.some(tool => tool.name === 'update_comparison_findings_delta'));
      assert.ok(context.tools?.every(tool => !['write', 'submit_comparison_draft', 'preview_report'].includes(tool.name)));
      message = response([{ type: 'text', text: 'No final quality support.' }], 'stop');
    }
    else if (prompt.includes('This is the independent review findings closure')) message = turn('update_comparison_findings_delta', retainComparisonFindings(prompt));
    else if (prompt.includes('This is the actual draft inspection checkpoint')) message = turn('inspect_comparison_draft', {});
    else if (prompt.includes(COMPARISON_DIRECT_AUDIT_PROMPT)) message = revise ? turn('submit_comparison_draft', { ...decision, headline: 'Still unverified' }) : turn('inspect_comparison_draft', {});
    else if (prompt.includes('The completed independent audit turn submitted an accepted revision')) {
      assert.deepEqual(context.tools?.map(tool => tool.name), ['inspect_comparison_draft']);
      message = turn('inspect_comparison_draft', {});
    }
    else if (prompt.includes('This is the preview-only closure')) {
      assert.match(JSON.stringify(context.messages), /Neither final output is confirmed usable/);
      assert.deepEqual(context.tools?.map(tool => tool.name), ['preview_report']); message = turn('preview_report', {});
    } else throw new Error(`Unexpected generation ${requests}`);
    actualOutputs.push(JSON.parse(JSON.stringify(message)) as AssistantMessage);
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0,
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  let previewRenders = 0;
  const comparisonPreviewRenderer: ArtifactRenderer = async request => {
    previewRenders++;
    assert.equal(request.entryRelativePath, 'preview.html');
    const prepared = await readFile(join(request.bundleRoot, request.entryRelativePath), 'utf8');
    assert.match(prepared, /Neither final output is confirmed usable/);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await mkdir(request.outputRoot, { recursive: true });
    const pngPath = join(request.outputRoot, 'preview.png');
    await writeFile(pngPath, png);
    return { ok: true, frames: [{ sampleTimeMs: 0, actualTimeMs: 0, pngPath, byteLength: png.byteLength, contentHash: sha256(png) }],
      diagnostics: [], measured: { loadMs: 1, viewport: request.viewport, origin: 'fixture://preview' } };
  };
  const result = await startExperiment({ ...base, comparison, comparisonPreviewRenderer }).result;
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  assert.equal(previewRenders, 1);
  assert.equal(requests, revise ? 9 : 8);
  assert.equal(investigationRequests, 1);
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Event);
  const cappedStarts = events.filter(event => event.type === 'agent.invocation_started' && event.payload.reasoningEffortCeiling === 'low');
  assert.ok(cappedStarts.length >= 3, 'initial persistence, actual inspection and preview record their mechanical effort ceiling');
  const submit = events.find(event => event.type === 'agent.tool_called' && event.payload.tool === 'submit_comparison_draft' && !event.payload.nativeHook)!;
  const auditedParams = submit.payload.params as Record<string, unknown>;
  assert.equal(auditedParams.kind, 'string');
  assert.equal('comparisonHtml' in auditedParams, false); assert.equal('detailsHtml' in auditedParams, false); assert.equal('decisionBasis' in auditedParams, false);
  const recordedSubmission = actualOutputs.flatMap(item => item.content).find(item => item.type === 'toolCall' && item.name === 'submit_comparison_draft');
  assert.ok(recordedSubmission?.type === 'toolCall');
  const params = recordedSubmission.arguments;
  assert.equal(params.kind, 'decision');
  assert.equal('comparisonHtml' in params, false); assert.equal('detailsHtml' in params, false); assert.equal('decisionBasis' in params, false);
  const closure = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings')!;
  const audit = events.find(event => event.type === 'comparison.draft_audit_started')!;
  const inspect = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft' && !event.payload.nativeHook).at(-1)!;
  const preview = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report' && !event.payload.nativeHook)!;
  assert.ok(closure.sequence < audit.sequence && audit.sequence < inspect.sequence && inspect.sequence < preview.sequence);
  assert.ok(events.some(event => event.type === 'agent.model_request' && event.sequence > inspect.sequence && event.sequence < preview.sequence && 'generationInput' in event.payload));
  const html = await readFile(join(result.experimentRoot, 'report.html'), 'utf8');
  assert.equal(html.split(decision.decisionSummary).length - 1, 1);
  assert.match(html, /Final quality could reverse the choice/);
});
