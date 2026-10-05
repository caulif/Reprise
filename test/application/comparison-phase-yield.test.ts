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

test('soft yield closes findings, carries incomplete source scope and waits for genuine generation-bound final readiness', async () => {
  const events: AgentAuditEvent[] = []; const prompts: string[] = [];
  let findings = false, preview = false, inspected = false, inspectionInGeneration = false, reads = 0;
  let reviewTurns = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, yieldAfterTurn }) => {
    prompts.push(content);
    if (inspected && preview) inspectionInGeneration = true;
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: prompts.length, images: [] });
    if (content.includes('bounded closure turn')) await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal);
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
  assert.equal(reads, 0, 'findings closure cannot expand investigation after its soft stop');
  if (mode === 'late' || mode === 'retry' || mode === 'unexhausted') {
    assert.equal(result.status, 'completed');
    assert.ok(composed);
    assert.equal(closures.length, mode === 'late' ? 2 : 1);
    assert.equal(closures.at(-1)!.payload.yieldReason, 'findings_ready');
    assert.equal(closures.at(-1)!.payload.modelRequests, mode === 'retry' ? 2 : 1);
    assert.equal(updates, mode === 'retry' ? 2 : 1);
    if (mode === 'late') {
      assert.equal(closures[0]!.payload.outcome, 'completed');
      assert.equal(closures[0]!.payload.yieldReason, undefined);
      assert.ok(inputs[2]!.includes('previous closure call did not produce an actually accepted ready findings update'));
      assert.ok(inputs[2]!.includes('do not give another verbal promise'));
    } else if (mode === 'retry') assert.ok(inputs[2]!.includes('status=invalid'), 'same invocation receives actual invalid feedback before tool retry');
    else assert.ok(inputs[2]!.includes('closure_only'), 'closure rejects investigation even with unused soft allowance');
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
