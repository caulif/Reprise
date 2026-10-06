import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComparisonFindingsCheckpoints } from '../../src/agents/comparison-findings-checkpoints.js';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { ComparisonFindingsDeltaSchema, type ComparisonFindingsDelta, type ComparisonFindingsSubmission } from '../../src/core/schema.js';
import type { AgentToolDefinition, FreeformInvocation } from '../../src/infrastructure/agent/host.js';
import type { ComparisonWorkPass } from '../../src/agents/comparison-invocation-boundaries.js';

const signal = new AbortController().signal;
const sourceNames = ['read', 'ls', 'grep', 'shell_exec', 'render_artifact', 'register_evidence', 'quote_evidence'];
const yieldResult = (reason: string): FreeformInvocation => ({ status: 'yielded', sessionId: 'same-session', reason });

function harness(receipt = 'status=accepted\nSaved current state') {
  let state = 'Actual current saved hypotheses', ready = false, effects = 0, completions = 0;
  const definitions: AgentToolDefinition[] = [...sourceNames, 'write', 'preview_report', 'update_comparison_findings', 'update_comparison_findings_delta'].map(name => ({
    name, description: name, parameters: name === 'update_comparison_findings_delta' ? ComparisonFindingsDeltaSchema : Type.Object({}),
    execute: async () => { effects++; return { content: name.startsWith('update_') ? receipt : 'Source boundary fixture result' }; },
    onCompleted: async () => { completions++; },
  }));
  const checkpoints = new ComparisonFindingsCheckpoints(definitions, { getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true,
    reviewFindings: true, getFindingsState: () => state, findingsReady: () => ready });
  const tools = checkpoints.bind(definitions);
  return { checkpoints, definitions, tools, tool: (name: string) => tools.find(tool => tool.name === name)!,
    state: (value: string) => { state = value; }, ready: () => { ready = true; }, effects: () => effects, completions: () => completions };
}

test('six actual source effects force a checkpoint and execute/completion reject the next check', async () => {
  const f = harness(); f.checkpoints.begin('investigate');
  for (const name of sourceNames.slice(0, 6)) await f.tool(name).execute({}, signal);
  assert.equal(f.checkpoints.due(), true); assert.equal(f.effects(), 6);
  const seventh = await f.tool('quote_evidence').execute({}, signal);
  assert.match(seventh.content, /findings_checkpoint_required/);
  await f.tool('quote_evidence').onCompleted?.(seventh);
  assert.equal(f.effects(), 6); assert.equal(f.completions(), 0);
});

test('save-only exposes the dedicated delta object schema and blocks original full-schema tool and effects', async () => {
  const f = harness(); f.checkpoints.begin('investigate', 'source-save');
  assert.deepEqual(f.checkpoints.toolNames(), ['update_comparison_findings_delta']);
  assert.equal(f.tool('update_comparison_findings_delta').parameters, ComparisonFindingsDeltaSchema);
  assert.equal('anyOf' in f.tool('update_comparison_findings_delta').parameters, false);
  for (const tool of f.tools.filter(tool => tool.name !== 'update_comparison_findings_delta')) {
    const denied = await tool.execute({}, signal); assert.match(denied.content, /findings_checkpoint_required/);
    await tool.onCompleted?.(denied);
  }
  assert.equal(f.effects(), 0); assert.equal(f.completions(), 0); assert.equal(f.checkpoints.saved(), false);
});

async function productionFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-source-checkpoint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], findings: [], importantLimitations: [],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final remains unknown' })),
    decisionQuestions: [{ id: 'quality', question: 'Is the actual final useful?', decisionImpact: 'Could reverse preference', status: 'pending', evidenceRefs: [], nextCheck: 'Inspect the actual final' }] };
  assert.match((await discovery.tool().execute(initial, signal)).content, /^status=accepted\n/);
  let reads = 0;
  const definitions: AgentToolDefinition[] = [discovery.tool(), discovery.deltaTool(), {
    name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => { reads++; return { content: 'Unverified boundary fixture input; no quality evidence.' }; },
  }];
  const checkpoints = new ComparisonFindingsCheckpoints(definitions, { getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true,
    reviewFindings: true, getFindingsState: () => discovery.state(), findingsReady: () => discovery.readyToCompose() });
  const tools = checkpoints.bind(definitions);
  const delta = (): ComparisonFindingsDelta => {
    const current = discovery.snapshot()!;
    return { kind: 'delta', binding: { revision: current.revision, digest: current.digest, catalogRevision: catalog.snapshot().revision },
      findingDecisions: [], questionDecisions: current.submission.decisionQuestions.map(question => ({ id: question.id, action: 'retain' })) };
  };
  return { discovery, checkpoints, tools, delta, reads: () => reads };
}

