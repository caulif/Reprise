import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, COMPARISON_SOURCE_REVIEW_PROMPT, COMPARISON_TURN_PROMPTS } from '../../src/agents/comparison-agent.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import type { ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const turn = (name: string, args: unknown) => response([{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> }]);
type Event = { sequence: number; type: string; payload: Record<string, unknown> };

test('plain decision input traverses production native findings, audit, inspection, generation and preview publication', async t => {
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
    decisionSummary: 'Neither final output is confirmed usable.', decisionBoundary: 'Final quality could reverse the choice.', conclusionScope: 'undetermined', findingDispositions: [] };
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
      investigationRequests++; message = investigationRequests === 1 ? turn('update_comparison_findings', findings)
        : response([{ type: 'text', text: 'Retain quality uncertainty.' }], 'stop');
    } else if (prompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) {
      assert.deepEqual(context.tools?.map(tool => tool.name).sort(), ['submit_comparison_draft', 'update_comparison_findings']);
      message = turn('submit_comparison_draft', decision);
    }
    else if (prompt.includes(COMPARISON_SOURCE_REVIEW_PROMPT)) message = response([{ type: 'text', text: 'No final quality support.' }], 'stop');
    else if (prompt.includes('This is the independent review findings closure')) message = turn('update_comparison_findings', findings);
    else if (prompt.includes('This is the actual draft inspection checkpoint') || prompt.includes('The initial checkpoint is not formal certification: after this full audit')) message = turn('inspect_comparison_draft', {});
    else if (prompt.includes('This is the preview-only closure')) {
      assert.match(JSON.stringify(context.messages), /Neither final output is confirmed usable/);
      assert.deepEqual(context.tools?.map(tool => tool.name), ['preview_report']); message = turn('preview_report', {});
    } else throw new Error(`Unexpected generation ${requests}`);
    actualOutputs.push(JSON.parse(JSON.stringify(message)) as AssistantMessage);
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0,
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  assert.equal(requests, 9);
  assert.equal(investigationRequests, 2);
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Event);
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
