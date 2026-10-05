import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { sha256 } from '../../src/core/identity.js';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';

const context: ComparisonContext = { task: { caseId: 'case', summary: 'Compare' }, attemptId: 'attempt', baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
const resultValue = { status: 'completed' as const, reportPath: 'report.html' as const, headline: 'Scoped result', evidenceRefs: [] };

for (const mode of ['ready', 'late', 'verbal', 'unavailable', 'missing', 'hard', 'cancel', 'error', 'legacy'] as const) test(`actual draft inspection checkpoint protects delivery and execution: ${mode}`, async () => {
  const events: AgentAuditEvent[] = [], sessions: string[] = [];
  const exposures: { checkpoint: boolean; names: readonly string[] | undefined }[] = [];
  const controller = new AbortController();
  let material = false, formalInspection = false, checkpointCalls = 0, inspections = 0, expansions = 0, draftCalls = 0, previewed = false, generationAfterPreview = false;
  const host = new AgentHost({ createSession: input => {
    sessions.push(input.sessionId);
    return { append: async ({ content, signal, allowedToolNames, yieldAfterTurn }) => {
      const checkpoint = content.includes('This is the actual draft inspection checkpoint');
      exposures.push({ checkpoint, names: allowedToolNames });
      await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: exposures.length, images: [] });
      const call = (name: string) => input.tools.find(tool => tool.name === name)!.execute({}, signal);
      if (checkpoint) {
        checkpointCalls++;
        assert.equal(input.sessionId, sessions[1]);
        assert.deepEqual(allowedToolNames, ['inspect_comparison_draft']);
        if (mode === 'cancel') controller.abort();
        for (const name of ['read', 'update_comparison_findings', 'submit_comparison_draft', 'preview_report', 'write']) assert.match((await call(name)).content, /draft_inspection_only/);
        assert.equal(expansions, 0, 'adapter ignoring whitelist still has no expansion side effects');
        if (mode !== 'verbal' && !(mode === 'late' && checkpointCalls === 1)) await call('inspect_comparison_draft');
      } else if (content.includes('Now inspect') || content.includes('Now audit') || content.includes('Continue the current review turn')) {
        draftCalls++;
        assert.equal(input.sessionId, sessions[1]);
        if (mode !== 'legacy') assert.equal(material, true, 'actual delivered material precedes full draft audit');
        if (mode !== 'legacy' && draftCalls === 1) assert.match(content, /already delivered[\s\S]*Do not repeat inspection[\s\S]*new formal current inspection/);
        if (draftCalls === 1) { await call('inspect_comparison_draft'); await call('preview_report'); }
        else generationAfterPreview = previewed;
      }
      const reason = await yieldAfterTurn?.();
      return reason ? { status: 'yielded' as const, reason } : 'I have inspected the draft and will correct it.';
    }, cancel() {} };
  } });
  const inspect = { name: 'inspect_comparison_draft', description: 'actual full draft', parameters: Type.Object({}),
    execute: async () => { inspections++; if (mode === 'error') throw new Error('Actual inspection failed');
      const formal = mode !== 'unavailable' && (mode === 'legacy' || inspections > 1);
      return { content: mode === 'unavailable' ? '{"status":"unavailable"}' : JSON.stringify({ status: formal ? 'available' : 'stale', headline: 'Actual unsupported guarantee', comparisonHtml: 'Full comparison', detailsHtml: 'Actual folded limitation' }), details: { complete: mode !== 'unavailable', formal } }; },
    onCompleted: async (result: { details?: unknown }) => {
      if (typeof result.details === 'object' && result.details !== null && 'complete' in result.details && result.details.complete === true) material = true;
      if (typeof result.details === 'object' && result.details !== null && 'formal' in result.details && result.details.formal === true) formalInspection = true;
    },
  };
  const tools = [...(mode === 'missing' ? [] : [inspect]), ...['read', 'update_comparison_findings', 'submit_comparison_draft', 'preview_report', 'write'].map(name => ({ name, description: name, parameters: Type.Object({}), execute: async () => {
    expansions++; if (name === 'preview_report') previewed = true; return { content: 'Actual default tool result' };
  } }))];
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: mode === 'hard' ? { maxToolCalls: 0 } : {} });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, controller.signal, {
    ...(mode === 'legacy' ? {} : { hasReviewDraftMaterial: () => material }),
    getSubmittedResult: async () => generationAfterPreview && formalInspection ? resultValue : undefined,
  });
  if (mode === 'ready' || mode === 'late' || mode === 'legacy') {
    assert.equal(result.status, 'completed'); assert.equal(draftCalls, 2); assert.equal(generationAfterPreview, true);
    assert.equal(checkpointCalls, mode === 'legacy' ? 0 : mode === 'late' ? 2 : 1);
    assert.equal(sessions.length, 2, 'source, checkpoint and draft use one independent session');
    if (mode !== 'legacy') assert.equal(events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'inspection' && event.payload.outcome === 'yielded')!.payload.yieldReason, 'review_draft_material_ready');
  } else {
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(draftCalls, 0); assert.equal(expansions, 0); assert.equal(material, false);
    if (mode === 'verbal' || mode === 'unavailable') { assert.equal(checkpointCalls, 2); if (result.status === 'failed') assert.equal(result.failure.attempts, 2); }
    if (mode === 'missing') { assert.equal(checkpointCalls, 0); if (result.status === 'failed') assert.match(result.failure.message, /requires inspect_comparison_draft/); }
    if (mode === 'hard' || mode === 'cancel') assert.equal(inspections, 0);
    if (mode === 'error') assert.equal(inspections, 1);
  }
  assert.ok(exposures.filter(exposure => !exposure.checkpoint).every(exposure => exposure.names === undefined), 'all other passes preserve their ordinary tool exposure');
});