for (const phase of ['investigate', 'review'] as const) for (const ready of [false, true]) test(`actual ${phase} checkpoint ${ready ? 'ends on ready unknown disposition' : 'accepts pending and resumes the same source session'}`, async t => {
  const f = await productionFixture(t), passes: (ComparisonWorkPass | undefined)[] = [];
  const outcome = await f.checkpoints.run(async (currentPhase, prompt, pass) => {
    assert.equal(currentPhase, phase); passes.push(pass); f.checkpoints.begin(currentPhase, pass);
    if (pass === 'source-save') {
      assert.match(prompt, /addedFindings\/addedQuestions[\s\S]*Pending with an actual nextCheck is valid/);
      const change = f.delta();
      if (ready) change.questionDecisions[0] = { id: 'quality', action: 'replace', replacement: { ...f.discovery.snapshot()!.submission.decisionQuestions[0]!,
        status: 'unavailable', resolution: 'The fixture did not check actual quality; this could reverse preference' } };
      assert.match((await f.tools.find(tool => tool.name === 'update_comparison_findings_delta')!.execute(change, signal)).content, /^status=accepted\n/);
      return yieldResult('findings_checkpoint_saved');
    }
    if (passes.length === 1) {
      for (let i = 0; i < 6; i++) await f.tools.find(tool => tool.name === 'read')!.execute({}, signal);
      assert.equal(f.checkpoints.due(), true); return yieldResult('findings_checkpoint_required');
    }
    assert.match(prompt, /Continue only the remaining decision-changing source questions/);
    assert.equal(f.checkpoints.due(), false);
    await f.tools.find(tool => tool.name === 'read')!.execute({}, signal);
    return { status: 'completed', sessionId: 'same-session', value: {} };
  }, phase, 'Source task', phase === 'review' ? 'sources' : undefined);
  assert.equal(outcome.sessionId, 'same-session'); assert.equal(f.reads(), ready ? 6 : 7);
  assert.deepEqual(passes, ready ? [phase === 'review' ? 'sources' : undefined, 'source-save']
    : [phase === 'review' ? 'sources' : undefined, 'source-save', phase === 'review' ? 'sources' : undefined]);
  if (ready) assert.deepEqual(outcome, yieldResult(phase === 'investigate' ? 'findings_ready' : 'independent_findings_ready'));
  else { assert.equal(outcome.status, 'completed'); assert.equal(f.discovery.readyToCompose(), false); }
});

for (const mode of ['fake', 'empty', 'stale', 'timeout', 'output_limit', 'no-update'] as const) test(`checkpoint ${mode} cannot resume source effects`, async () => {
  const f = harness(mode === 'fake' ? 'status=accepted_by_assumption' : undefined), passes: (ComparisonWorkPass | undefined)[] = [];
  const outcome = await f.checkpoints.run(async (phase, _prompt, pass) => {
    passes.push(pass); f.checkpoints.begin(phase, pass);
    if (pass !== 'source-save') return yieldResult('findings_checkpoint_required');
    if (mode === 'empty') f.state('');
    if (mode !== 'no-update') await f.tool('update_comparison_findings_delta').execute({}, signal);
    if (mode === 'stale') f.state('A later actual state changed');
    if (mode === 'timeout' || mode === 'output_limit') return yieldResult(mode === 'timeout' ? 'bounded_investigation_timeout' : 'output_limit');
    return { status: 'completed', sessionId: 'same-session', value: {} };
  }, 'investigate', 'Source task');
  assert.deepEqual(passes, [undefined, 'source-save']);
  assert.equal(outcome.status, mode === 'timeout' || mode === 'output_limit' ? 'yielded' : 'failed');
});

test('checkpoint continuation is bounded to five saves and preserves the final due boundary', async () => {
  const f = harness(); let saves = 0, sourceCalls = 0;
  const outcome = await f.checkpoints.run(async (phase, _prompt, pass) => {
    f.checkpoints.begin(phase, pass);
    if (pass === 'source-save') { saves++; await f.tool('update_comparison_findings_delta').execute({}, signal); return yieldResult('findings_checkpoint_saved'); }
    sourceCalls++; return yieldResult('findings_checkpoint_required');
  }, 'investigate', 'Source task');
  assert.equal(saves, 5); assert.equal(sourceCalls, 6); assert.deepEqual(outcome, yieldResult('findings_checkpoint_required'));
});

test('checkpoint is opt-in and missing current state or delta tool preserves existing callers', () => {
  const f = harness();
  assert.equal(new ComparisonFindingsCheckpoints(f.definitions).enabled, false);
  const old = new ComparisonFindingsCheckpoints(f.definitions.filter(tool => tool.name !== 'update_comparison_findings_delta'), {
    getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true, reviewFindings: true, getFindingsState: () => 'state',
  });
  assert.equal(old.enabled, false); assert.deepEqual(old.bind(f.definitions), f.definitions);
  old.begin('investigate', 'source-save'); assert.equal(old.toolNames(), undefined); assert.equal(old.due(), false);
});
