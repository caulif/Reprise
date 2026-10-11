import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';

const context: ComparisonContext = { task: { caseId: 'review-save', summary: 'Compare recorded deliveries.' }, attemptId: 'review-save',
  baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'baseline', candidate: 'candidate' },
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'test' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } } };

for (const mode of ['checkpoint', 'interrupted-source', 'closure-timeout', 'save-timeout', 'save-timeout-no-update', 'inspection-timeout'] as const) test(`slow review save preserves actual closure and publication boundaries: ${mode}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let requests = 0, updates = 0, material = false, formal = false, audits = 0, previews = 0;
  const events: AgentAuditEvent[] = [];
  const saveTimeout = mode === 'save-timeout' || mode === 'save-timeout-no-update';
  const fails = mode === 'closure-timeout' || mode === 'inspection-timeout' || mode === 'save-timeout-no-update';
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, yieldDeadline, allowedToolNames }) => {
    await input.onModelRequest?.({ model: 'fixture', digest: 'a'.repeat(64), messageCount: ++requests, images: [] });
    const tool = (name: string) => input.tools.find(tool => tool.name === name)!;
    if (requests === 1) t.mock.timers.tick(110_000);
    else if (requests === 2) t.mock.timers.tick(saveTimeout ? 26_000 : 60_000);
    else if (requests === 3) {
      t.mock.timers.tick(mode === 'checkpoint' ? 94_000 : saveTimeout ? 76_000 : 110_000);
      return { status: 'yielded', reason: mode === 'checkpoint' || saveTimeout ? 'findings_checkpoint_required' : 'bounded_source_timeout' };
    } else if (content.includes('SAVE ONLY:') || content.includes('independent review findings closure')) {
      assert.deepEqual(allowedToolNames, ['update_comparison_findings_delta']);
      const saving = content.includes('SAVE ONLY:');
      assert.equal(yieldDeadline?.at, saving ? saveTimeout ? 303_000 : 355_000 : 361_000);
      const delay = mode === 'closure-timeout' || (saveTimeout && saving) ? 90_000 : saveTimeout ? 10_000 : 63_000;
      if (Date.now() + delay >= yieldDeadline.at) {
        t.mock.timers.tick(yieldDeadline.at - Date.now());
        return { status: 'yielded', reason: yieldDeadline.reason };
      }
      t.mock.timers.tick(delay);
      if (mode === 'save-timeout-no-update') return 'A promise to save is not an accepted findings update.';
      const saved = await tool('update_comparison_findings_delta').execute({}, signal);
      assert.match(saved.content, /^status=accepted\n/);
    } else if (allowedToolNames?.includes('preview_report')) {
      assert.equal(updates, 1); assert.equal(audits, 1); assert.equal(formal, true);
      await tool('preview_report').execute({}, signal);
    } else {
      assert.ok(allowedToolNames?.includes('inspect_comparison_draft'));
      if (mode === 'inspection-timeout') {
        assert.ok(yieldDeadline);
        t.mock.timers.tick(yieldDeadline.at - Date.now());
        return { status: 'yielded', reason: yieldDeadline.reason };
      }
      t.mock.timers.tick(5_000);
      const inspection = await tool('inspect_comparison_draft').execute({}, signal);
      await tool('inspect_comparison_draft').onCompleted?.(inspection);
    }
    return 'Actual fixture turn ended; this is not a product quality verdict.';
  }, cancel() {} }) });
  const tools = [
    ...['update_comparison_findings', 'update_comparison_findings_delta'].map(name => ({ name,
      execute: async () => { updates++; formal = false; return { content: 'status=accepted\nCurrent saved findings; unresolved quality remains unavailable.' }; } })),
    { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual current full draft fixture, with decisive unknown visible.' }),
      onCompleted: async () => { material = true; formal = true; } },
    { name: 'preview_report', execute: async () => { previews++; return { content: 'Current matching preview fixture.' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const result = await new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: 0,
    resources: { maxElapsedMs: 600_000, maxModelRequests: 40, maxToolCalls: 120 } }).compare({ ...context, attemptId: mode }, tools,
    { append: async event => { events.push(event); } }, new AbortController().signal, {
      enforcePhaseBoundaries: true, reviewFindings: true, hasAcceptedDraft: () => true,
      findingsReady: () => true, getFindingsState: () => 'Current hypotheses; task quality is unavailable.',
      hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
      onDraftAuditStarted: () => { audits++; formal = false; },
      getSubmittedResult: async () => formal && previews > 0
        ? { status: 'completed', reportPath: 'report.html', headline: 'Conditional fixture', evidenceRefs: [] } : undefined,
    });
  assert.equal(result.status, fails ? 'failed' : 'completed', JSON.stringify(result));
  assert.equal(updates, fails ? 0 : 1);
  assert.equal(audits, fails ? 0 : 1);
  assert.equal(previews, fails ? 0 : 1);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.filter(event => event.payload.pass === 'review-findings').length, mode === 'checkpoint' || mode === 'inspection-timeout' ? 0 : 1);
  assert.equal(phases.filter(event => event.payload.pass === 'review-supplement').length, 0);
  if (result.status === 'failed') assert.equal(result.failure.kind, mode === 'save-timeout-no-update' ? 'protocol' : 'timeout');
  if (mode === 'inspection-timeout') assert.equal(phases.filter(event => event.payload.pass === 'inspection').length, 1);
  if (saveTimeout) {
    const save = phases.find(event => event.payload.pass === 'source-save')!;
    assert.equal(save.payload.yieldReason, 'bounded_source_timeout');
    assert.equal(save.payload.modelRequests, 1);
    assert.equal(save.payload.toolCalls, 0);
    const inspection = phases.find(event => event.payload.pass === 'inspection')!;
    assert.equal(inspection.payload.modelRequests, 1, 'save timeout must not turn draft delivery into a zero-request step');
    assert.equal(inspection.payload.toolCalls, 1);
  }
});