for (const mode of ['yielded', 'unlimited', 'legacy_timeout', 'cancel', 'hard', 'provider_error'] as const) test(`source local deadline preserves real publication and failure boundaries: ${mode}`, async t => {
  if (mode === 'hard') t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const events: AgentAuditEvent[] = [], sessions: string[] = [];
  const deadlines: { source: boolean; value: { at: number; reason: string } | undefined }[] = [];
  const controller = new AbortController();
  let inspected = false, previewed = false, inspectionInGeneration = false, draftCalls = 0, sourceRead = false;
  const host = new AgentHost({ createSession: input => {
    sessions.push(input.sessionId);
    return { append: async ({ content, signal, yieldDeadline }) => {
      const source = content.includes('This is the independent source pass');
      deadlines.push({ source, value: yieldDeadline });
      await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: deadlines.length, images: [] });
      if (source) {
        if (mode === 'unlimited') assert.equal(yieldDeadline, undefined);
        else { assert.equal(yieldDeadline?.reason, 'bounded_source_timeout'); assert.ok(yieldDeadline.at >= Date.now()); }
        if (mode === 'legacy_timeout') return await new Promise<string>(() => {});
        if (mode === 'provider_error') throw new Error('Actual provider error');
        await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
        if (mode === 'cancel') controller.abort();
        if (mode === 'hard') t.mock.timers.tick(600_000);
        return { status: 'yielded' as const, reason: 'bounded_source_timeout' };
      }
      if (content.includes('Now inspect') || content.includes('Continue the current review turn')) {
        draftCalls++;
        assert.equal(input.sessionId, sessions[1], 'draft audit retains the source session');
        assert.equal(sourceRead, true);
        if (draftCalls === 1) {
          assert.match(content, /not a completed-turn boundary or a completed assessment/);
          assert.match(content, /No visible assessment may have been produced[\s\S]*Unchecked guarantees remain unknown/);
          await input.tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
          await input.tools.find(tool => tool.name === 'preview_report')!.execute({}, signal);
        } else inspectionInGeneration = inspected && previewed;
      }
      return 'done';
    }, cancel() {} };
  } });
  const tools = [
    { name: 'read', execute: async () => { sourceRead = true; return { content: 'Actual retained counterexample from delivered output' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { inspected = true; return { content: 'Actual latest draft body' }; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Current accepted digest preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host, timeoutMs: mode === 'legacy_timeout' ? 5 : 1_000, maxRepairAttempts: 0,
    resources: mode === 'unlimited' ? {} : { investigationMs: 120_000, maxElapsedMs: 600_000 } });
  const comparison = agent.compare(context, tools, { append: async event => { events.push(event); } }, controller.signal, {
    getSubmittedResult: async () => inspectionInGeneration ? resultValue : undefined,
  });
  if (mode === 'hard') {
    await assert.rejects(comparison, /maxElapsedMs/);
    assert.equal(draftCalls, 0, 'whole hard limit after local yield prevents draft audit');
    return;
  }
  const result = await comparison;
  assert.ok(deadlines.some(call => call.source));
  assert.ok(deadlines.filter(call => !call.source).every(call => call.value === undefined), 'only independent sources receive the local deadline');
  if (mode === 'yielded' || mode === 'unlimited') {
    assert.equal(result.status, 'completed'); assert.equal(draftCalls, 2); assert.equal(sessions.length, 2);
    assert.equal(events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'sources')!.payload.yieldReason, 'bounded_source_timeout');
  } else {
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(draftCalls, 0, 'ordinary failure, hard limit and external cancel never become a draft audit');
    if (mode === 'legacy_timeout' && result.status === 'failed') assert.equal(result.failure.code, 'agent_timeout');
  }
});

