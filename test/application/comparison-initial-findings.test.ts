import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonInitialFindings, COMPARISON_INITIAL_FINDINGS_PROMPT, composeComparisonInvestigatorSystemPrompt } from '../../src/agents/comparison-initial-findings.js';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentToolDefinition } from '../../src/infrastructure/agent/host.js';
import { sha256 } from '../../src/core/identity.js';

const strict = { getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true, reviewFindings: true };
const signal = () => new AbortController().signal;
test('strict initial persistence exposes only actual update and denies forced reads, checks and callbacks', async () => {
  let saved = false, effects = 0;
  const names = ['read', 'shell_exec', 'render_artifact', 'register_evidence', 'write', 'inspect_comparison_draft', 'preview_report'];
  const tools: AgentToolDefinition[] = names.map(name => ({ name, description: name, parameters: Type.Object({}), execute: async () => { effects++; return { content: 'effect' }; }, onCompleted: async () => { effects++; } }));
  tools.push({ name: 'update_comparison_findings', description: 'Save', parameters: Type.Object({}), execute: async () => { saved = true; return { content: 'status=accepted\nreadyToCompose=false' }; } });
  const helper = new ComparisonInitialFindings({ ...strict, hasSavedFindings: () => saved }); helper.begin('initial-findings');
  assert.deepEqual(helper.toolNames(tools), ['update_comparison_findings']); assert.equal(helper.saved(), false);
  const bound = helper.bind(tools);
  for (const tool of bound.slice(0, -1)) { const result = await tool.execute({}, signal()); assert.match(result.content, /initial_findings_only/); await tool.onCompleted?.(result); }
  assert.equal(effects, 0); await bound.at(-1)!.execute({}, signal()); assert.equal(helper.saved(), true, 'an accepted pending snapshot is sufficient for persistence, not semantic readiness');
  helper.begin(); assert.equal(helper.toolNames(tools), undefined); await bound[0]!.execute({}, signal()); assert.equal(effects, 1);
});

test('initial checkpoint requires actual accepted receipt and current saved state; errors and cancellation propagate', async () => {
  let receipt = 'status=rejected', saved = true;
  const helper = new ComparisonInitialFindings({ ...strict, hasSavedFindings: () => saved }); helper.begin('initial-findings');
  const raw: AgentToolDefinition = { name: 'update_comparison_findings', description: 'Save', parameters: Type.Object({}), execute: async () => ({ content: receipt }) };
  const bound = helper.bind([raw])[0]!; await bound.execute({}, signal()); assert.equal(helper.saved(), false, 'old saved state cannot replace an accepted update');
  receipt = 'status=accepted'; saved = false; await bound.execute({}, signal()); assert.equal(helper.saved(), false, 'receipt alone cannot fabricate persisted state');
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled')); await assert.rejects(bound.execute({}, cancelled.signal), /cancelled/);
  const failure = new Error('persist failed'); await assert.rejects(helper.bind([{ ...raw, execute: async () => { throw failure; } }])[0]!.execute({}, signal()), error => error === failure);
});

test('legacy and independent review retain tool identity/default exposure; investigator role is short and localized', () => {
  const raw: AgentToolDefinition = { name: 'read', description: 'Read', parameters: Type.Object({}), execute: async () => ({ content: 'source' }) };
  for (const options of [undefined, strict, { ...strict, reviewFindings: false }, { ...strict, enforcePhaseBoundaries: false }, { reviewFindings: true, enforcePhaseBoundaries: true }]) {
    const helper = new ComparisonInitialFindings(options); helper.begin('initial-findings'); assert.equal(helper.needed(), false); assert.equal(helper.bind([raw])[0], raw); assert.equal(helper.toolNames([raw]), undefined);
  }
  const helper = new ComparisonInitialFindings(strict); helper.begin('review-findings'); assert.equal(helper.toolNames([raw]), undefined);
  assert.match(composeComparisonInvestigatorSystemPrompt('zh'), /Simplified Chinese/); assert.match(composeComparisonInvestigatorSystemPrompt('en'), /Report prose.*English/);
  assert.ok(composeComparisonInvestigatorSystemPrompt('en').length < 1600); assert.doesNotMatch(composeComparisonInvestigatorSystemPrompt('en'), /Final JSON|Return.*JSON/);
});

