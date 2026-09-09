import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  RecoveryEvaluationCaseSchema,
  RecoveryEvaluationCaseStartedSchema,
  RecoveryEvaluationSourceAuditSchema,
  RecoveryEvaluationTerminalCaseSchema,
  type RecoveryEvaluationCase,
  type RecoveryEvaluationTerminalCase,
} from '../../core/schema.js';
import { writeAtomic } from '../../core/identity.js';
import type { EnvironmentBaseline, RecoveryStaging } from '../../environment/local-workspace-provider.js';
import type { RecoveryReadinessResult } from './readiness.js';

export type RecoveryEvaluationMetrics = {
  fixtureCount: number;
  investigationCoverage: Ratio;
  candidateGenerationRate: Ratio;
  userAcceptanceRate: Ratio;
  candidateReplayPassRate: Ratio;
  verifiedPathPrecision: Ratio;
  verifiedPathRecall: Ratio;
  averageModelCalls: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  /** Component timings are aggregated only from rows that observed that component. */
  averageForensicsMs: number | undefined;
  averageModelRequestMs: number | undefined;
  averageCandidateMaterializationMs: number | undefined;
  averageToolMs: number | undefined;
  stagingSuccessRate: Ratio;
  forensicsCompletionCoverage: Ratio;
  evidenceSourceCoverage: Ratio;
  averageHypothesisCount: number;
  averageCandidateCount: number;
  verifierRejectionReasons: Record<string, number>;
  pendingUserReviewCount: number;
  verifiedCount: number;
  taskOutcomeCounts: Record<string, number>;
  retryableProviderFailureRate: Ratio;
  pathBoundaryRejectionRate: Ratio;
  /** 95% Wilson intervals are reported only for truth-bearing checkpoint metrics. */
  truthRecoveryRate: Ratio;
  truthRecoveryRateWilson95: ConfidenceInterval | undefined;
  verifiedPathPrecisionWilson95: ConfidenceInterval | undefined;
  verifiedPathRecallWilson95: ConfidenceInterval | undefined;
};

type ConfidenceInterval = { lower: number; upper: number };

type Ratio = { numerator: number; denominator: number; value?: number };

/**
 * Aggregates the two deliberately separate Recovery evaluation populations.
 * It validates every row because fixture files and persisted reports are external input.
 */
export function evaluateRecoveryCases(rows: readonly unknown[]): {
  historyCompleted: RecoveryEvaluationMetrics;
  interruptedCheckpoint: RecoveryEvaluationMetrics;
} {
  const cases = rows.map((row) => {
    if (!Value.Check(RecoveryEvaluationCaseSchema, row))
      throw new Error('Recovery evaluation row does not match RecoveryEvaluationCaseSchema.');
    return row;
  });
  return {
    historyCompleted: metrics(cases.filter((row) => row.layer === 'history_completed')),
    interruptedCheckpoint: metrics(cases.filter((row) => row.layer === 'interrupted_checkpoint')),
  };
}