for (const mode of ['saved', 'legacy', 'hard', 'cancel', 'error'] as const) test(`first findings checkpoint preserves execution boundaries: ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-first-findings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  const pending = { criteria: ['Task requirement read from INDEX.md'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable' as const, sourceRefs: [], description: 'Final source not yet located' })),
    findings: [], importantLimitations: ['Final outcomes not yet checked'],
    decisionQuestions: [{ id: 'finals', question: 'Do both finals satisfy the task?', decisionImpact: 'Changes replacement choice', status: 'pending' as const, nextCheck: 'Locate and compare final sources', evidenceRefs: [] }],
  };
  const controller = new AbortController();
  const events: AgentAuditEvent[] = [];
  let turns = 0, executed = 0, navigated = 0, composed = false, checkedBeforeCompose = false, sourcePassVisited = false;
  const checkNames = ['shell_exec', 'render_artifact', 'register_evidence'];
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal }) => {
    turns++;
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: turns, images: [] });
    const call = (name: string, params: unknown = {}) => input.tools.find(tool => tool.name === name)!.execute(params, signal);
    if (turns === 1) {
      if (mode === 'cancel') controller.abort();
      if (mode === 'hard' || mode === 'cancel') { await call('render_artifact'); return 'unreachable'; }
      await call('read'); await call('ls');
      assert.equal(navigated, 2);
      if (mode !== 'legacy') {
        for (const name of checkNames) assert.match((await call(name)).content, /findings_checkpoint_required/);
        assert.equal(executed, 0, 'denied tools have zero side effects');
        assert.match((await call('update_comparison_findings', {})).content, /status=rejected/);
        assert.equal(discovery.snapshot(), undefined);
        assert.match((await call('shell_exec')).content, /findings_checkpoint_required/, 'rejected save cannot unlock investigation');
        assert.match((await call('update_comparison_findings', pending)).content, /status=accepted/);
        assert.equal(discovery.readyToCompose(), false, 'minimal checkpoint is not compose readiness');
      }
      for (const name of checkNames) {
        const result = await call(name);
        if (mode !== 'legacy') {
          assert.ok(result.content.startsWith('actual result'));
          assert.equal(result.contentBlocks?.some(block => block.type === 'image'), false, 'text-only fixture must retain the Host image filtering boundary');
          assert.match(result.content, /Image content omitted: this model session does not accept image input/);
          assert.doesNotMatch(result.content, /findings_checkpoint_required/);
        }
      }
      return 'investigated';
    }
    if (content.includes('bounded closure turn')) {
      assert.equal(composed, false);
      assert.equal(discovery.readyToCompose(), false);
      assert.match(await discovery.update({ ...pending, decisionQuestions: [] }), /question_history_missing/);
      await call('update_comparison_findings', { ...pending, decisionQuestions: pending.decisionQuestions.map(question => ({ ...question, status: 'unavailable', resolution: 'Finals not accessible in this fixture' })) });
      checkedBeforeCompose = true;
    } else if (content.startsWith('Submit the report')) { composed = true; if (mode !== 'legacy') assert.equal(checkedBeforeCompose, true); }
    else if (content.includes('This is the independent source pass')) {
      sourcePassVisited = true;
      assert.doesNotMatch(content, /Task requirement read from INDEX.md/);
      assert.match((await call('update_comparison_findings', pending)).content, /source_review_not_ready/);
      await call('render_artifact');
    }
    return 'done';
  }, cancel() {} }) });
  const tools = [discovery.tool(), ...['read', 'ls'].map(name => ({ name, description: name, parameters: Type.Object({}), execute: async () => { navigated++; return { content: 'source read' }; } })),
    ...checkNames.map(name => ({ name, description: name, parameters: Type.Object({}), execute: async () => {
      executed++; if (mode === 'error') throw new Error('Actual check failed');
      return { content: 'actual result', contentBlocks: [{ type: 'image' as const, mimeType: 'image/png', data: 'fixture' }] };
    } })),
  ];
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: mode === 'hard' ? { maxModelRequests: 1 } : {} });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, controller.signal, {
    ...(mode !== 'legacy' ? { hasSavedFindings: () => discovery.snapshot() !== undefined, findingsReady: () => discovery.readyToCompose(), getFindingsState: () => discovery.state() } : {}),
    getSubmittedResult: async () => resultValue,
  });
  if (mode === 'hard' || mode === 'error') {
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.match(result.failure.message, mode === 'hard' ? /maxModelRequests/ : /comparison agent tool execution failed/);
  } else assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'completed');
  if (mode === 'cancel' || mode === 'hard') { assert.equal(executed, 0); assert.equal(discovery.snapshot(), undefined); }
  if (mode === 'error') {
    assert.equal(executed, 1, 'real tool failure is not converted to checkpoint feedback');
    const failures = events.filter(event => event.type === 'agent.tool_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.payload.tool, 'shell_exec');
    assert.equal(failures[0]!.payload.message, 'Actual check failed', 'Host public wrapper retains the actual failure in its audit');
  }
  if (mode === 'saved' || mode === 'legacy') {
    assert.equal(sourcePassVisited, true, 'independent source pass must actually execute');
    assert.equal(executed, 4, 'three investigation checks plus one independent source check');
  }
});

test('soft yield closes findings, carries incomplete source scope and waits for genuine generation-bound final readiness', async () => {
  const events: AgentAuditEvent[] = []; const prompts: string[] = [], allowedTools: (readonly string[] | undefined)[] = [];
  let findings = false, preview = false, inspected = false, inspectionInGeneration = false, reads = 0;
  let reviewTurns = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, yieldAfterTurn, allowedToolNames }) => {
    prompts.push(content);
    allowedTools.push(allowedToolNames);
    if (inspected && preview) inspectionInGeneration = true;
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: prompts.length, images: [] });
    if (content.includes('bounded closure turn')) {
      const denied = await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
      assert.match(denied.content, /closure_only/, 'legacy adapter ignoring the visible whitelist still cannot expand investigation');
      await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal);
    }
    else if (content.includes('independent source pass') && !content.includes('Now inspect')) await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
    else if (content.includes('Now inspect') || content.includes('Continue the current review turn')) {
      reviewTurns++;
      if (reviewTurns === 1) {
        await input.tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        await input.tools.find(tool => tool.name === 'preview_report')!.execute({}, signal);
      }
    } else if (!findings) await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
    await input.onModelUsage?.({ model: 'fixture', scope: 'generation', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
    const reason = await yieldAfterTurn?.();
    return reason ? { status: 'yielded' as const, reason } : 'done';
  }, cancel() {} }) });
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Actual source observations' }; } },
    { name: 'update_comparison_findings', execute: async () => { findings = true; return { content: 'status=accepted' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { inspected = true; return { content: 'Full actual inspection body' }; } },
    { name: 'preview_report', execute: async () => { preview = true; return { content: 'Validated preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { investigationModelRequests: 1, maxModelRequests: 40 } });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, undefined, {
    findingsReady: () => findings, getFindingsState: () => findings ? 'saved scoped findings' : 'missing findings',
    getSubmittedResult: async () => preview && inspectionInGeneration ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed');
  assert.equal(reviewTurns, 2);
  assert.equal(inspectionInGeneration, true);
  assert.equal(reads, 0, 'soft model boundary denies more investigation before side effects');
  assert.ok(prompts.some(prompt => prompt.includes('bounded closure turn')));
  prompts.forEach((prompt, index) => assert.deepEqual(allowedTools[index], prompt.includes('bounded closure turn') ? ['update_comparison_findings'] : undefined,
    'only findings closure restricts model-visible tools; compose/review keep their default tools'));
  assert.match(prompts.find(prompt => prompt.includes('Now inspect'))!, /pass is incomplete[\s\S]*Unchecked guarantees remain unknown/);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.find(event => event.payload.phase === 'investigate')!.payload.outcome, 'yielded');
  assert.equal(phases.find(event => event.payload.pass === 'findings')!.payload.yieldReason, 'findings_ready');
  assert.equal(phases.find(event => event.payload.pass === 'sources')!.payload.outcome, 'yielded');
  assert.equal(phases.at(-1)!.payload.yieldReason, 'report_ready');
  assert.equal(events.filter(event => event.type === 'agent.invocation_yielded').length, 4);
  assert.equal(events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 6);
});

const nativeModel: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function nativeMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: nativeModel.api, provider: nativeModel.provider, model: nativeModel.id, content, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function toolTurn(...names: string[]): AssistantMessage {
  return nativeMessage(names.map((name, index) => ({ type: 'toolCall', id: `${name}-${index}`, name, arguments: {} })));
}

for (const mode of ['success', 'provider', 'cancel', 'audit', 'hard'] as const) test(`native preview-only closure has no post-preview generation and preserves ${mode}`, async () => {
  const events: AgentAuditEvent[] = [], inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  const controller = new AbortController();
  let material = false, formal = false, previewed = false, inspections = 0, auditChanges = 0, previewCalls = 0;
  const stop = (text: string) => nativeMessage([{ type: 'text', text }], 'stop');
  const responses = [stop('Investigated'), stop('Composed'), stop('Independent source evidence'), toolTurn('inspect_comparison_draft'),
    toolTurn('update_comparison_findings', 'inspect_comparison_draft'), toolTurn('preview_report')];
  const models = { getModel: () => nativeModel, streamSimple: (_model: unknown, actual: unknown) => {
    const context = actual as typeof inputs[number];
    inputs.push({ tools: context.tools.map(tool => ({ name: tool.name })), messages: structuredClone(context.messages) });
    if (inputs.length === 6 && mode === 'provider') throw Object.assign(new Error('Actual preview generation upstream failure'), { status: 503 });
    const response = responses.shift();
    if (!response) throw new Error('A post-preview generation must not occur');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response });
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'update_comparison_findings', execute: async () => { auditChanges++; formal = false; return { content: 'Actual changed findings binding' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { inspections++; return { content: `Actual current binding inspection ${inspections}` }; }, onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previewCalls++; if (mode === 'cancel') controller.abort(); previewed = true; return { content: 'Actual exact-current-digest preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0, resources: mode === 'hard' ? { maxModelRequests: 5 } : {} });
  const comparison = agent.compare(context, tools, { append: async event => {
    events.push(event);
    if (mode === 'audit' && event.type === 'comparison.phase_completed' && event.payload.pass === 'preview') throw new Error('Actual preview audit persistence failure');
  } }, controller.signal, { hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
    getSubmittedResult: async () => formal && previewed ? resultValue : undefined });
  if (mode === 'audit') await assert.rejects(comparison, /Actual preview audit persistence failure/);
  else assert.equal((await comparison).status, mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(inputs.length, mode === 'hard' ? 5 : 6); assert.equal(inspections, 2); assert.equal(auditChanges, 1);
  assert.ok(!inputs[4]!.tools.some(tool => tool.name === 'preview_report'), 'full audit cannot preview');
  if (mode !== 'hard') {
    assert.deepEqual(inputs[5]!.tools.map(tool => tool.name), ['preview_report']);
    assert.match(JSON.stringify(inputs[5]!.messages), /Actual current binding inspection 2/);
  }
  assert.equal(previewCalls, mode === 'provider' || mode === 'hard' ? 0 : 1);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.find(event => event.payload.pass === 'audit')!.payload.yieldReason, 'final_inspection_ready');
  assert.ok(phases.some(event => event.payload.pass === 'preview'), 'preview phase audit must actually be attempted');
  if (mode !== 'audit') assert.equal(phases.find(event => event.payload.pass === 'preview')!.payload.outcome,
    mode === 'hard' || mode === 'provider' ? 'failed' : mode === 'cancel' ? 'cancelled' : 'yielded');
  if (mode === 'success') assert.equal(phases.at(-1)!.payload.yieldReason, 'report_ready');
});

test('preview closure execution guard returns changed bindings to a real full audit', async () => {
  let material = false, formal = false, previews = 0, audits = 0, closureInputs = 0, forbiddenEffects = 0;
  const inputs: string[] = [];
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, allowedToolNames, yieldAfterTurn }) => {
    inputs.push(content);
    const call = (name: string) => input.tools.find(tool => tool.name === name)!.execute({}, signal);
    if (content.includes('actual draft inspection checkpoint')) await call('inspect_comparison_draft');
    else if (content.includes('This is the preview-only closure')) {
      assert.deepEqual(allowedToolNames, ['preview_report']);
      for (const name of ['read', 'submit_comparison_draft', 'inspect_comparison_draft']) assert.match((await call(name)).content, /preview_closure_only/);
      if (++closureInputs === 1) formal = false;
      const response = await call('preview_report');
      if (closureInputs === 1) assert.match(response.content, /preview_closure_only/);
    } else if (content.includes('Now audit') || content.includes('Continue the current review turn')) {
      audits++;
      assert.ok(!allowedToolNames?.includes('preview_report'));
      assert.match((await call('preview_report')).content, /preview_not_ready/);
      await call('inspect_comparison_draft');
    }
    const reason = await yieldAfterTurn?.();
    return reason ? { status: 'yielded' as const, reason } : '';
  }, cancel() {} }) });
  const tools = ['read', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report'].map(name => ({ name, description: name, parameters: Type.Object({}), execute: async () => {
    if (name === 'inspect_comparison_draft') { material = true; formal = true; }
    else if (name === 'preview_report') previews++;
    else forbiddenEffects++;
    return { content: 'Actual tool result' };
  } }));
  const result = await new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} }).compare(context, tools, undefined, undefined, {
    hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal, getSubmittedResult: async () => formal && previews > 0 ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed'); assert.equal(audits, 2); assert.equal(closureInputs, 2); assert.equal(previews, 1); assert.equal(forbiddenEffects, 0);
  assert.ok(inputs.indexOf(inputs.find(text => text.includes('Now audit'))!) < inputs.indexOf(inputs.find(text => text.includes('This is the preview-only closure'))!), 'initial checkpoint cannot skip actual full audit');
});

for (const exhausted of [true, false]) test(`native formal audit ${exhausted ? 'hides exhausted' : 'retains available'} expansion tools`, async () => {
  const inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  let material = false, formal = false, previewed = false, expansions = 0, repairs = 0;
  const stop = (text: string) => nativeMessage([{ type: 'text', text }], 'stop');
  const responses = [stop('Investigated'), stop('Composed'), stop('Independent source evidence'), toolTurn('inspect_comparison_draft'),
    toolTurn('shell_exec', 'render_artifact', 'register_evidence', 'ls', 'grep', 'read', 'inspect_comparison_draft'), toolTurn('preview_report')];
  const models = { getModel: () => nativeModel, streamSimple: (_model: unknown, actual: unknown) => {
    const context = actual as typeof inputs[number];
    inputs.push({ tools: context.tools.map(tool => ({ name: tool.name })), messages: structuredClone(context.messages) });
    const response = responses.shift(); if (!response) throw new Error('Unexpected extra generation');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    ...['shell_exec', 'render_artifact', 'register_evidence', 'ls', 'grep'].map(name => ({ name, execute: async () => { expansions++; return { content: 'Actual expansion check' }; } })),
    { name: 'read', execute: async () => { repairs++; return { content: 'Actual registered repair page' }; } },
    ...['update_comparison_findings', 'submit_comparison_draft', 'quote_evidence', 'write', 'edit'].map(name => ({ name, execute: async () => ({ content: 'Actual repair tool' }) })),
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual formal current inspection' }), onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual current preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const result = await new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0,
    resources: exhausted ? { investigationModelRequests: 1 } : {} }).compare(context, tools, undefined, undefined, {
    hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal, isRepairRead: async () => true,
    getSubmittedResult: async () => formal && previewed ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed'); assert.equal(inputs.length, 6); assert.equal(expansions, exhausted ? 0 : 5); assert.equal(repairs, 1);
  const auditTools = inputs[4]!.tools.map(tool => tool.name);
  for (const name of ['shell_exec', 'render_artifact', 'register_evidence', 'ls', 'grep']) assert.equal(auditTools.includes(name), !exhausted);
  for (const name of ['read', 'inspect_comparison_draft', 'update_comparison_findings', 'submit_comparison_draft', 'quote_evidence', 'write', 'edit']) assert.ok(auditTools.includes(name));
  assert.deepEqual(inputs[5]!.tools.map(tool => tool.name), ['preview_report']);
  assert.match(JSON.stringify(inputs[5]!.messages), /Actual formal current inspection/);
});

test('an adapter ignoring exhausted audit exposure cannot execute expansion checks', async () => {
  let material = false, formal = false, previewed = false, expansions = 0, repairs = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, allowedToolNames, yieldAfterTurn }) => {
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    const call = (name: string) => input.tools.find(tool => tool.name === name)!.execute({}, signal);
    if (content.includes('actual draft inspection checkpoint')) await call('inspect_comparison_draft');
    else if (content.includes('This is the preview-only closure')) await call('preview_report');
    else if (content.includes('Now audit')) {
      for (const name of ['shell_exec', 'render_artifact', 'register_evidence', 'ls', 'grep']) {
        assert.ok(!allowedToolNames?.includes(name));
        assert.match((await call(name)).content, /review_investigation_limit/);
      }
      assert.ok(allowedToolNames?.includes('read'));
      await call('read'); await call('inspect_comparison_draft');
    }
    const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : '';
  }, cancel() {} }) });
  const tools = [
    ...['shell_exec', 'render_artifact', 'register_evidence', 'ls', 'grep'].map(name => ({ name, execute: async () => { expansions++; return { content: 'Forbidden expansion' }; } })),
    { name: 'read', execute: async () => { repairs++; return { content: 'Registered repair page' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { material = true; formal = true; return { content: 'Formal current inspection' }; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual current preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const result = await new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { investigationModelRequests: 1 } }).compare(context, tools, undefined, undefined, {
    hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal, isRepairRead: async () => true,
    getSubmittedResult: async () => formal && previewed ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed'); assert.equal(expansions, 0); assert.equal(repairs, 1);
});

test('native draft inspection checkpoint exposes one actual tool until delivery, then restores full audit', async () => {
  const events: AgentAuditEvent[] = [], inputs: { tools: { name: string }[]; messages: unknown[] }[] = [];
  let material = false, inspections = 0, reads = 0, changes = 0, previewed = false, laterGeneration = false;
  const stop = (text: string) => nativeMessage([{ type: 'text', text }], 'stop');
  const responses = [stop('Investigated'), stop('Composed'), stop('Actual source observations'), stop('I have inspected it.'),
    toolTurn('read', 'inspect_comparison_draft'), toolTurn('update_comparison_findings', 'inspect_comparison_draft', 'preview_report'), stop('Actual audit finished')];
  const models = { getModel: () => nativeModel, streamSimple: (_model: unknown, actual: unknown) => {
    const actualContext = actual as typeof inputs[number];
    inputs.push({ tools: actualContext.tools.map(tool => ({ name: tool.name })), messages: structuredClone(actualContext.messages) });
    if (previewed && JSON.stringify(actual).includes('Full actual accepted draft')) laterGeneration = true;
    const response = responses.shift();
    if (!response) throw new Error('Unexpected native request after report readiness');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response });
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Should not expand inspection checkpoint' }; } },
    { name: 'update_comparison_findings', execute: async () => { changes++; return { content: 'Actual revised findings' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { inspections++; return { content: 'Full actual accepted draft' }; }, onCompleted: async () => { material = true; } },
    { name: 'preview_report', execute: async () => { previewed = true; return { content: 'Actual current digest preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, undefined, {
    hasReviewDraftMaterial: () => material, getSubmittedResult: async () => laterGeneration ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed'); assert.equal(inspections, 2); assert.equal(reads, 0); assert.equal(changes, 1);
  assert.deepEqual(inputs[3]!.tools.map(tool => tool.name), ['inspect_comparison_draft']);
  assert.deepEqual(inputs[4]!.tools.map(tool => tool.name), ['inspect_comparison_draft']);
  assert.ok(inputs[5]!.tools.some(tool => tool.name === 'update_comparison_findings'));
  assert.match(JSON.stringify(inputs[5]!.messages), /Full actual accepted draft[\s\S]*Now audit/);
  assert.equal(events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'inspection').length, 2);
  assert.equal(events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'inspection' && event.payload.outcome === 'yielded')!.payload.yieldReason, 'review_draft_material_ready');
});

for (const mode of ['late', 'retry', 'verbal', 'hard', 'cancel', 'unexhausted'] as const) test(`native findings closure requires actual accepted readiness; ${mode}`, async () => {
  const events: AgentAuditEvent[] = [], inputs: string[] = [];
  const controller = new AbortController();
  let findings = false, submitted = false, updates = 0, reads = 0;
  const stop = (text: string) => nativeMessage([{ type: 'text', text }], 'stop');
  const closure = mode === 'late' ? [stop('I will save the findings.'), toolTurn('read', 'update_comparison_findings')]
    : mode === 'verbal' ? [stop('I will save the findings.'), stop('I will save the findings now.')]
      : mode === 'unexhausted' ? [toolTurn('read', 'render_artifact', 'register_evidence', 'shell_exec', 'submit_comparison_draft', 'update_comparison_findings')]
        : mode === 'cancel' ? [toolTurn('update_comparison_findings')]
        : [toolTurn('read', 'update_comparison_findings'), toolTurn('update_comparison_findings')];
  const responses = [stop('Investigated'), ...closure, stop('Composed'), stop('Source observations'), stop('Actual review completed')];
  const models = { getModel: () => nativeModel, streamSimple: (_model: unknown, modelContext: unknown) => {
    inputs.push(JSON.stringify(modelContext));
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra generation');
    if (response.content.some(block => block.type === 'text' && block.text === 'Actual review completed')) submitted = true;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response });
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Expansion should be denied' }; } },
    ...['render_artifact', 'register_evidence', 'shell_exec', 'submit_comparison_draft'].map(name => ({ name, execute: async () => { reads++; return { content: 'Closure side effect should be denied' }; } })),
    { name: 'update_comparison_findings', execute: async () => {
      updates++;
      findings = mode !== 'retry' && mode !== 'hard' || updates > 1;
      if (mode === 'cancel') controller.abort();
      return { content: findings ? 'status=accepted; readyToCompose=true' : 'status=invalid; preserve historical questions and retry the actual tool' };
    } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0,
    resources: { investigationModelRequests: mode === 'unexhausted' ? 40 : 1, maxModelRequests: mode === 'hard' ? 2 : 40 } });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, controller.signal, {
    findingsReady: () => findings, getFindingsState: () => findings ? 'actual accepted ready findings' : 'unchanged missing findings',
    getSubmittedResult: async () => submitted ? resultValue : undefined,
  });
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  const closures = phases.filter(event => event.payload.pass === 'findings');
  const composed = phases.find(event => event.payload.phase === 'compose');
  const visibleTools = inputs.map(input => (JSON.parse(input) as { tools: { name: string }[] }).tools.map(tool => tool.name));
  assert.deepEqual(visibleTools[0], tools.map(tool => tool.name));
  assert.ok(visibleTools.slice(1).some(names => names.length === 1 && names[0] === 'update_comparison_findings'), 'actual native closure input exposes only the existing findings tool');
  assert.equal(reads, 0, 'findings closure cannot expand investigation after its soft stop');
  if (mode === 'late' || mode === 'retry' || mode === 'unexhausted') {
    assert.equal(result.status, 'completed');
    assert.ok(composed);
    assert.equal(closures.length, mode === 'late' ? 2 : 1);
    assert.equal(closures.at(-1)!.payload.yieldReason, 'findings_ready');
    assert.equal(closures.at(-1)!.payload.modelRequests, mode === 'retry' ? 2 : 1);
    assert.equal(updates, mode === 'retry' ? 2 : 1);
    assert.deepEqual(visibleTools.at(-1), tools.map(tool => tool.name), 'tools are restored for the subsequent review generation');
    if (mode === 'late') {
      assert.equal(closures[0]!.payload.outcome, 'completed');
      assert.equal(closures[0]!.payload.yieldReason, undefined);
      assert.ok(inputs[2]!.includes('previous closure call did not produce an actually accepted ready findings update'));
      assert.ok(inputs[2]!.includes('do not give another verbal promise'));
    } else if (mode === 'retry') assert.ok(inputs[2]!.includes('status=invalid'), 'same invocation receives actual invalid feedback before tool retry');
    else assert.ok(inputs[2]!.includes('not found'), 'native closure rejects tools absent from its visible whitelist even with unused soft allowance');
  } else {
    assert.equal(composed, undefined);
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
    if (mode === 'verbal' && result.status === 'failed') {
      assert.equal(result.failure.attempts, 2);
      assert.equal(closures.length, 2);
      assert.equal(updates, 0);
      assert.equal(findings, false, 'verbal promises cannot fabricate saved findings');
    }
    if (mode === 'hard' && result.status === 'failed') assert.match(result.failure.message, /maxModelRequests/);
    assert.equal(closures.some(event => event.payload.yieldReason === 'findings_ready'), false, 'hard failure or cancellation wins over readiness');
  }
});

for (const mode of ['success', 'hard', 'tool_hard', 'cancel'] as const) test(`native draft closure continues internal repair turns after source soft exhaustion; ${mode} retains its boundary`, async t => {
  const events: AgentAuditEvent[] = []; const seen: string[] = [];
  const controller = new AbortController();
  const repairRoot = await mkdtemp(join(tmpdir(), 'reprise-phase-repair-'));
  t.after(() => rm(repairRoot, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: repairRoot, attemptId: 'attempt', links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  const saved = { criteria: ['Compare'], finals: [{ side: 'baseline' as const, status: 'unavailable' as const, sourceRefs: [], description: 'Unavailable' }, { side: 'candidate' as const, status: 'unavailable' as const, sourceRefs: [], description: 'Unavailable' }], findings: [], importantLimitations: [],
    decisionQuestions: Array.from({ length: 16 }, (_, i) => ({ id: `q${i}`, question: 'q'.repeat(900), decisionImpact: 'i'.repeat(900), status: 'unavailable' as const, resolution: 'r'.repeat(900), evidenceRefs: [] })) };
  await discovery.update(saved);
  const draft = new ComparisonDraft({ attemptRoot: repairRoot, task: 'Compare', facts: context.reportFacts, locale: 'en', catalog, deliveredImages: new Set(), discovery });
  await draft.submit({ status: 'completed', category: 'Result', headline: 'Scoped result', comparisonHtml: '<p>Scoped result.</p>' });
  await discovery.update({ ...saved, importantLimitations: ['Updated scope'] });
  const repairBody: unknown = JSON.parse((await draft.inspectTool().execute({}, controller.signal)).content);
  assert.ok(Value.Check(Type.Object({ status: Type.String(), repairContext: Type.Object({ fullHistory: Type.Object({ path: Type.String() }) }) }), repairBody));
  assert.equal(repairBody.status, 'stale');
  const repairParams = { path: repairBody.repairContext.fullHistory.path, maxBytes: 4096 };
  assert.equal(await draft.isRepairRead(repairParams), true);
  let expansionSideEffects = 0, repairReads = 0, repairChecks = 0, inspectCalls = 0, repaired = false, preview = false, delivered = false;
  const repairRead = () => nativeMessage([{ type: 'toolCall', id: `repair-read-${repairChecks}`, name: 'read', arguments: repairParams }]);
  const expansionTurn = toolTurn('read', 'render_artifact', 'register_evidence');
  expansionTurn.content.push({ type: 'toolCall', id: 'registered-repair-read', name: 'read', arguments: repairParams });
  const responses = [nativeMessage([{ type: 'text', text: 'investigated' }], 'stop'), nativeMessage([{ type: 'text', text: 'composed' }], 'stop'),
    repairRead(), expansionTurn, toolTurn('inspect_comparison_draft'),
    toolTurn('update_comparison_findings'), toolTurn('submit_comparison_draft'), toolTurn('inspect_comparison_draft'), toolTurn('preview_report'),
    nativeMessage([{ type: 'text', text: 'Reviewed the actual final inspection and preview' }], 'stop')];
  const models = { getModel: () => nativeModel, streamSimple: (_model: unknown, modelContext: unknown) => {
    const serialized = JSON.stringify(modelContext); seen.push(serialized);
    if (serialized.includes('ACTUAL-CURRENT-INSPECTION') && serialized.includes('ACTUAL-CURRENT-PREVIEW')) delivered = true;
    const response = responses.shift(); if (!response) throw new Error('Unexpected extra request');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response });
    return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const tools = [
    { name: 'read', execute: async () => { repairReads++; return { content: (await readFile(join(repairRoot, repairParams.path))).subarray(0, repairParams.maxBytes).toString('utf8') }; } },
    ...['render_artifact', 'register_evidence'].map(name => ({ name, execute: async () => { expansionSideEffects++; return { content: 'expansion executed' }; } })),
    { name: 'inspect_comparison_draft', execute: async () => { inspectCalls++; return { content: repaired ? 'ACTUAL-CURRENT-INSPECTION' : 'status=stale_inspection; complete history repair material' }; } },
    { name: 'update_comparison_findings', execute: async () => ({ content: 'status=accepted; historical questions preserved' }) },
    { name: 'submit_comparison_draft', execute: async () => { repaired = true; if (mode === 'cancel') controller.abort(); return { content: 'status=accepted; repaired binding' }; } },
    { name: 'preview_report', execute: async () => { preview = true; return { content: 'ACTUAL-CURRENT-PREVIEW' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: tool.name === 'read' ? Type.Object({ path: Type.Optional(Type.String()), maxBytes: Type.Optional(Type.Number()) }) : Type.Object({}) }));
  const agent = new ComparisonAgent({ host: new AgentHost(caller), timeoutMs: 1_000, maxRepairAttempts: 0, resources: { investigationModelRequests: 1, maxModelRequests: mode === 'hard' ? 7 : 40, ...(mode === 'tool_hard' ? { maxToolCalls: 1 } : {}) } });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, controller.signal, {
    findingsReady: () => true, getSubmittedResult: async () => repaired && preview && delivered ? resultValue : undefined,
    isRepairRead: async params => { repairChecks++; return draft.isRepairRead(params); },
  });
  assert.equal(expansionSideEffects, 0);
  assert.equal(repairReads, mode === 'tool_hard' ? 0 : 1, 'only the registered draft repair page may execute; ordinary and source-pass reads stay blocked');
  assert.equal(repairChecks, mode === 'tool_hard' ? 0 : 2, 'hard limits and source pass must not even consult the repair exception predicate');
  assert.ok(seen.some(input => input.includes('reviewModelRequests') || input.includes('reserve_finish')));
  const source = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'sources')!;
  assert.equal(source.payload.outcome, 'yielded');
  if (mode === 'success') {
    assert.equal(result.status, 'completed'); assert.equal(seen.length, 10); assert.equal(inspectCalls, 2); assert.equal(delivered, true);
    const draft = events.filter(event => event.type === 'comparison.phase_completed' && event.payload.phase === 'review' && event.payload.pass !== 'sources');
    assert.equal(draft.length, 1, 'internal repair turns must not consume repeated Host no-progress exits');
    assert.equal(draft[0]!.payload.modelRequests, 7); assert.equal(draft[0]!.payload.yieldReason, 'report_ready');
    assert.ok(seen.at(-1)!.includes('ACTUAL-CURRENT-INSPECTION')); assert.ok(seen.at(-1)!.includes('ACTUAL-CURRENT-PREVIEW'));
    assert.match(seen[4]!, /decisionQuestions/);
    assert.equal(seen[3]!.includes('q'.repeat(64)), false, 'the source pass could not load historical author question bodies');
    assert.equal(seen[4]!.includes('q'.repeat(64)), true, 'the next draft generation actually receives the registered repair page');
  } else if (mode === 'hard' || mode === 'tool_hard') {
    assert.equal(result.status, 'failed'); if (result.status === 'failed') assert.match(result.failure.message, mode === 'hard' ? /maxModelRequests/ : /maxToolCalls/);
    assert.equal(preview, false); assert.equal(delivered, false); assert.equal(seen.length, mode === 'hard' ? 7 : 4);
  } else {
    assert.equal(result.status, 'cancelled'); assert.equal(preview, false); assert.equal(delivered, false);
  }
});

test('hard model exhaustion is failed, never a source yield or publishable result', async () => {
  const events: AgentAuditEvent[] = [];
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, yieldAfterTurn }) => {
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : 'done';
  }, cancel() {} }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { maxModelRequests: 2 } });
  const result = await agent.compare(context, [], { append: async event => { events.push(event); } }, undefined, { getSubmittedResult: async () => resultValue });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.match(result.failure.message, /maxModelRequests/);
  assert.equal(events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 2);
});

test('cancellation during final asynchronous result validation cannot return completed', async () => {
  const controller = new AbortController();
  let turns = 0;
  const host = new AgentHost({ createSession: () => ({ append: async () => { turns++; return 'done'; }, cancel() {} }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0 });
  const result = await agent.compare(context, [], undefined, controller.signal, { getSubmittedResult: async () => {
    controller.abort();
    return resultValue;
  } });
  assert.equal(turns, 4);
  assert.equal(result.status, 'cancelled');
});

for (const mode of ['cancel', 'elapsed'] as const) test(`repair read predicate IO cannot bypass ${mode} while awaiting its result`, async t => {
  if (mode === 'elapsed') t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const controller = new AbortController();
  let started!: () => void, release!: (allowed: boolean) => void;
  const events: AgentAuditEvent[] = [];
  const predicateStarted = new Promise<void>(resolve => { started = resolve; });
  const predicate = new Promise<boolean>(resolve => { release = resolve; });
  let turns = 0, executed = 0, completionChecks = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, yieldAfterTurn }) => {
    turns++;
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: turns, images: [] });
    if (turns === 4) await input.tools[0]!.execute({ path: 'scratch/registered-history.json', maxBytes: 4096 }, signal);
    const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : 'done';
  }, cancel() {} }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { investigationModelRequests: 1, maxElapsedMs: 100 } });
  const pending = agent.compare(context, [{ name: 'read', description: 'bounded history read', parameters: Type.Object({ path: Type.String(), maxBytes: Type.Number() }), execute: async () => { executed++; return { content: 'history' }; } }], { append: async event => { events.push(event); } }, controller.signal, {
    findingsReady: () => true, isRepairRead: () => { started(); return predicate; },
    getSubmittedResult: async () => { completionChecks++; return undefined; },
  });
  await predicateStarted;
  if (mode === 'cancel') controller.abort(); else t.mock.timers.tick(101);
  release(true);
  const result = await pending;
  assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
  if (result.status === 'failed') {
    assert.equal(result.failure.kind, 'tool');
    assert.match(String(events.find(event => event.type === 'agent.tool_failed')?.payload.message), /maxElapsedMs/);
  }
  assert.equal(executed, 0); assert.equal(completionChecks, 0); assert.equal(turns, 4);
});
