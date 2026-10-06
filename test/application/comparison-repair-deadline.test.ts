import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { sha256 } from '../../src/core/identity.js';

const context: ComparisonContext = {
  task: { caseId: 'repair-deadline', summary: 'Exercise the registered repair-read boundary.' }, attemptId: 'repair-deadline',
  baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'baseline', candidate: 'candidate' },
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'test' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } },
};

for (const mode of ['already-expired', 'predicate-crosses-deadline'] as const) test(`strict audit repair read cannot cross its absolute deadline: ${mode}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const abort = new AbortController(), events: AgentAuditEvent[] = [];
  let auditActive = false, reads = 0, predicates = 0, checked = false, requests = 0;
  const host = new AgentHost({ createSession: input => ({
    append: async ({ content, signal, yieldDeadline }) => {
      await input.onModelRequest?.({ model: 'fixture', digest: sha256(content), messageCount: ++requests, images: [] });
      if (content.includes('independent review findings closure')) {
        await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal);
      } else if (auditActive) {
        assert.equal(requests, 5, 'exercise the actual strict audit after investigator, author, sources and accepted findings');
        assert.equal(yieldDeadline?.reason, 'bounded_audit_timeout');
        assert.equal(yieldDeadline.at - Date.now(), 90_000);
        if (mode === 'already-expired') t.mock.timers.tick(90_000);
        const result = await input.tools.find(tool => tool.name === 'read')!.execute({ path: 'work/registered-repair.txt' }, signal);
        assert.match(result.content, /bounded_audit_timeout/);
        assert.equal(reads, 0, 'a registered repair policy is not permission to read after the stage deadline');
        assert.equal(predicates, mode === 'already-expired' ? 0 : 1);
        checked = true;
        abort.abort();
      }
      return 'Actual fixture turn ended.';
    }, cancel() {},
  }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: 0,
    resources: { maxElapsedMs: 600_000, maxModelRequests: 9 } });
  const result = await agent.compare({ ...context, attemptId: `repair-${mode}` }, [
    { name: 'read', description: 'read', parameters: Type.Object({ path: Type.String() }),
      execute: async () => { reads++; return { content: 'This underlying read must never execute.' }; } },
    { name: 'update_comparison_findings', description: 'findings', parameters: Type.Object({}),
      execute: async () => ({ content: 'status=accepted\n{"readyToCompose":true}' }) },
    { name: 'inspect_comparison_draft', description: 'inspection', parameters: Type.Object({}),
      execute: async () => { assert.fail('This boundary-only fixture must not perform a publication inspection.'); } },
  ], { append: async event => { events.push(event); } }, abort.signal, {
    enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => true,
    hasAcceptedDraft: () => true, hasReviewDraftMaterial: () => true, hasCurrentReviewInspection: () => false,
    getSubmittedResult: async () => undefined, getFindingsState: () => 'No pending test questions.',
    onDraftAuditStarted: () => { auditActive = true; },
    isRepairRead: async params => {
      predicates++;
      assert.deepEqual(params, { path: 'work/registered-repair.txt' });
      t.mock.timers.tick(90_000);
      await Promise.resolve();
      return true;
    },
  });
  assert.equal(checked, true);
  assert.equal(reads, 0);
  assert.equal(result.status, 'cancelled', 'the fixture stops after proving the rejected side effect; it does not certify publication');
  assert.equal(events.some(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'audit'), true);
});