function metrics(cases: readonly RecoveryEvaluationCase[]): RecoveryEvaluationMetrics {
  const candidates = cases.filter((row) => row.candidateCreated);
  const accepted = candidates.filter((row) => row.candidateAcceptedByUser === true);
  const replayed = candidates.filter((row) => row.candidateReplayPassed !== undefined);
  const replayPassed = replayed.filter((row) => row.candidateReplayPassed === true);
  const verified = cases.filter((row) => row.verification === 'verified');
  const checkpointCases = cases.filter(isCheckpointCase);
  const predicted = pathKeys(verified.filter(isCheckpointCase), (row) => row.recoveredPaths);
  const expected = pathKeys(checkpointCases, (row) => row.checkpointPaths);
  const truePositive = [...predicted].filter((path) => expected.has(path)).length;
  const exactRecoveryCount = checkpointCases.filter((row) =>
    row.verification === "verified" &&
    samePathSet(row.recoveredPaths, row.checkpointPaths),
  ).length;
  const truthRecoveryRate = ratio(exactRecoveryCount, checkpointCases.length);
  return {
    fixtureCount: cases.length,
    investigationCoverage: ratio(cases.filter((row) => row.forensicsStarted).length, cases.length),
    candidateGenerationRate: ratio(candidates.length, cases.length),
    userAcceptanceRate: ratio(accepted.length, candidates.filter((row) => row.candidateAcceptedByUser !== undefined).length),
    candidateReplayPassRate: ratio(replayPassed.length, replayed.length),
    verifiedPathPrecision: ratio(truePositive, predicted.size),
    verifiedPathRecall: ratio(truePositive, expected.size),
    averageModelCalls: average(cases.map((row) => row.modelCalls)),
    averageDurationMs: average(cases.map((row) => row.durationMs)),
    p50DurationMs: percentile(cases.map((row) => row.durationMs), 0.50),
    p95DurationMs: percentile(cases.map((row) => row.durationMs), 0.95),
    averageForensicsMs: averageObserved(cases.map((row) => row.timings?.forensicsMs)),
    averageModelRequestMs: averageObserved(cases.map((row) => row.timings?.modelRequestMs)),
    averageCandidateMaterializationMs: averageObserved(cases.map((row) => row.timings?.candidateMaterializationMs)),
    averageToolMs: averageObserved(cases.map((row) => row.timings?.toolMs)),
    stagingSuccessRate: booleanRate(cases, (row) => row.stagingSucceeded),
    forensicsCompletionCoverage: booleanRate(cases, (row) => row.forensicsCompleted),
    evidenceSourceCoverage: evidenceCoverage(cases),
    averageHypothesisCount: averageOptional(cases.map((row) => row.hypothesisCount)),
    averageCandidateCount: averageOptional(cases.map((row) => row.candidateCount)),
    verifierRejectionReasons: rejectionReasons(cases),
    pendingUserReviewCount: cases.filter((row) => row.verification === 'pending_user_review').length,
    verifiedCount: cases.filter((row) => row.verification === 'verified').length,
    taskOutcomeCounts: taskOutcomeCounts(cases),
    retryableProviderFailureRate: booleanRate(cases, (row) => row.providerFailureRetryable),
    pathBoundaryRejectionRate: booleanRate(cases, (row) => row.pathBoundaryRejected),
    truthRecoveryRate,
    truthRecoveryRateWilson95: wilson95(truthRecoveryRate.numerator, truthRecoveryRate.denominator),
    verifiedPathPrecisionWilson95: wilson95(truePositive, predicted.size),
    verifiedPathRecallWilson95: wilson95(truePositive, expected.size),
  };
}


function samePathSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === new Set(expected).size && actual.every((path) => expected.includes(path));
}

/** Wilson's interval avoids the misleading 0%/100% certainty of small samples. */
function wilson95(successes: number, trials: number): ConfidenceInterval | undefined {
  if (trials === 0) return undefined;
  const z = 1.96;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (proportion + (z * z) / (2 * trials)) / denominator;
  const radius = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * trials)) / trials) / denominator;
  return { lower: Math.max(0, centre - radius), upper: Math.min(1, centre + radius) };
}

/** Keys paths by fixture so identical paths in different interrupted workspaces are counted independently. */
function pathKeys(
  cases: readonly Extract<RecoveryEvaluationCase, { layer: 'interrupted_checkpoint' }>[],
  select: (caseRow: Extract<RecoveryEvaluationCase, { layer: 'interrupted_checkpoint' }>) => readonly string[],
): Set<string> {
  return new Set(cases.flatMap((caseRow) => select(caseRow).map((path) => `${caseRow.caseId}\u0000${path}`)));
}
function isCheckpointCase(caseRow: RecoveryEvaluationCase): caseRow is Extract<RecoveryEvaluationCase, { layer: 'interrupted_checkpoint' }> {
  return caseRow.layer === 'interrupted_checkpoint';
}


function booleanRate(
  cases: readonly RecoveryEvaluationCase[],
  select: (caseRow: RecoveryEvaluationCase) => boolean | undefined,
): Ratio {
  const observed = cases.filter((caseRow) => select(caseRow) !== undefined);
  return ratio(observed.filter((caseRow) => select(caseRow) === true).length, observed.length);
}

function evidenceCoverage(cases: readonly RecoveryEvaluationCase[]): Ratio {
  const attempted = cases.reduce((total, caseRow) => total + (caseRow.evidenceSourcesAttempted ?? 0), 0);
  const available = cases.reduce((total, caseRow) => total + Math.min(caseRow.evidenceSourcesAvailable ?? 0, caseRow.evidenceSourcesAttempted ?? 0), 0);
  return ratio(available, attempted);
}

function averageOptional(values: readonly (number | undefined)[]): number {
  return average(values.filter((value): value is number => value !== undefined));
}

