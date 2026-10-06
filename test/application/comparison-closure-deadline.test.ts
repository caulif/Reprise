import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import type { ComparisonDiscoveryRecord, ComparisonFindingsSubmission } from '../../src/core/schema.js';

const context: ComparisonContext = { task: { caseId: 'closure-deadline', summary: 'Compare actual recorded outputs.' }, attemptId: 'closure-deadline',
  baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'baseline', candidate: 'candidate' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'test' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } } };

for (const mode of ['persist-unknown', 'persist-fails', 'cancel-after-persist'] as const) test(`a findings pass reaching the investigation deadline closes existing unknowns before compose: ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-late-closure-')); t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const persisted: ComparisonDiscoveryRecord[] = [], events: AgentAuditEvent[] = [];
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: mode, links: [], media: [] });
  let failPersistence = false;
  const discovery = new ComparisonDiscovery({ catalog, attemptId: mode, persist: async record => {
    if (failPersistence) throw new Error('Actual late closure persistence failure');
    persisted.push(structuredClone(record));
  } });
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], findings: [], importantLimitations: ['Quality is unknown'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final is not verified' })),
    decisionQuestions: [
      { id: 'pending', question: 'Does the actual final meet the task?', decisionImpact: 'Could reverse preference', status: 'pending', evidenceRefs: [], nextCheck: 'Check the actual final' },
      { id: 'old-unknown', question: 'Are other inputs covered?', decisionImpact: 'Bounds generality', status: 'unavailable', evidenceRefs: [], resolution: 'Other inputs were not checked' },
    ] };
  assert.match((await discovery.tool().execute(initial, new AbortController().signal)).content, /^status=accepted\n/);
  const before = discovery.snapshot()!, abort = new AbortController();
  let calls = 0, closures = 0, compositions = 0;
  const host = new AgentHost({ createSession: () => ({ append: async ({ content, yieldDeadline, allowedToolNames }) => {
    calls++;
    if (calls === 1) {
      assert.equal(closures, 0); assert.equal(discovery.readyToCompose(), false);
      return { status: 'yielded', reason: 'investigationToolCalls' };
    }
    if (calls === 2) {
      assert.match(content, /Use this bounded closure turn only/);
      assert.deepEqual(allowedToolNames, ['update_comparison_findings']);
      assert.deepEqual(yieldDeadline, { at: 121_000, reason: 'bounded_investigation_timeout' });
      assert.equal(closures, 0, 'a tool-count yield must not synthesize a deadline closure');
      t.mock.timers.tick(120_000);
      return { status: 'yielded', reason: 'bounded_investigation_timeout' };
    }
    compositions++; assert.equal(calls, 3); assert.equal(mode, 'persist-unknown');
    assert.ok(content.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT));
    assert.equal(closures, 1); assert.equal(discovery.readyToCompose(), true);
    assert.match(content, /Host process boundary[\s\S]*not a semantic answer/);
    abort.abort();
    return 'Boundary proved; the fixture cancels before creating or publishing any report.';
  }, cancel() {} }) });
  const result = await new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: 0, resources: { maxElapsedMs: 600_000, investigationMs: 120_000 } }).compare(
    { ...context, attemptId: mode }, [discovery.tool()], { append: async event => { events.push(event); } }, abort.signal, {
      getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true, reviewFindings: true,
      hasSavedFindings: () => !!discovery.snapshot(), findingsReady: () => discovery.readyToCompose(), getFindingsState: () => discovery.state(),
      closeBoundedInvestigation: async (boundary, signal) => {
        closures++; assert.equal(boundary.reason, 'bounded_investigation_timeout');
        failPersistence = mode === 'persist-fails';
        const closed = await discovery.closeAtInvestigationDeadline(signal);
        assert.deepEqual(closed.questionIds, ['pending']);
        if (mode === 'cancel-after-persist') abort.abort();
      },
    });
  assert.equal(closures, 1); assert.equal(compositions, mode === 'persist-unknown' ? 1 : 0);
  assert.equal(calls, mode === 'persist-unknown' ? 3 : 2);
  assert.equal(result.status, mode === 'persist-fails' ? 'failed' : 'cancelled');
  const final = discovery.snapshot()!;
  if (mode === 'persist-fails') { assert.deepEqual(final, before); assert.equal(persisted.length, 1); }
  else {
    assert.equal(persisted.length, 2); assert.equal(final.submission.decisionQuestions[0]!.status, 'unavailable');
    assert.equal(final.submission.decisionQuestions[0]!.question, initial.decisionQuestions[0]!.question);
    assert.equal(final.submission.decisionQuestions[0]!.decisionImpact, initial.decisionQuestions[0]!.decisionImpact);
    assert.match(final.submission.decisionQuestions[0]!.resolution!, /not a semantic answer/);
    assert.deepEqual(final.submission.decisionQuestions[1], initial.decisionQuestions[1]);
    assert.deepEqual(final.submission.findings, initial.findings); assert.deepEqual(final.submission.finals, initial.finals);
  }
  const findingsPhase = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'findings');
  assert.equal(findingsPhase?.payload.yieldReason, 'bounded_investigation_timeout');
  assert.equal(events.some(event => event.type === 'comparison.phase_completed' && event.payload.phase === 'compose'), mode === 'persist-unknown');
});
