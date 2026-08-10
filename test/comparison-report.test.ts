import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComparisonResult, ComparisonAgentPort } from '../src/agents/comparison-agent.js';
import { comparePersistedFacts } from '../src/application/comparison.js';
import type { RunRecord, TaskCase } from '../src/core/schema.js';
import { buildComparisonProjection, renderComparisonReport } from '../src/report/comparison-report.js';

const timestamp = '2026-08-10T00:00:00.000Z';

function taskCase(): TaskCase {
  return {
    schemaVersion: 1,
    caseId: 'case-1',
    source: { productId: 'codex', sessionId: 'session-1' },
    initialInput: { id: 'message-1', role: 'user', text: 'Create <strong>report</strong> at C:\\secret\\input.txt.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Create report.' }],
    historicalEvents: [],
    baseline: { status: 'available', finalMessage: 'Baseline finished /private/baseline.txt.', artifactRefs: [{ artifactId: 'baseline-1', caseId: 'case-1' }], evidenceRefs: ['event:baseline-1'] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    environmentBaseline: { status: 'available', artifactRefs: [] },
    provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: 'b'.repeat(64),
  };
}

function runRecord(): RunRecord {
  return {
    attempt: {
      schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1',
      candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'test-model' },
      policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 2, turnTimeoutMs: 1000, heartbeatTimeoutMs: 1000, maxConsecutiveNoProgress: 1 },
      createdAt: timestamp,
    },
    state: 'finished',
    stageReached: 'awaiting_controller',
    outcome: {
      task: { status: 'apparently_completed', decidedBy: 'controller', evidenceRefs: ['event:task-1'] },
      termination: { kind: 'completed', code: 'completed.controller', initiatedBy: 'controller' },
      cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: ['event:cleanup-1'] },
    },
    fidelity: { environment: 'matched', externalWorld: 'controlled', modelResolution: 'verified', comparisonClass: 'strict', reasons: [] },
    trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 3, lastSequence: 8 },
    artifactRefs: [{ artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }],
    warnings: [{ code: 'notice', message: 'See /private/trace.log.', evidenceRefs: ['event:warning-1'] }],
  };
}

function comparison(): ComparisonResult {
  return {
    summary: '<img src=x onerror=alert(1)> /home/user/result',
    observations: [{ text: '</li><script>alert(1)</script>', evidence: ['artifact:output-1'], side: 'candidate' }],
    limitations: ['No browser verification.'],
    generatedAt: timestamp,
  };
}

test('report escapes untrusted content, redacts absolute paths, and emits only owned relative artifact links', () => {
  const html = renderComparisonReport(buildComparisonProjection({
    taskCase: taskCase(), runs: [runRecord()], comparison: comparison(),
    artifacts: [{ ref: { artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }, kind: 'image', mediaType: 'image/png', byteLength: 12 }],
  }));

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.doesNotMatch(html, /C:\\secret|\/home\/user|\/private\//);
  assert.match(html, /href="\.\/runs\/run-1\/artifacts\/output-1"/);
  assert.doesNotMatch(html, /href="(?:[A-Za-z]:|\/|\\\\)/);
  assert.match(html, /image\/png/);
});

test('report rejects comparison evidence outside the persisted case and run facts', () => {
  assert.throws(() => buildComparisonProjection({
    taskCase: taskCase(), runs: [runRecord()],
    comparison: { ...comparison(), observations: [{ text: 'Forged.', evidence: ['artifact:foreign-1'] }] },
  }), /unknown evidence reference/);
});

test('report falls back to objective persisted facts when no comparison result exists', () => {
  const projection = buildComparisonProjection({ taskCase: taskCase(), runs: [runRecord()] });
  const html = renderComparisonReport(projection);

  assert.equal(projection.comparison, undefined);
  assert.match(html, /No validated comparison result is available/);
  assert.match(html, /apparently_completed/);
  assert.match(html, /completed\.controller/);
  assert.match(html, /Trace telemetry/);
});

test('the same fixture projection renders deterministically', () => {
  const input = { taskCase: taskCase(), runs: [runRecord()], comparison: comparison() };
  assert.equal(renderComparisonReport(buildComparisonProjection(input)), renderComparisonReport(buildComparisonProjection(input)));
});

test('comparison orchestration validates citations after the agent returns', async () => {
  const agent: ComparisonAgentPort = {
    compare: async () => ({
      value: { ...comparison(), observations: [{ text: 'Forged.', evidence: ['event:foreign-1'] }] },
      usedFallback: false,
    }),
  };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent }), /unknown evidence reference/);
});
