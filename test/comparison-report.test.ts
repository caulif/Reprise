import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComparisonAgentPort, ComparisonResult } from '../src/agents/comparison-agent.js';
import { comparePersistedFacts } from '../src/application/comparison.js';
import type { RunRecord, TaskCase } from '../src/core/schema.js';
import { buildComparisonProjection, renderComparisonReport } from '../src/report/comparison-report.js';

const timestamp = '2026-08-10T00:00:00.000Z';
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: 'Create <strong>report</strong> at C:\\secret\\input.txt.' }, transcript: [{ id: 'message-1', role: 'user', text: 'Create report.' }], historicalEvents: [], baseline: { status: 'available', finalMessage: 'Baseline finished /private/baseline.txt.', artifactRefs: [{ artifactId: 'baseline-1', caseId: 'case-1' }], evidenceRefs: ['event:baseline-1'] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, taskContext: { historicalCommit: 'a'.repeat(40), historicalEnvironment: { cwd: { git: { head: 'b'.repeat(40), dirty: true } } }, historicalBehavior: { commands: ['npm test'], touchedPaths: ['src/historical.ts'] } }, provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function runRecord(): RunRecord { return { attempt: { schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'test-model' }, policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 2, turnTimeoutMs: 1000000, maxConsecutiveNoProgress: 1 }, createdAt: timestamp }, state: 'finished', stageReached: 'awaiting_controller', outcome: { task: { status: 'apparently_completed', decidedBy: 'controller', evidenceRefs: ['event:task-1'] }, termination: { kind: 'completed', code: 'completed.controller_satisfied', initiatedBy: 'controller' }, cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: ['event:cleanup-1'] } }, trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 3, lastSequence: 8 }, artifactRefs: [{ artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }], warnings: [{ code: 'notice', message: 'See /private/trace.log.', evidenceRefs: ['event:warning-1'] }] }; }
function comparison(): ComparisonResult { return { status: 'completed', reportPath: 'comparison.md', evidenceRefs: ['artifact:output-1'], limitationCodes: ['No browser verification.'] }; }

test('report wraps the agent narrative in a deterministic shell of identity, metrics and file entries', () => {
  const html = renderComparisonReport(buildComparisonProjection({ taskCase: taskCase(), runs: [runRecord()], comparison: comparison(), comparisonNarrative: '# Summary\nAgent-authored body <script>alert(1)</script>.', inspections: [{ runId: 'run-1', finalMessage: 'Candidate finished.', changedPaths: ['src/report.ts'], runtimeGeneratedPaths: [], commands: ['npm test'], rejectedApprovals: 1, turns: 2, wallClockMs: 42, tokenCount: 128 }], artifacts: [{ ref: { artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }, kind: 'image', mediaType: 'image/png', byteLength: 12 }] }));
  assert.match(html, /Reprise comparison · case-1/);
  assert.match(html, /test-model · run-1 · started 2026-08-10T00:00:00\.000Z/);
  assert.match(html, /Turns: 2 · Wall-clock: 42 ms · Changed files: 1 · Tokens: 128/);
  assert.match(html, /Single run; results are affected by randomness\. This report is not a ranking\./);
  assert.match(html, /Agent-authored body/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="comparison\.md"/);
  assert.match(html, /href="\.\/runs\/run-1\/artifacts\/output-1"/);
  assert.doesNotMatch(html, /Historical|Candidate facts|facts-grid/);
});

test('report keeps local paths readable and never leaks them into markup', () => {
  const html = renderComparisonReport(buildComparisonProjection({ taskCase: taskCase(), runs: [runRecord()], comparison: comparison(), comparisonNarrative: 'Wrote C:\\secret\\input.txt and /private/candidate.txt.' }));
  assert.match(html, /C:\\secret\\input\.txt/);
  assert.match(html, /\/private\/candidate\.txt/);
  assert.doesNotMatch(html, /path redacted/);
});

test('report falls back to a complete shell without an Agent narrative and re-renders deterministically', () => {
  const input = { taskCase: taskCase(), runs: [runRecord()] };
  const html = renderComparisonReport(buildComparisonProjection(input));
  assert.match(html, /No validated comparison narrative is available/);
  assert.match(html, /Changed files: 0|Trace events 3-8/);
  assert.match(html, /output-1/);
  assert.equal(html, renderComparisonReport(buildComparisonProjection(input)));
});

test('comparison orchestration rejects envelope citations outside persisted facts', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { ...comparison(), evidenceRefs: ['event:foreign-1'] } }) };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent }), /unknown evidence reference/);
});
