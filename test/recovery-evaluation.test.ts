import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  evaluateRecoveryCases,
  persistRecoveryEvaluation,
  assertRecoveryEvaluationLifecycleIntegrity,
  createRecoveryEvaluationFileSink,
  runRecoveryEvaluationBatch,
  RecoveryEvaluationError,
  assertRecoveryEvaluationIntegrity,
  type RecoveryEvaluationCaseSink,
} from '../src/application/recovery-evaluation.js';
import { recoveryEvaluationFailureCode } from '../src/application/recovery-failure-classification.js';
import { RecoveryEvaluationCaseSchema, RecoveryExternalEffectSchema, RecoveryCompensationRequestSchema, RecoveryCompensationResultSchema } from '../src/core/schema.js';


test('real runner failure stages map to mutually exclusive safe evaluation codes', () => {
  const cases = new Map([
    ['preflight_failed', 'preflight_failed'],
    ['source_snapshot_budget_exceeded', 'preflight_failed'],
    ['model_request_failed', 'model_request_failed'],
    ['agent_model_failed', 'model_request_failed'],
    ['agent_timeout', 'model_request_failed'],
    ['agent_invalid_output', 'agent_protocol_failed'],
    ['agent_tool_failed', 'tool_failed'],
    ['provider_validation_failed', 'verifier_rejected'],
    ['source_tripwire_failed', 'source_tripwire_failed'],
    ['source_unavailable', 'source_unavailable'],
    ['selection_source_changed', 'source_unavailable'],
    ['cancelled', 'cancelled'],
    ['unexpected-stage', 'runner_crashed'],
  ]);
  for (const [stage, expected] of cases) assert.equal(recoveryEvaluationFailureCode(stage), expected, stage);
});

