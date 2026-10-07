import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context: ComparisonContext = { attemptId: 'author-yield', task: { caseId: 'case', summary: 'Compare delivered results' }, baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true, replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
function response(tool?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: tool ? [{ type: 'toolCall', id: `${tool}-${Date.now()}`, name: tool, arguments: {} }] : [{ type: 'text', text: 'Completed actual turn' }], stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const rejection of [false, true]) test(`native accepted author draft yields only into fresh full review; initial rejection=${rejection}`, async () => {
  const events: AgentAuditEvent[] = [];
  let accepted = false, submits = 0, material = false, formal = false, epoch = false, previews = 0, requests = 0;
  const turns = [response(), response('submit_comparison_draft'), ...(rejection ? [response('submit_comparison_draft')] : []), response(), response('inspect_comparison_draft'), response('inspect_comparison_draft'), response('preview_report')];
  const models = { getModel: () => model, streamSimple: () => {
    requests++;
    const turn = turns.shift();
    assert.ok(turn, 'no extra author generation after accepted submission');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: turn.stopReason as 'stop' | 'toolUse', message: turn });
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'submit_comparison_draft', execute: async () => { submits++; accepted = !rejection || submits > 1; return { content: accepted ? 'status=accepted' : 'status=rejected' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { assert.equal(accepted, true); return { content: 'Actual accepted draft and important unknown' }; }, onCompleted: async () => { material = true; formal = epoch; } },
    { name: 'preview_report', execute: async () => { assert.equal(formal, true); previews++; return { content: 'Current inspected preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const value = { status: 'completed' as const, reportPath: 'report.html' as const, headline: 'Conditional result', evidenceRefs: [] };
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0 }).compare(context, tools, { append: async event => { events.push(event); } }, undefined, {
    hasAcceptedDraft: () => accepted,
    hasReviewDraftMaterial: () => material,
    hasCurrentReviewInspection: () => formal,
    onReviewStarted: () => { assert.equal(accepted, true); material = false; formal = false; },
    onDraftAuditStarted: () => { epoch = true; formal = false; },
    getSubmittedResult: async () => formal && previews === 1 ? value : undefined,
  });
  assert.equal(result.status, 'completed');
  assert.equal(submits, rejection ? 2 : 1);
  assert.equal(requests, rejection ? 7 : 6);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.deepEqual(phases.map(event => event.payload.pass ?? event.payload.phase), ['investigate', 'compose', 'sources', 'inspection', 'audit', 'preview']);
  assert.equal(phases[1]!.payload.yieldReason, 'author_draft_ready');
  assert.notEqual(phases[1]!.sessionId, phases[2]!.sessionId, 'source review uses a fresh independent session');
  assert.equal(phases[4]!.payload.yieldReason, 'final_inspection_ready');
  assert.equal(previews, 1);
});