const context: ComparisonContext = { attemptId: 'checkpoint', task: { caseId: 'case', summary: 'Compare actual output' }, baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true, replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
test('pending actual initial save allows investigation within the same 120ms budget then existing Host deadline closure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 }); let saved = false, ready = false, closed = 0, reads = 0, requests = 0;
  const deadlines: number[] = [];
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, allowedToolNames, yieldDeadline, yieldAfterTurn }) => {
    requests++; await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    if (content.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
      assert.deepEqual(allowedToolNames, ['update_comparison_findings']); deadlines.push(yieldDeadline!.at);
      assert.match((await input.tools.find(t => t.name === 'read')!.execute({}, signal)).content, /initial_findings_only/); t.mock.timers.tick(30);
      await input.tools.find(t => t.name === 'update_comparison_findings')!.execute({}, signal); assert.equal(await yieldAfterTurn?.(), 'initial_findings_saved');
      return { status: 'yielded' as const, reason: 'initial_findings_saved' };
    }
    assert.ok(saved); assert.deepEqual(allowedToolNames, ['read', 'update_comparison_findings']); deadlines.push(yieldDeadline!.at);
    await input.tools.find(t => t.name === 'read')!.execute({}, signal); t.mock.timers.tick(91);
    return { status: 'yielded' as const, reason: 'bounded_investigation_timeout' };
  }, cancel() {} }) });
  const controller = new AbortController();
  const result = await new ComparisonAgent({ host, timeoutMs: 1000, maxRepairAttempts: 0, resources: { investigationMs: 120 } }).compare(context,
    [{ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => { reads++; return { content: 'Actual source' }; } },
      { name: 'update_comparison_findings', description: 'save', parameters: Type.Object({}), execute: async () => { saved = true; return { content: 'status=accepted\nreadyToCompose=false' }; } }], undefined, controller.signal,
    { ...strict, hasSavedFindings: () => saved, findingsReady: () => ready, closeBoundedInvestigation: async () => { closed++; ready = true; controller.abort(); } });
  assert.equal(result.status, 'cancelled'); assert.equal(closed, 1); assert.equal(reads, 1); assert.equal(requests, 2);
  assert.deepEqual(deadlines, [1120, 1120], 'initial persistence consumes the original investigation deadline instead of granting a fresh budget');
});

test('initial deadline with no saved record keeps the existing actual findings-only recovery and cannot invent Host closure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 }); let saved = false, ready = false, closed = 0, reads = 0, initialCalls = 0, recoveryCalls = 0;
  const controller = new AbortController();
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, allowedToolNames, yieldAfterTurn }) => {
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    if (content.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
      initialCalls++; assert.deepEqual(allowedToolNames, ['update_comparison_findings']); t.mock.timers.tick(121);
      return { status: 'yielded' as const, reason: 'bounded_investigation_timeout' };
    }
    assert.match(content, /bounded closure turn/); recoveryCalls++; assert.deepEqual(allowedToolNames, ['update_comparison_findings']);
    await input.tools.find(t => t.name === 'update_comparison_findings')!.execute({}, signal);
    assert.equal(await yieldAfterTurn?.(), 'findings_ready'); controller.abort(); return { status: 'yielded' as const, reason: 'findings_ready' };
  }, cancel() {} }) });
  const result = await new ComparisonAgent({ host, timeoutMs: 1000, maxRepairAttempts: 0, resources: { investigationMs: 120 } }).compare(context,
    [{ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => { reads++; return { content: 'source' }; } },
      { name: 'update_comparison_findings', description: 'save', parameters: Type.Object({}), execute: async () => { saved = ready = true; return { content: 'status=accepted' }; } }], undefined, controller.signal,
    { ...strict, hasSavedFindings: () => saved, findingsReady: () => ready, closeBoundedInvestigation: async () => { closed++; } });
  assert.equal(result.status, 'cancelled'); assert.equal(initialCalls, 1); assert.equal(recoveryCalls, 1); assert.equal(closed, 0); assert.equal(reads, 0); assert.equal(saved, true);
});

for (const mode of ['persist_failure', 'cancel'] as const) test(`initial actual update ${mode} never enters investigation or author`, async () => {
  const controller = new AbortController(); let sessions = 0, requests = 0, reads = 0;
  const host = new AgentHost({ createSession: input => { sessions++; return { append: async ({ content, signal }) => {
    requests++; await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    await input.tools.find(t => t.name === 'update_comparison_findings')!.execute({}, signal); return 'saved';
  }, cancel() {} }; } });
  const result = await new ComparisonAgent({ host, timeoutMs: 1000, maxRepairAttempts: 0 }).compare(context,
    [{ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => { reads++; return { content: 'source' }; } },
      { name: 'update_comparison_findings', description: 'save', parameters: Type.Object({}), execute: async () => {
        if (mode === 'persist_failure') throw new Error('persist failed'); controller.abort(); return { content: 'status=accepted' };
      } }], undefined, controller.signal, { ...strict, hasSavedFindings: () => false, findingsReady: () => false });
  assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed'); assert.equal(sessions, 1); assert.equal(requests, 1); assert.equal(reads, 0);
});