test('Recovery evaluation keeps historical candidate coverage separate from checkpoint truth metrics', () => {
  const metrics = evaluateRecoveryCases([
    { schemaVersion: 1, caseId: 'history-1', layer: 'history_completed', forensicsStarted: true, candidateCreated: true, candidateAcceptedByUser: true, candidateReplayPassed: true, verification: 'pending_user_review', taskOutcome: 'unrecoverable', recoveredPaths: ['src/a.ts'], modelCalls: 2, durationMs: 100 },
    { schemaVersion: 1, caseId: 'history-2', layer: 'history_completed', forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence', recoveredPaths: [], modelCalls: 1, durationMs: 300 },
    { schemaVersion: 1, caseId: 'checkpoint-1', layer: 'interrupted_checkpoint', forensicsStarted: true, candidateCreated: true, candidateReplayPassed: true, verification: 'verified', recoveredPaths: ['src/a.ts'], checkpointPaths: ['src/a.ts', 'src/b.ts'], modelCalls: 0, durationMs: 50 },
    { schemaVersion: 1, caseId: 'checkpoint-2', layer: 'interrupted_checkpoint', forensicsStarted: false, candidateCreated: true, candidateReplayPassed: false, verification: 'verified', recoveredPaths: ['src/c.ts'], checkpointPaths: ['src/c.ts'], modelCalls: 0, durationMs: 150 },
    { schemaVersion: 1, caseId: 'checkpoint-3', layer: 'interrupted_checkpoint', forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence', recoveredPaths: [], checkpointPaths: ['src/d.ts'], modelCalls: 0, durationMs: 200 },
  ]);
  assert.deepEqual(metrics.historyCompleted.investigationCoverage, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(metrics.historyCompleted.verifiedPathPrecision, { numerator: 0, denominator: 0 });
  assert.deepEqual(metrics.interruptedCheckpoint.verifiedPathPrecision, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(metrics.interruptedCheckpoint.verifiedPathRecall, { numerator: 2, denominator: 4, value: 0.5 });
  assert.equal(metrics.interruptedCheckpoint.p95DurationMs, 200);
  assert.deepEqual(metrics.historyCompleted.taskOutcomeCounts, { unrecoverable: 1, unclassified: 1 });
  assert.equal(metrics.interruptedCheckpoint.truthRecoveryRate.numerator, 1);
  assert.ok((metrics.interruptedCheckpoint.truthRecoveryRateWilson95?.lower ?? 1) < 0.5);
  assert.ok((metrics.interruptedCheckpoint.truthRecoveryRateWilson95?.upper ?? 0) > 0.5);
});

test('Recovery timing metrics keep unobserved components distinct from real zero', () => {
  const metrics = evaluateRecoveryCases([
    { schemaVersion: 1, caseId: 'timed-1', layer: 'history_completed', forensicsStarted: true, candidateCreated: true, verification: 'pending_user_review', recoveredPaths: [], modelCalls: 1, durationMs: 100, timings: { forensicsMs: 20, modelRequestMs: 50, candidateMaterializationMs: 0 } },
    { schemaVersion: 1, caseId: 'timed-2', layer: 'history_completed', forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence', recoveredPaths: [], modelCalls: 0, durationMs: 0 },
  ]).historyCompleted;
  assert.equal(metrics.averageForensicsMs, 20);
  assert.equal(metrics.averageModelRequestMs, 50);
  assert.equal(metrics.averageCandidateMaterializationMs, 0);
  assert.equal(metrics.averageToolMs, undefined);
});

test('Recovery evaluation reports weak-evidence effort metrics without inventing truth', () => {
  const metrics = evaluateRecoveryCases([
    { schemaVersion: 1, caseId: 'effort-1', layer: 'history_completed', stagingSucceeded: true, forensicsStarted: true, forensicsCompleted: true, evidenceSourcesAttempted: 4, evidenceSourcesAvailable: 3, hypothesisCount: 2, candidateCount: 3, verifierRejectionReasons: ['path_mismatch'], providerFailureRetryable: false, pathBoundaryRejected: false, candidateCreated: true, verification: 'pending_user_review', recoveredPaths: [], modelCalls: 2, durationMs: 100 },
    { schemaVersion: 1, caseId: 'effort-2', layer: 'history_completed', stagingSucceeded: false, forensicsStarted: true, forensicsCompleted: false, evidenceSourcesAttempted: 2, evidenceSourcesAvailable: 0, hypothesisCount: 1, candidateCount: 0, verifierRejectionReasons: ['path_mismatch', 'test_failed'], providerFailureRetryable: true, pathBoundaryRejected: true, candidateCreated: false, verification: 'insufficient_evidence', recoveredPaths: [], modelCalls: 1, durationMs: 300 },
  ]);
  assert.deepEqual(metrics.historyCompleted.stagingSuccessRate, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(metrics.historyCompleted.evidenceSourceCoverage, { numerator: 3, denominator: 6, value: 0.5 });
  assert.equal(metrics.historyCompleted.forensicsCompletionCoverage.value, 0.5);
  assert.equal(metrics.historyCompleted.pendingUserReviewCount, 1);
  assert.equal(metrics.historyCompleted.verifiedCount, 0);
  assert.deepEqual(metrics.historyCompleted.verifierRejectionReasons, { path_mismatch: 2, test_failed: 1 });
  assert.equal(metrics.historyCompleted.retryableProviderFailureRate.value, 0.5);
  assert.equal(metrics.historyCompleted.pathBoundaryRejectionRate.value, 0.5);
});

test('Recovery evaluation rejects malformed fixture rows instead of manufacturing a metric', () => {
  assert.throws(() => evaluateRecoveryCases([
    { schemaVersion: 1, caseId: 'bad', layer: 'interrupted_checkpoint', forensicsStarted: true },
  ]), /RecoveryEvaluationCaseSchema/);
});


test('Recovery evaluation persists validated rows and aggregated metrics as an artifact', async () => {
  let artifact: { kind: string; bytes: Uint8Array } | undefined;
  await persistRecoveryEvaluation({
    async commitArtifact(input) { artifact = { kind: input.kind, bytes: input.bytes }; },
  }, [{ schemaVersion: 1, caseId: 'checkpoint-artifact', layer: 'interrupted_checkpoint', forensicsStarted: true, candidateCreated: true, verification: 'verified', recoveredPaths: ['src/a.ts'], checkpointPaths: ['src/a.ts'], modelCalls: 0, durationMs: 10 }]);
  assert.equal(artifact?.kind, 'recovery_evaluation');
  const report = JSON.parse(new TextDecoder().decode(artifact?.bytes)) as { rows: unknown[]; metrics: { interruptedCheckpoint: { fixtureCount: number } } };
  assert.equal(report.rows.length, 1);
  assert.equal(report.metrics.interruptedCheckpoint.fixtureCount, 1);
});


test('Recovery evaluation batch writes a terminal and source audit for every case failure stage', async () => {
  for (const failureStage of ['forensics', 'tool', 'verifier']) {
    const started: string[] = [];
    const terminal: unknown[] = [];
    const audits: string[] = [];
    const sink: RecoveryEvaluationCaseSink = {
      async writeStarted(record) { started.push(record.caseId); },
      async writeTerminal(record) { terminal.push(record); },
      async writeSourceAudit(record) { audits.push(record.caseId); },
    };
    const cases = Array.from({ length: 10 }, (_, index) => ({
      caseId: `${failureStage}-${index}`,
      async run() {
        if (index === 1) throw new Error(`${failureStage} fixture failure with C:\\private\\path`);
        return { schemaVersion: 2 as const, caseId: `${failureStage}-${index}`, layer: 'history_completed' as const, forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 1, durationMs: index };
      },
      async auditSource() { return 'passed' as const; },
    }));
    const rows = await runRecoveryEvaluationBatch(cases, sink, () => '2026-08-18T00:00:00.000Z');
    assert.equal(rows.length, 10, `${failureStage} must preserve all terminals`);
    assert.deepEqual(started, cases.map((item) => item.caseId));
    assert.deepEqual(audits, cases.map((item) => item.caseId));
    assert.equal(terminal.length, 10);
    assert.equal(rows[1]?.terminal.failureCode, 'runner_crashed');
    assert.equal(rows[1]?.terminal.status, 'failed');
    assert.equal(rows[2]?.terminal.status, 'completed');
    assert.equal(JSON.stringify(rows).includes('private'), false);
  }
});

test('Recovery evaluation batch records a failed or unavailable source audit without dropping later cases', async () => {
  for (const failedAudit of [true, false]) {
    const terminal: unknown[] = [];
    const sink: RecoveryEvaluationCaseSink = {
      async writeStarted() {},
      async writeTerminal(record) { terminal.push(record); },
      async writeSourceAudit() {},
    };
    const cases = Array.from({ length: 3 }, (_, index) => ({
      caseId: `audit-${failedAudit}-${index}`,
      async run() {
        return { schemaVersion: 2 as const, caseId: `audit-${failedAudit}-${index}`, layer: 'history_completed' as const, forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 };
      },
      async auditSource() {
        if (index !== 1) return 'passed' as const;
        if (failedAudit) return 'failed' as const;
        throw new Error('audit unavailable');
      },
    }));
    const rows = await runRecoveryEvaluationBatch(cases, sink);
    assert.equal(rows.length, 3);
    assert.equal(rows[1]?.sourceAudit, failedAudit ? 'failed' : 'unavailable');
    assert.equal(rows[1]?.terminal.failureCode, 'source_tripwire_failed');
    assert.equal(rows[1]?.terminal.status, 'failed');
    assert.equal((terminal[2] as { terminal: { status: string } }).terminal.status, 'completed');
  }
});



test('Recovery evaluation records wall-clock duration for a case that fails before producing a draft', async () => {
  const [row] = await runRecoveryEvaluationBatch([{
    caseId: 'failed-duration',
    async run() {
      await delay(10);
      throw new Error('runner failed before draft');
    },
    async auditSource() { return 'unavailable' as const; },
  }], {
    async writeStarted() {},
    async writeTerminal() {},
    async writeSourceAudit() {},
  });
  assert.equal(row?.terminal.status, 'failed');
  assert.ok((row?.durationMs ?? 0) >= 10);
});


test('Recovery evaluation stops before aggregate publication when terminal persistence fails', async () => {
  const completed: string[] = [];
  await assert.rejects(
    runRecoveryEvaluationBatch([
      {
        caseId: 'terminal-persistence-failure',
        async run() { return { schemaVersion: 2 as const, caseId: 'terminal-persistence-failure', layer: 'history_completed' as const, forensicsStarted: false, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 }; },
        async auditSource() { return 'passed' as const; },
      },
      {
        caseId: 'must-not-run-after-persistence-failure',
        async run() { completed.push('ran'); return { schemaVersion: 2 as const, caseId: 'must-not-run-after-persistence-failure', layer: 'history_completed' as const, forensicsStarted: false, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 }; },
        async auditSource() { return 'passed' as const; },
      },
    ], {
      async writeStarted() {},
      async writeTerminal() { throw new Error('disk full'); },
      async writeSourceAudit() {},
    }),
    /disk full/,
  );
  assert.deepEqual(completed, []);
});

test('Recovery evaluation distinguishes adapter protocol errors from runner crashes', async () => {
  const [row] = await runRecoveryEvaluationBatch([{
    caseId: 'invalid-draft',
    async run() { return { schemaVersion: 2 as const, caseId: 'different-case', layer: 'history_completed' as const, forensicsStarted: false, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 }; },
    async auditSource() { return 'passed' as const; },
  }], { async writeStarted() {}, async writeTerminal() {}, async writeSourceAudit() {} });
  assert.equal(row?.terminal.failureCode, 'evaluation_protocol_error');
  assert.equal(row?.terminal.operation, 'case.protocol');
});

test('Recovery evaluation file sink persists independent started, terminal, and source-audit records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-evaluation-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = await runRecoveryEvaluationBatch([{
    caseId: 'persisted-case',
    async run() { return { schemaVersion: 2 as const, caseId: 'persisted-case', layer: 'history_completed' as const, forensicsStarted: true, candidateCreated: false, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 }; },
    async auditSource() { return 'passed' as const; },
  }], createRecoveryEvaluationFileSink(root));
  assert.equal(rows[0]?.terminal.status, 'completed');
  const caseRoot = join(root, 'cases', 'persisted-case');
  for (const file of ['case.started.json', 'case.terminal.json', 'source-audit.json']) {
    const record = JSON.parse(await readFile(join(caseRoot, file), 'utf8')) as { caseId: string };
    assert.equal(record.caseId, 'persisted-case');
  }
});


test('Recovery evaluation rejects contradictory v2 terminal rows before aggregate publication', () => {
  const inconsistent = {
    schemaVersion: 2 as const,
    caseId: 'inconsistent-row',
    layer: 'history_completed' as const,
    forensicsStarted: true,
    candidateCreated: true,
    candidateCount: 0,
    verification: 'insufficient_evidence' as const,
    recoveredPaths: [],
    modelCalls: 1,
    durationMs: 1,
    terminal: { status: 'completed' as const },
    sourceAudit: 'passed' as const,
  };
  assert.equal(Value.Check(RecoveryEvaluationCaseSchema, inconsistent), true);
  assert.throws(() => assertRecoveryEvaluationIntegrity([inconsistent]), /evaluation_integrity_failed.*candidateCreated/i);
  assert.throws(() => assertRecoveryEvaluationIntegrity([{ ...inconsistent, candidateCount: 1 }, { ...inconsistent, candidateCount: 1 }]), /duplicate caseId/i);
});

test('Recovery evaluation preserves progress from a classified terminal failure', async () => {
  const progress = { schemaVersion: 2 as const, caseId: 'progress-failure', layer: 'history_completed' as const, stagingSucceeded: true, forensicsStarted: true, forensicsCompleted: true, candidateCreated: true, candidateCount: 2, verification: 'insufficient_evidence' as const, recoveredPaths: [], modelCalls: 2, durationMs: 750 };
  const [row] = await runRecoveryEvaluationBatch([{
    caseId: 'progress-failure',
    async run() { throw new RecoveryEvaluationError('model_request_failed', 'recovery.execute', progress); },
    async auditSource() { return 'passed' as const; },
  }], { async writeStarted() {}, async writeTerminal() {}, async writeSourceAudit() {} });
  assert.deepEqual(row && { stagingSucceeded: row.stagingSucceeded, forensicsCompleted: row.forensicsCompleted, candidateCreated: row.candidateCreated, candidateCount: row.candidateCount, modelCalls: row.modelCalls, durationMs: row.durationMs, terminal: row.terminal }, {
    stagingSucceeded: true, forensicsCompleted: true, candidateCreated: true, candidateCount: 2, modelCalls: 2, durationMs: 750,
    terminal: { status: 'failed', failureCode: 'model_request_failed', operation: 'recovery.execute' },
  });
});

test('Recovery evaluation preserves explicit safe failure classifications', async () => {
  const codes = ['preflight_failed', 'model_request_failed', 'agent_protocol_failed', 'tool_failed', 'verifier_rejected', 'source_unavailable', 'cancelled'] as const;
  const terminal: Array<{ terminal?: { failureCode?: string; operation?: string } }> = [];
  const rows = await runRecoveryEvaluationBatch(codes.map((code, index) => ({
    caseId: `classified-${index}`,
    async run() { throw new RecoveryEvaluationError(code, `phase.${code}`); },
    async auditSource() { return 'passed' as const; },
  })), {
    async writeStarted() {},
    async writeTerminal(record) { terminal.push(record); },
    async writeSourceAudit() {},
  });
  assert.deepEqual(rows.map((row) => row.terminal.failureCode), [...codes]);
  assert.deepEqual(rows.map((row) => row.terminal.operation), codes.map((code) => `phase.${code}`));
  assert.equal(rows.at(-1)?.terminal.status, 'cancelled');
  assert.equal(JSON.stringify(terminal).includes('phase.'), true);
  assert.equal(JSON.stringify(terminal).includes('provider'), false);
});

test('Recovery evaluation reports hidden-truth metrics and Wilson intervals for a 100-case population', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    schemaVersion: 1 as const,
    caseId: `hidden-${String(index).padStart(3, '0')}`,
    layer: 'interrupted_checkpoint' as const,
    forensicsStarted: true,
    candidateCreated: true,
    candidateReplayPassed: true,
    verification: index < 87 ? 'verified' as const : 'pending_user_review' as const,
    recoveredPaths: index < 87 ? ['src/target.ts'] : [],
    checkpointPaths: ['src/target.ts'],
    modelCalls: index < 87 ? 0 : 2,
    durationMs: index + 1,
  }));
  const metrics = evaluateRecoveryCases(rows).interruptedCheckpoint;
  assert.equal(metrics.fixtureCount, 100);
  assert.equal(metrics.truthRecoveryRate.numerator, 87);
  assert.equal(metrics.truthRecoveryRate.denominator, 100);
  assert.ok((metrics.truthRecoveryRateWilson95?.lower ?? 1) < 0.87);
  assert.ok((metrics.truthRecoveryRateWilson95?.upper ?? 0) > 0.87);
});

