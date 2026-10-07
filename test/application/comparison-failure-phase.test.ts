import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyComparisonFailure, comparisonFailureDiagnostic, comparisonRecordedFailurePhase } from '../../src/application/comparison-publication.js';
import { renderComparisonReportShell, metricsFromReportFacts } from '../../src/application/comparison-report-shell.js';
import type { ComparisonReportFacts } from '../../src/agents/comparison-agent.js';
import type { EventEnvelope } from '../../src/core/schema.js';

function facts(): ComparisonReportFacts {
  return { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } };
}

test('failure diagnostics use the current attempt phase despite an existing Host shell, preserving publication and legacy classification', () => {
  const phaseEvent = (runId: string, attemptId: string, phase: string, sequence: number): EventEnvelope => ({
    schemaVersion: 1, sequence, eventId: `event-${sequence}`, occurredAt: '2026-10-06T00:00:00.000Z',
    type: 'comparison.phase_completed', runId, payload: { attemptId, phase, outcome: 'failed' }, checksum: 'a'.repeat(64),
  });
  const result = { status: 'failed' as const, failure: { code: 'provider_failure' as const, kind: 'transient_upstream' as const, message: 'Stream ended without finish_reason', attempts: 1 } };
  const events = [phaseEvent('run', 'current', 'compose', 1), phaseEvent('run', 'other', 'review', 2), phaseEvent('other-run', 'current', 'review', 3)];
  const recordedPhase = comparisonRecordedFailurePhase(events, 'run', 'current');
  assert.equal(recordedPhase, 'compose');
  const diagnostic = comparisonFailureDiagnostic({ result, reportPresent: true, recordedPhase, facts: facts(), attemptId: 'current' });
  assert.equal(diagnostic.phase, 'compose'); assert.ok(diagnostic.details.includes('phase=compose'));
  assert.match(renderComparisonReportShell({ title: 'Failure', task: 'Task', facts: facts(), metrics: metricsFromReportFacts(facts()), diagnostic }), /data-failure-phase="compose"/);
  events.push(phaseEvent('run', 'current', 'review', 4));
  assert.equal(classifyComparisonFailure({ result, reportPresent: true, recordedPhase: comparisonRecordedFailurePhase(events, 'run', 'current') }).phase, 'review');
  assert.equal(classifyComparisonFailure({ result: { status: 'failed', failure: { code: 'publication_failed', message: 'Publish failed', attempts: 1 } }, reportPresent: true, recordedPhase: 'compose' }).phase, 'publication');
  assert.equal(comparisonRecordedFailurePhase(events, 'run', 'missing'), undefined);
  assert.equal(classifyComparisonFailure({ result, reportPresent: true }).phase, 'review');
  assert.equal(classifyComparisonFailure({ result, reportPresent: false }).phase, 'compose');
  assert.equal(classifyComparisonFailure({ result: { status: 'cancelled' }, reportPresent: true, recordedPhase: 'investigate' }).phase, 'investigate');
  assert.equal(classifyComparisonFailure({ result: { status: 'failed', failure: { code: 'agent_failure', message: 'Unknown failure', attempts: 1 } }, reportPresent: true, recordedPhase: 'compose' }).phase, 'compose');
  for (const code of ['invalid_envelope', 'draft_invalid', 'report_incomplete', 'evidence_unresolved', 'preview_failed'] as const) {
    assert.equal(classifyComparisonFailure({ result: { status: 'failed', failure: { code, message: 'Actual phase failure', attempts: 1 } }, reportPresent: true, recordedPhase: 'investigate' }).phase, 'investigate');
    assert.equal(classifyComparisonFailure({ result: { status: 'failed', failure: { code, message: 'Actual phase failure', attempts: 1 } }, reportPresent: true, recordedPhase: 'compose' }).phase, 'compose');
  }
});
