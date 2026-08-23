import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertComparisonResult } from '../src/agents/comparison-agent.js';
import { buildComparisonContext, comparePersistedFacts, type RunInspection } from '../src/application/comparison.js';
import { comparisonReportTool } from '../src/infrastructure/agent-tools.js';
import type { ComparisonAgentPort } from '../src/agents/comparison-agent.js';
import type { RunRecord, TaskCase } from '../src/core/schema.js';

const timestamp = '2026-08-15T00:00:00.000Z';
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: '修复报告。' }, transcript: [{ id: 'message-1', role: 'user', text: '修复报告。' }], historicalEvents: [], baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: ['event:baseline-1'] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function runRecord(): RunRecord { return { attempt: { schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-5.6' }, policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 }, createdAt: timestamp }, state: 'finished', stageReached: 'awaiting_controller', outcome: { task: { status: 'incomplete', evidenceRefs: [] }, termination: { kind: 'limit_reached', code: 'limit.turns', initiatedBy: 'harness' }, cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: [] } }, trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 1, lastSequence: 2 }, artifactRefs: [], warnings: [] }; }

test('comparison report tool writes complete HTML bytes verbatim to report.html', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const html = '<!doctype html><style>body{color:red}</style><svg><path /></svg><script>window.ok=true</script>';
  const result = await comparisonReportTool(root).execute({ html }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), html);
  const details = result.details as { path: string; bytes: number; sha256: string };
  assert.equal(details.path, 'report.html');
  assert.equal(details.bytes, Buffer.byteLength(html));
  assert.match(details.sha256, /^[a-f0-9]{64}$/);
});

test('comparison envelope accepts only report.html', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, context));
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: '../report.html', evidenceRefs: [] }, context), /schema validation failed/);
});

test('reportFacts preserve missing measurements and project known run facts', () => {
  const inspection: RunInspection = { runId: 'run-1', changedPaths: ['src/a.ts'], runtimeGeneratedPaths: [], commands: ['npm test'], rejectedApprovals: 1, turns: 2, replayConditions: ['sourceRootKind=stand_in'] };
  const facts = buildComparisonContext(taskCase(), [runRecord()], [inspection]).reportFacts;
  assert.equal(facts.run.terminationCode, 'limit.turns');
  assert.equal(facts.run.candidateElapsedMs, undefined);
  assert.equal(facts.activity.candidateTurns, 2);
  assert.equal(facts.limits.triggered[0], 'limit.turns');
  assert.deepEqual(facts.delivery.changedPaths, ['src/a.ts']);
  assert.equal(facts.replay.baselineEvidence, 'verifiable');
});

test('comparison orchestration rejects envelope citations outside persisted facts', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: ['event:foreign-1'] } }) };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent }), /unknown evidence reference/);
});
