import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertComparisonResult, COMPARISON_SYSTEM_PROMPT } from '../src/agents/comparison-agent.js';
import { buildComparisonContext, comparePersistedFacts, type RunInspection } from '../src/application/comparison.js';
import { fingerprintTree } from '../src/environment/local-workspace-fs.js';
import { recoveryTools } from '../src/infrastructure/recovery-tools.js';
import type { ComparisonAgentPort } from '../src/agents/comparison-agent.js';
import type { RunRecord, TaskCase } from '../src/core/schema.js';

const timestamp = '2026-08-15T00:00:00.000Z';
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: '修复报告。' }, transcript: [{ id: 'message-1', role: 'user', text: '修复报告。' }], historicalEvents: [], baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: ['event:baseline-1'] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function runRecord(): RunRecord { return { attempt: { schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-5.6' }, policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 }, createdAt: timestamp }, state: 'finished', stageReached: 'awaiting_controller', outcome: { task: { status: 'incomplete', evidenceRefs: [] }, termination: { kind: 'limit_reached', code: 'limit.turns', initiatedBy: 'harness' }, cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: [] } }, trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 1, lastSequence: 2 }, artifactRefs: [], warnings: [] }; }

test('comparison write tool writes report.html and refuses candidate paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-report-'));
  const candidate = join(root, 'isolation');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, 'kept.txt'), 'keep');
  const html = '<!doctype html><style>body{color:red}</style><svg><path /></svg><script>window.ok=true</script>';
  const tools = recoveryTools(root, {
    mounts: { candidate },
    allowWrite: (path) => path === 'report.html',
    completionPaths: new Set(['report.html']),
    denyDestructiveOnPrefix: ['candidate'],
  });
  const write = tools.find((tool) => tool.name === 'write');
  assert.ok(write);
  const before = await fingerprintTree(candidate);
  await write.execute({ path: 'report.html', content: html }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), html);
  await assert.rejects(write.execute({ path: 'candidate/kept.txt', content: 'nope' }, new AbortController().signal), /write_denied/);
  const shellTool = tools.find((tool) => tool.name === 'shell_exec');
  assert.ok(shellTool);
  await assert.rejects(
    shellTool.execute({ command: 'Remove-Item candidate/kept.txt' }, new AbortController().signal),
    /write_denied/,
  );
  const after = await fingerprintTree(candidate);
  assert.equal(after.fingerprint.digest, before.fingerprint.digest);
  assert.equal(await readFile(join(candidate, 'kept.txt'), 'utf8'), 'keep');
});

test('comparison envelope accepts only report.html', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, context));
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: 'Same files, fewer turns.' }, context));
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: '../report.html', evidenceRefs: [] }, context), /schema validation failed/);
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: 'x'.repeat(281) }, context), /schema validation failed/);
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

test('comparison envelope accepts Host-owned observation refs and rejects only-unknown refs', () => {
  const owned = 'event:transcript-0-aaaaaaaaaaaaaaaa';
  const context = {
    ...buildComparisonContext(taskCase(), [runRecord()]),
    ownedEvidenceRefs: [owned],
  };
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [owned] }, context));
  assert.throws(
    () => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['event:foreign-1'] }, context),
    /unknown evidence reference/,
  );
});

test('comparison orchestration rejects envelope citations outside persisted facts', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: ['event:foreign-1'] } }) };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent }), /unknown evidence reference/);
});

test('comparison prompt points workspace tools at the live replica mount', () => {
  assert.match(COMPARISON_SYSTEM_PROMPT, /candidate\/ is the live isolated replica/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /comparison-sandbox\/candidate/);
});