test('external effect and compensation records require bounded, reviewable evidence', () => {
  const common = { schemaVersion: 1 as const, effectId: "effect-1", evidenceRefs: ["fact:workspace"], summary: "remote mutation", recordedAt: "2026-08-19T00:00:00.000Z" };
  assert.equal(Value.Check(RecoveryExternalEffectSchema, { ...common, kind: "remote_api", observability: "unobserved" }), true);
  assert.equal(Value.Check(RecoveryCompensationRequestSchema, { schemaVersion: 1, requestId: "request-1", effectId: "effect-1", action: "review manually", evidenceRefs: ["fact:workspace"], requestedAt: common.recordedAt }), true);
  assert.equal(Value.Check(RecoveryCompensationResultSchema, { schemaVersion: 1, requestId: "request-1", effectId: "effect-1", status: "requires_review", summary: "not observable", evidenceRefs: ["fact:workspace"], completedAt: common.recordedAt }), true);
});

test("evaluation lifecycle integrity rejects dropped model and candidate events", () => {
  const row = {
    schemaVersion: 2 as const,
    caseId: "case-lifecycle",
    layer: "history_completed" as const,
    forensicsStarted: true,
    forensicsCompleted: true,
    candidateCreated: true,
    candidateCount: 2,
    verification: "verified" as const,
    recoveredPaths: ["src/app.ts"],
    modelCalls: 1,
    durationMs: 10,
    terminal: { status: "completed" as const },
    sourceAudit: "passed" as const,
  };
  assert.doesNotThrow(() => assertRecoveryEvaluationLifecycleIntegrity([row], [
    { type: "recovery.candidate_created", payload: { caseId: "case-lifecycle" } },
    { type: "recovery.candidate_created", payload: { caseId: "case-lifecycle" } },
    { type: "recovery.model_input", payload: { caseId: "case-lifecycle" } },
    { type: "recovery.attempt", payload: { caseId: "case-lifecycle", durationMs: 10 } },
  ]));
  assert.throws(() => assertRecoveryEvaluationLifecycleIntegrity([{ ...row, modelCalls: 0 }], [
    { type: "recovery.candidate_created", payload: { caseId: "case-lifecycle" } },
    { type: "recovery.model_input", payload: { caseId: "case-lifecycle" } },
  ]), /evaluation_integrity_failed/);
});



