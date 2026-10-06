import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { Value } from '@sinclair/typebox/value';
import { ComparisonAgent, COMPARISON_SOURCE_REVIEW_PROMPT, COMPARISON_TURN_PROMPTS } from '../../src/agents/comparison-agent.js';
import { COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT } from '../../src/agents/comparison-review-findings.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ComparisonFindingsDeltaSchema, type ComparisonFindingsDelta, type ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function turn(name: string, args: unknown): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args as Record<string, unknown> }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
type Event = { sequence: number; sessionId?: string; type: string; payload: Record<string, unknown> };

for (const mode of ['success', 'cancel', 'hard'] as const) test(`production native readonly denial, correction and source soft boundary preserve ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-refusal-publication-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# sealed source\n');
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final remains unchecked' })),
    findings: [], importantLimitations: ['Quality remains unverified'], decisionQuestions: [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'Could change preference', status: 'unavailable', evidenceRefs: [], resolution: 'Author did not verify final quality' }] };
  const draft = { status: 'insufficient_evidence', decisionShape: 'single_difference', category: 'Results', headline: 'Quality remains unverified.',
    decisionSummary: 'The usefulness of both final outputs remains unknown.', decisionBoundary: 'Final quality could change model preference.', decisionBasis: [], conclusionScope: 'undetermined', findingDispositions: [], comparisonHtml: '<p>No supported replacement choice.</p>' };
  const contexts: Context[] = []; let actualDelta = false, investigationRequests = 0, sourceRequests = 0;
  const models = { getModel: () => model, streamSimple: (_: unknown, context: Context) => {
    contexts.push({ ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}), messages: structuredClone(context.messages),
      ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })) } : {}) });
    const count = contexts.length;
    const content = context.messages.filter(item => item.role === 'user').at(-1)!.content;
    const actualPrompt = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let response: AssistantMessage;
    if (actualPrompt.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) response = turn('update_comparison_findings', { ...initial,
      decisionQuestions: initial.decisionQuestions.map(({ resolution: _resolution, ...question }) => ({ ...question, status: 'pending', nextCheck: 'Inspect final sources before any quality verdict.' })) });
    else if (actualPrompt.includes(COMPARISON_TURN_PROMPTS.orientAndInvestigate)) {
      investigationRequests++;
      assert.equal(investigationRequests, 1, 'an actual saved ready snapshot ends investigation at its completed tool turn');
      response = turn('update_comparison_findings', initial);
    } else if (actualPrompt.includes(COMPARISON_TURN_PROMPTS.compose) || actualPrompt.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) response = turn('submit_comparison_draft', draft);
    else if (actualPrompt.includes(COMPARISON_SOURCE_REVIEW_PROMPT) || actualPrompt.includes(COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT)) {
      sourceRequests++;
      assert.ok(sourceRequests <= 3, 'source soft boundary requires no extra generation');
      if (sourceRequests === 2) {
        assert.match(JSON.stringify(context.messages), /write_denied[\s\S]*Keep source inspection and work-copy mutation in separate shell calls/);
        assert.ok(context.messages.some(item => item.role === 'toolResult' && 'isError' in item && item.isError));
        response = turn('shell_exec', { command: "Set-Content corrected.txt 'Corrected in writable scratch'" });
        if (mode === 'hard') response.content = Array.from({ length: 28 }, (_, index) => ({ type: 'toolCall', id: `corrected-${index}`, name: 'shell_exec',
          arguments: { command: `Set-Content corrected.txt 'Corrected write ${index}'` } }));
      } else response = turn('shell_exec', { command: 'Set-Content finals/policy-denial-sentinel.txt denied' });
    }
    else if (actualPrompt.includes('This is the actual draft inspection checkpoint')) response = turn('inspect_comparison_draft', {});
    else if (actualPrompt.includes('This is the independent review findings closure')) {
      const state = JSON.parse(actualPrompt.split('Current saved findings (hypotheses only): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { binding: ComparisonFindingsDelta['binding']; questionIds: string[]; findingIds: string[] };
      const delta: ComparisonFindingsDelta = { kind: 'delta', binding: state.binding,
        findingDecisions: state.findingIds.map(id => ({ id, action: 'retain' })), questionDecisions: state.questionIds.map(id => ({ id, action: 'retain' })) };
      assert.ok(Value.Check(ComparisonFindingsDeltaSchema, delta)); actualDelta = true; response = turn('update_comparison_findings', delta);
    } else if (actualPrompt.includes('The initial checkpoint is not formal certification: after this full audit')) {
      assert.ok(actualDelta); response = turn('inspect_comparison_draft', {});
    } else if (actualPrompt.includes('This is the preview-only closure')) {
      assert.ok(actualDelta); assert.deepEqual(context.tools?.map(item => item.name), ['preview_report']); response = turn('preview_report', {});
    } else throw new Error(`Unexpected production generation ${count}`);
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response }); return stream;
  } } as unknown as PiModels;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0,
    resources: { investigationModelRequests: 3, ...(mode === 'hard' ? { maxToolCalls: 30 } : {}) },
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const handle = startExperiment({ ...base, comparison });
  if (mode === 'cancel') {
    const original = models.streamSimple;
    models.streamSimple = (...args: Parameters<PiModels['streamSimple']>) => {
      const result = original(...args); if (sourceRequests === 2) void handle.cancel(); return result;
    };
  }
  const result = await handle.result;
  assert.equal(result.comparison.result.status, mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(result.comparison.result));
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Event);
  const attemptId = events.find(event => event.type === 'comparison.requested')?.payload.attemptId;
  assert.equal(typeof attemptId, 'string');
  const attemptRoot = join(result.experimentRoot, 'comparison-attempts', String(attemptId));
  await assert.rejects(readFile(join(attemptRoot, 'finals/policy-denial-sentinel.txt')), { code: 'ENOENT' }, 'the readonly denial leaves no forbidden file');
  if (mode !== 'cancel') {
    assert.ok(events.some(event => {
      const details = event.payload.details as { command?: string; exitCode?: number; stderrBytes?: number } | undefined;
      return event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && !event.payload.nativeHook
        && details?.command?.startsWith('Set-Content corrected.txt') && details.exitCode === 0 && details.stderrBytes === 0;
    }), 'a permitted correction command actually exits successfully, rather than only returning a tool receipt');
    assert.match(await readFile(join(attemptRoot, 'scratch/corrected.txt'), 'utf8'), /Corrected (?:in writable scratch|write \d+)/, 'a separate permitted shell call actually writes scratch before completion or the hard stop');
  }
  assert.ok(events.some(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('write_denied')));
  assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && event.payload.nativeHook === 'after' && event.payload.isError === true));
  const preview = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report' && !event.payload.nativeHook);
  if (mode !== 'success') {
    assert.equal(preview, undefined);
    if (mode === 'hard') {
      assert.equal(sourceRequests, 2);
      assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && !event.payload.nativeHook));
      assert.ok(events.some(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('maxToolCalls')));
    }
    return;
  }
  assert.equal(contexts.length, 10); assert.equal(investigationRequests, 1); assert.equal(sourceRequests, 3); assert.ok(actualDelta);
  const source = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'sources')!;
  assert.equal(source.payload.outcome, 'yielded'); assert.equal(source.payload.yieldReason, 'reviewModelRequests');
  const denied = events.find(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('write_denied'))!;
  const correction = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && !event.payload.nativeHook && event.sequence > denied.sequence)!;
  assert.ok(correction.sequence < source.sequence);
  const update = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'update_comparison_findings' && !event.payload.nativeHook).at(-1)!;
  const closure = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings')!;
  const audit = events.find(event => event.type === 'comparison.draft_audit_started')!;
  const inspection = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft' && !event.payload.nativeHook).at(-1)!;
  assert.ok(source.sequence < update.sequence && update.sequence < closure.sequence && closure.sequence < audit.sequence && audit.sequence < inspection.sequence && inspection.sequence < preview!.sequence);
  assert.ok(events.some(event => event.type === 'agent.model_request' && event.sequence > inspection.sequence && event.sequence < preview!.sequence && 'generationInput' in event.payload));
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Quality remains unverified/);
});