function taskOutcomeCounts(cases: readonly RecoveryEvaluationCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of cases) {
    const outcome = row.taskOutcome ?? "unclassified";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

function rejectionReasons(cases: readonly RecoveryEvaluationCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const caseRow of cases) {
    for (const reason of caseRow.verifierRejectionReasons ?? []) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function ratio(numerator: number, denominator: number): Ratio {
  return denominator === 0 ? { numerator, denominator } : { numerator, denominator, value: numerator / denominator };
}

function averageObserved(values: readonly (number | undefined)[]): number | undefined {
  const observed = values.filter((value): value is number => value !== undefined);
  return observed.length ? average(observed) : undefined;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}


export type RecoveryEvaluationArtifactSink = {
  commitArtifact(input: { artifactId: string; kind: string; mediaType: string; bytes: Uint8Array; operationId: string }): Promise<unknown>;
};

/** Persists a schema-checked measurement artifact for offline comparison/reporting. */
export async function persistRecoveryEvaluation(
  sink: RecoveryEvaluationArtifactSink,
  rows: readonly unknown[],
  artifactId = 'recovery-evaluation',
  lifecycleEvents: readonly { type: string; payload: unknown }[] = [],
): Promise<void> {
  const checkedRows = rows.map((row) => {
    if (!Value.Check(RecoveryEvaluationCaseSchema, row))
      throw new Error('Recovery evaluation row does not match RecoveryEvaluationCaseSchema.');
    return row;
  });
  assertRecoveryEvaluationIntegrity(checkedRows);
  assertRecoveryEvaluationLifecycleIntegrity(checkedRows, lifecycleEvents);
  const metrics = evaluateRecoveryCases(checkedRows);
  const report = { schemaVersion: 1, rows: checkedRows, metrics };
  await sink.commitArtifact({
    artifactId,
    kind: 'recovery_evaluation',
    mediaType: 'application/json',
    bytes: Buffer.from(JSON.stringify(report), 'utf8'),
    operationId: `${artifactId}-created`,
  });
}



/**
 * Cross-checks the row against the append-only lifecycle evidence when a run supplies it.
 * This prevents the aggregate from silently dropping model or candidate attempts.
 */
export function assertRecoveryEvaluationLifecycleIntegrity(
  rows: readonly RecoveryEvaluationCase[],
  events: readonly { type: string; payload: unknown }[],
): void {
  if (events.length === 0) return;
  const grouped = new Map<string, { type: string; payload: unknown }[]>();
  for (const event of events.filter((event) => event.type === 'recovery.model_input' || event.type === 'recovery.candidate_created' || event.type === 'recovery.attempt')) {
    const payload = event.payload;
    const caseId = typeof payload === 'object' && payload !== null && 'caseId' in payload && typeof payload.caseId === 'string' ? payload.caseId : undefined;
    if (!caseId) throw new Error('evaluation_integrity_failed: lifecycle event has no caseId.');
    const group = grouped.get(caseId) ?? [];
    group.push(event);
    grouped.set(caseId, group);
  }
  const rowIds = new Set(rows.map((row) => row.caseId));
  for (const caseId of grouped.keys()) if (!rowIds.has(caseId)) throw new Error(`evaluation_integrity_failed: lifecycle event belongs to unknown case ${caseId}.`);
  for (const row of rows) {
    const caseEvents = grouped.get(row.caseId) ?? [];
    const modelCalls = caseEvents.filter((event) => event.type === 'recovery.model_input').length;
    const candidateCreated = caseEvents.filter((event) => event.type === 'recovery.candidate_created').length;
    if (caseEvents.length === 0 && (row.modelCalls > 0 || row.candidateCreated)) throw new Error(`evaluation_integrity_failed: lifecycle events are missing for ${row.caseId}.`);
    if (row.modelCalls !== modelCalls) throw new Error(`evaluation_integrity_failed: modelCalls does not match lifecycle events for ${row.caseId}.`);
    if (row.candidateCreated !== (candidateCreated > 0)) throw new Error(`evaluation_integrity_failed: candidateCreated does not match lifecycle events for ${row.caseId}.`);
    if (row.candidateCreated && row.candidateCount !== candidateCreated) throw new Error(`evaluation_integrity_failed: candidateCount does not match lifecycle events for ${row.caseId}.`);
    const attemptDurations = caseEvents.filter((event) => event.type === 'recovery.attempt').map((event) => event.payload).filter((payload): payload is { durationMs: number } => typeof payload === 'object' && payload !== null && 'durationMs' in payload && typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs >= 0).reduce((total, payload) => total + payload.durationMs, 0);
    if (row.durationMs < attemptDurations) throw new Error(`evaluation_integrity_failed: durationMs is below lifecycle attempt duration for ${row.caseId}.`);
  }
}

/** Rejects internally contradictory v2 terminal rows before publishing an aggregate artifact. */
export function assertRecoveryEvaluationIntegrity(
  rows: readonly RecoveryEvaluationCase[],
): void {
  const caseIds = new Set<string>();
  for (const row of rows) {
    if (caseIds.has(row.caseId))
      throw new Error(`evaluation_integrity_failed: duplicate caseId ${row.caseId}.`);
    caseIds.add(row.caseId);
    if (row.schemaVersion !== 2) continue;
    if (row.candidateCreated && (row.candidateCount === undefined || row.candidateCount < 1))
      throw new Error(`evaluation_integrity_failed: candidateCreated requires candidateCount for ${row.caseId}.`);
    if (!row.candidateCreated && (row.candidateCount ?? 0) > 0)
      throw new Error(`evaluation_integrity_failed: candidateCount requires candidateCreated for ${row.caseId}.`);
    if (row.terminal.status === 'completed' && row.terminal.failureCode !== undefined)
      throw new Error(`evaluation_integrity_failed: completed terminal cannot have failureCode for ${row.caseId}.`);
  }
}



export type RecoveryEvaluationFailureCode = NonNullable<RecoveryEvaluationTerminalCase['terminal']['failureCode']>;
export type RecoveryEvaluationCaseDraft = Omit<RecoveryEvaluationTerminalCase, 'terminal' | 'sourceAudit'>;
export type RecoveryEvaluationSourceAudit = 'passed' | 'failed' | 'unavailable';

/**
 * A safe boundary error for evaluation adapters. Adapters classify a failure
 * without passing provider text, paths, or session content into artifacts.
 */
export class RecoveryEvaluationError extends Error {
  readonly failureCode: RecoveryEvaluationFailureCode;
  readonly operation: string;
  /** Progress captured before a known business failure; kept in the terminal row. */
  readonly progress?: RecoveryEvaluationCaseDraft;

  constructor(failureCode: RecoveryEvaluationFailureCode, operation: string, progress?: RecoveryEvaluationCaseDraft) {
    super('Recovery evaluation operation failed.');
    this.name = 'RecoveryEvaluationError';
    this.failureCode = failureCode;
    this.operation = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation) ? operation : 'case.run';
    if (progress) this.progress = progress;
  }
}

export type RecoveryEvaluationBatchCase = {
  readonly caseId: string;
  readonly run: () => Promise<RecoveryEvaluationCaseDraft>;
  readonly auditSource: () => Promise<RecoveryEvaluationSourceAudit>;
  readonly lifecycleEvents?: readonly { type: string; payload: unknown }[];
};

export type RecoveryEvaluationCaseSink = {
  writeStarted(record: { schemaVersion: 1; caseId: string; startedAt: string }): Promise<void>;
  writeTerminal(record: RecoveryEvaluationTerminalCase): Promise<void>;
  writeSourceAudit(record: { schemaVersion: 1; caseId: string; outcome: RecoveryEvaluationSourceAudit }): Promise<void>;
};

/**
 * Runs every selected case independently. A thrown case is converted to a safe v2 terminal row;
 * it never aborts the remaining evaluation population.
 */
export async function runRecoveryEvaluationBatch(
  cases: readonly RecoveryEvaluationBatchCase[],
  sink: RecoveryEvaluationCaseSink,
  now: () => string = () => new Date().toISOString(),
): Promise<RecoveryEvaluationTerminalCase[]> {
  const rows: RecoveryEvaluationTerminalCase[] = [];
  for (const caseInput of cases) {
    const started = { schemaVersion: 1 as const, caseId: caseInput.caseId, startedAt: now() };
    const startedAtMs = Date.now();
    let draft: RecoveryEvaluationCaseDraft | undefined;
    let failure: RecoveryEvaluationFailureCode | undefined;
    let operation = 'case.run';
    let progress: RecoveryEvaluationCaseDraft | undefined;
    let sourceAudit: RecoveryEvaluationSourceAudit = 'unavailable';
    let terminalPersistenceError: unknown;
    try {
      if (!Value.Check(RecoveryEvaluationCaseStartedSchema, started)) throw new Error('Recovery evaluation start record is invalid.');
      await sink.writeStarted(started);
      draft = await caseInput.run();
      if (draft.schemaVersion !== 2 || draft.caseId !== caseInput.caseId || !Value.Check(RecoveryEvaluationTerminalCaseSchema, { ...draft, terminal: { status: 'completed' }, sourceAudit }))
        throw new RecoveryEvaluationError('evaluation_protocol_error', 'case.protocol');
    } catch (error) {
      failure = classifyEvaluationFailure(error);
      operation = error instanceof RecoveryEvaluationError ? error.operation : 'case.run';
      progress = error instanceof RecoveryEvaluationError ? error.progress : undefined;
    } finally {
      try {
        sourceAudit = await caseInput.auditSource();
        if (!isSourceAudit(sourceAudit)) sourceAudit = 'unavailable';
        if (sourceAudit === 'failed') failure ??= 'source_tripwire_failed';
      } catch {
        sourceAudit = 'unavailable';
        failure ??= 'source_tripwire_failed';
      }
      try {
        await sink.writeSourceAudit({ schemaVersion: 1, caseId: caseInput.caseId, outcome: sourceAudit });
      } catch {
        sourceAudit = 'unavailable';
        failure ??= 'runner_crashed';
      }
    }
    const failureProgress = progress ?? (failure ? draft : undefined);
      const proposed = failure
        ? { ...failedEvaluationCase(caseInput.caseId, failure, sourceAudit, operation, elapsedMs(startedAtMs)), ...(failureProgress ?? {}), schemaVersion: 2 as const, caseId: caseInput.caseId, terminal: { status: failure === 'cancelled' ? 'cancelled' as const : 'failed' as const, failureCode: failure, operation }, sourceAudit }
        : draft
          ? { ...draft, terminal: { status: 'completed' as const }, sourceAudit }
          : failedEvaluationCase(caseInput.caseId, 'runner_crashed', sourceAudit, operation, elapsedMs(startedAtMs));
    if (!Value.Check(RecoveryEvaluationTerminalCaseSchema, proposed))
      throw new RecoveryEvaluationError('evaluation_protocol_error', 'case.protocol');
    const row = proposed;
    try {
      await sink.writeTerminal(row);
    } catch (error) {
      terminalPersistenceError = error;
    }
    if (terminalPersistenceError)
      throw terminalPersistenceError instanceof Error ? terminalPersistenceError : new Error('Recovery terminal persistence failed.');
    rows.push(row);
  }
  const lifecycleEvents = cases.flatMap((caseInput) => caseInput.lifecycleEvents ?? []);
  assertRecoveryEvaluationLifecycleIntegrity(rows, lifecycleEvents);
  return rows;
}

/** Creates an append-only filesystem sink; case identifiers are schema-constrained before use as paths. */
export function createRecoveryEvaluationFileSink(root: string): RecoveryEvaluationCaseSink {
  const casesRoot = resolve(root, 'cases');
  return {
    async writeStarted(record) { await writeCaseJson(casesRoot, record.caseId, 'case.started.json', record, RecoveryEvaluationCaseStartedSchema); },
    async writeTerminal(record) { await writeCaseJson(casesRoot, record.caseId, 'case.terminal.json', record, RecoveryEvaluationTerminalCaseSchema); },
    async writeSourceAudit(record) { await writeCaseJson(casesRoot, record.caseId, 'source-audit.json', record, RecoveryEvaluationSourceAuditSchema); },
  };
}

function failedEvaluationCase(caseId: string, failureCode: RecoveryEvaluationFailureCode, sourceAudit: RecoveryEvaluationSourceAudit, operation = 'case.run', durationMs = 0): RecoveryEvaluationTerminalCase {
  return { schemaVersion: 2, caseId, layer: 'history_completed', forensicsStarted: false, candidateCreated: false, verification: 'insufficient_evidence', recoveredPaths: [], modelCalls: 0, durationMs, terminal: { status: failureCode === 'cancelled' ? 'cancelled' : 'failed', failureCode, operation }, sourceAudit };
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function classifyEvaluationFailure(error: unknown): RecoveryEvaluationFailureCode {
  if (error instanceof RecoveryEvaluationError) return error.failureCode;
  if (error instanceof Error && /cancel/i.test(error.message)) return 'cancelled';
  return 'runner_crashed';
}

function isSourceAudit(value: unknown): value is RecoveryEvaluationSourceAudit {
  return value === 'passed' || value === 'failed' || value === 'unavailable';
}

async function writeCaseJson(
  casesRoot: string,
  caseId: string,
  name: string,
  value: unknown,
  schema: TSchema | undefined,
): Promise<void> {
  if (schema && !Value.Check(schema, value)) throw new Error('Recovery evaluation persistence record is invalid.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(caseId)) throw new Error('Recovery evaluation case id is unsafe.');
  const directory = join(casesRoot, caseId);
  const target = join(directory, name);
  await mkdir(directory, { recursive: true });
  try { await stat(target); throw new Error(`Recovery evaluation record already exists: ${name}.`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await writeAtomic(target, `${JSON.stringify(value)}\n`);
}

export function recoveryTimingSummary(
  attempts: readonly import("../../core/schema.js").RecoveryLifecycleAttempt[],
): {
  forensicsMs?: number;
  modelRequestMs?: number;
  candidateMaterializationMs?: number;
} {
  const sum = (operation: import("../../core/schema.js").RecoveryLifecycleAttempt["operation"]): number | undefined => {
    const values = attempts
      .filter((attempt) => attempt.operation === operation && attempt.result !== "started")
      .map((attempt) => attempt.durationMs);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const forensicsMs = sum("resolve_facts");
  const modelRequestMs = sum("invoke_model");
  const candidateMaterializationMs = sum("create_candidate");
  return {
    ...(forensicsMs === undefined ? {} : { forensicsMs }),
    ...(modelRequestMs === undefined ? {} : { modelRequestMs }),
    ...(candidateMaterializationMs === undefined ? {} : { candidateMaterializationMs }),
  };
}

export function recoveryEvaluationCase(input: {
  caseId: string;
  staging?: RecoveryStaging | undefined;
  candidateCreated: boolean;
  recoveredPaths: string[];
  verification:
    "verified" | "pending_user_review" | "rejected" | "insufficient_evidence";
  forensicsCompleted: boolean;
  evidenceSourcesAttempted?: number | undefined;
  evidenceSourcesAvailable?: number | undefined;
  hypothesisCount?: number | undefined;
  candidateCount?: number | undefined;
  verifierRejectionReasons?: readonly string[] | undefined;
  providerFailureRetryable?: boolean | undefined;
  pathBoundaryRejected?: boolean | undefined;
  readiness?: RecoveryReadinessResult;
  taskOutcome?: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"];
  modelCalls: number;
  startedAt: string;
  timings?: { forensicsMs?: number; modelRequestMs?: number; candidateMaterializationMs?: number; };
}): import("../../core/schema.js").RecoveryEvaluationCase {
  const common = {
    schemaVersion: 1 as const,
    caseId: input.caseId,
    stagingSucceeded: Boolean(input.staging),
    forensicsStarted: Boolean(input.staging),
    forensicsCompleted: input.forensicsCompleted,
    ...(input.evidenceSourcesAttempted === undefined
      ? {}
      : { evidenceSourcesAttempted: input.evidenceSourcesAttempted }),
    ...(input.evidenceSourcesAvailable === undefined
      ? {}
      : { evidenceSourcesAvailable: input.evidenceSourcesAvailable }),
    ...(input.hypothesisCount === undefined
      ? {}
      : { hypothesisCount: input.hypothesisCount }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount }),
    ...(input.verifierRejectionReasons?.length
      ? { verifierRejectionReasons: [...input.verifierRejectionReasons] }
      : {}),
    ...(input.providerFailureRetryable === undefined
      ? {}
      : { providerFailureRetryable: input.providerFailureRetryable }),
    ...(input.pathBoundaryRejected === undefined
      ? {}
      : { pathBoundaryRejected: input.pathBoundaryRejected }),
    ...(input.readiness ? { readinessStatus: input.readiness.status, readinessCheckedPaths: input.readiness.checkedPaths, readinessMissingPaths: input.readiness.missingPaths } : {}),
    ...(input.taskOutcome ? { taskOutcome: input.taskOutcome } : {}),
    candidateCreated: input.candidateCreated,
    verification: input.verification,
    recoveredPaths: [...new Set(input.recoveredPaths)],
    modelCalls: input.modelCalls,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    ...(input.timings && Object.keys(input.timings).length ? { timings: input.timings } : {}),
  };
  const checkpointPaths =
    input.staging?.checkpointFingerprint?.resources
      .filter((resource) => resource.kind === "file")
      .map((resource) => resource.path) ?? [];
  if (checkpointPaths.length > 0)
    return { ...common, layer: "interrupted_checkpoint", checkpointPaths };
  return { ...common, layer: "history_completed" };
}