test("evaluation lifecycle integrity is case-scoped for batch rows", () => {
  const row = (caseId: string, modelCalls: number) => ({ schemaVersion: 2 as const, caseId, layer: "history_completed" as const, forensicsStarted: false, candidateCreated: false, verification: "insufficient_evidence" as const, recoveredPaths: [], modelCalls, durationMs: 5, terminal: { status: "completed" as const }, sourceAudit: "passed" as const });
  const events = [
    { type: "recovery.model_input", payload: { caseId: "case-a" } },
    { type: "recovery.attempt", payload: { caseId: "case-a", durationMs: 5 } },
  ];
  assert.doesNotThrow(() => assertRecoveryEvaluationLifecycleIntegrity([row("case-a", 1), row("case-b", 0)], events));
  assert.throws(() => assertRecoveryEvaluationLifecycleIntegrity([row("case-a", 0), row("case-b", 1)], events), /case-b|modelCalls/);
  assert.throws(() => assertRecoveryEvaluationLifecycleIntegrity([row("case-a", 1), row("case-b", 0)], [{ type: "recovery.model_input", payload: { caseId: "case-b" } }]), /case-a|modelCalls/);
});


test("Recovery evaluation batch rejects a case-scoped lifecycle mismatch before publishing aggregate", async () => {
  const draft = (caseId: string) => ({ schemaVersion: 2 as const, caseId, layer: "history_completed" as const, forensicsStarted: false, candidateCreated: false, verification: "insufficient_evidence" as const, recoveredPaths: [], modelCalls: 0, durationMs: 0 });
  await assert.rejects(runRecoveryEvaluationBatch([
    { caseId: "case-a", run: async () => draft("case-a"), auditSource: async () => "passed" as const, lifecycleEvents: [{ type: "recovery.model_input", payload: { caseId: "case-b" } }] },
    { caseId: "case-b", run: async () => draft("case-b"), auditSource: async () => "passed" as const, lifecycleEvents: [] },
  ], { async writeStarted() {}, async writeTerminal() {}, async writeSourceAudit() {} }), /evaluation_integrity_failed/);
});
