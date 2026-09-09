import { Value } from '@sinclair/typebox/value';
import {
  RunRecordSchema,
  TaskCaseSchema,
  type RunRecord,
  type TaskCase,
} from '../core/schema.js';
import {
  assertComparisonResult,
  type ComparisonAgentPort,
  type ComparisonContext,
  type ComparisonReportFacts,
  type ComparisonResult,
} from '../agents/comparison-agent.js';
import type { AgentAuditSink, AgentToolDefinition, StructuredAgentResult } from '../infrastructure/agent/host.js';
import { recoveryEvidenceCatalog } from '../infrastructure/recovery-tools.js';

export type RunInspection = {
  runId: string;
  finalMessage?: string;
  changedPaths: readonly string[];
  runtimeGeneratedPaths: readonly string[];
  commands: readonly string[];
  rejectedApprovals: number;
  turns: number;
  wallClockMs?: number;
  tokenCount?: number;
  tokenUsage?: { total?: number; input?: number; output?: number; cached?: number; reasoning?: number };
  generationMs?: number;
  replayConditions?: readonly string[];
  workspaceEvidenceStatus?: 'available' | 'not_collected' | 'unavailable';
};

export function buildComparisonContext(taskCase: TaskCase, runs: readonly RunRecord[], inspections: readonly RunInspection[] = []): ComparisonContext {
  assertFacts(taskCase, runs);
  const byRunId = new Map(inspections.map((inspection) => [inspection.runId, inspection]));
  const primary = runs[0];
  const inspection = primary ? byRunId.get(primary.attempt.runId) : undefined;
  const hostReplay = inspection?.replayConditions?.length && primary
    ? {
        sourceRootKind: kindFromConditions(inspection.replayConditions),
        stopKind: primary.outcome.termination.code,
        conditions: inspection.replayConditions,
      }
    : undefined;
  return {
    task: { caseId: taskCase.caseId, summary: taskCase.initialInput.text },
    baseline: {
      summary: taskCase.baseline.finalMessage ?? `Baseline ${taskCase.baseline.status}.`,
      evidenceRefs: unique([...taskCase.baseline.evidenceRefs, ...taskCase.baseline.artifactRefs.map((ref) => `artifact:${ref.artifactId}`)]),
    },
    candidates: runs.map((run) => ({
      runId: run.attempt.runId,
      summary: inspectionSummary(run, byRunId.get(run.attempt.runId), taskCase.privacy.allowModelText),
      evidenceRefs: runEvidence(run),
    })),
    telemetry: runs.map((run) => ({ runId: run.attempt.runId, summary: telemetrySummary(run, byRunId.get(run.attempt.runId)) })),
    reportFacts: buildReportFacts(primary, inspection, taskCase, hostReplay),
    artifactRefs: unique(runs.flatMap((run) => run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`))),
    allowModelText: taskCase.privacy.allowModelText,
    replayScope: {
      historical: 'TaskCase transcript, baseline.finalMessage, and baseline evidenceRefs are the frozen original session. They are not this candidate\'s actions.',
      candidate: 'This replay is only the inspection, run record, host-trace.json, candidate-workspace-scope.json, and run events. changedPaths are files the candidate wrote after Host rewound the replica to the session start. Isolation paths are not a capability difference.',
    },
    ...(hostReplay ? { hostReplay } : {}),
  };
}

export async function comparePersistedFacts(input: {
  taskCase: TaskCase;
  runs: readonly RunRecord[];
  agent: ComparisonAgentPort;
  tools?: readonly AgentToolDefinition[];
  inspections?: readonly RunInspection[];
  audit?: AgentAuditSink;
}): Promise<{ context: ComparisonContext; result: StructuredAgentResult<ComparisonResult> }> {
  const context = buildComparisonContext(input.taskCase, input.runs, input.inspections);
  const result = await input.agent.compare(context, input.tools, input.audit);
  if (result.status === 'completed') assertComparisonResult(result.value, context);
  return { context, result };
}

function buildReportFacts(run: RunRecord | undefined, inspection: RunInspection | undefined, taskCase: TaskCase, hostReplay: ComparisonContext['hostReplay']): ComparisonReportFacts {
  if (!run) return {
    run: { runId: 'unavailable', outcome: 'unavailable', terminationCode: 'unavailable', initiatedBy: 'unavailable' },
    models: { candidate: 'unavailable' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'unavailable' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: evidenceLevel(taskCase.baseline.evidenceRefs), candidateEvidence: 'unavailable' },
  };
  const triggered = run.outcome.termination.kind === 'limit_reached' ? [run.outcome.termination.code] : [];
  const metrics = projectedMetrics(inspection);
  return {
    run: { runId: run.attempt.runId, outcome: run.outcome.task.status, terminationCode: run.outcome.termination.code, initiatedBy: run.outcome.termination.initiatedBy, ...(inspection?.wallClockMs === undefined ? {} : { candidateElapsedMs: inspection.wallClockMs }) },
    models: { candidate: run.manifest?.resolvedModel.resolved ?? run.attempt.candidate.requestedModel, ...(run.manifest ? { controller: run.manifest.controller.requestedModel, comparison: run.manifest.comparison.requestedModel } : {}) },
    activity: { ...(inspection ? { candidateTurns: inspection.turns } : {}) },
    limits: { wallClockMs: run.attempt.policy.wallClockMs, maxTargetTurns: run.attempt.policy.maxTargetTurns, maxModelCalls: run.attempt.policy.maxModelCalls, triggered },
    runtime: { productId: run.attempt.candidate.productId },
    delivery: { changedPaths: inspection?.changedPaths ?? [], targetArtifactStatus: run.artifactRefs.length ? 'artifacts_recorded' : 'not_collected', verificationStatus: run.outcome.task.status },
    replay: { ...(hostReplay?.sourceRootKind ? { sourceRootKind: hostReplay.sourceRootKind } : {}), conditions: hostReplay?.conditions ?? [], baselineEvidence: evidenceLevel(taskCase.baseline.evidenceRefs), candidateEvidence: evidenceLevel(run.outcome.task.evidenceRefs) },
    ...(metrics ? { metrics } : {}),
  };
}

function projectedMetrics(inspection: RunInspection | undefined): ComparisonReportFacts['metrics'] {
  const tokens = inspection?.tokenUsage;
  if (!tokens) return undefined;
  const generationRate =
    tokens.output !== undefined && inspection?.generationMs !== undefined
      ? { outputTokens: tokens.output, durationMs: inspection.generationMs }
      : undefined;
  return {
    tokens,
    ...(generationRate ? { generationRate } : {}),
  };
}

function evidenceLevel(refs: readonly string[]): string {
  return refs.length ? 'verifiable' : 'session_claim_only';
}

function assertFacts(taskCase: TaskCase, runs: readonly RunRecord[]): void {
  if (!Value.Check(TaskCaseSchema, taskCase)) throw new Error('Invalid TaskCase for comparison.');
  for (const run of runs) {
    if (!Value.Check(RunRecordSchema, run)) throw new Error('Invalid RunRecord for comparison.');
    if (run.attempt.caseId !== taskCase.caseId) throw new Error(`Run ${run.attempt.runId} does not belong to case ${taskCase.caseId}.`);
  }
}

function inspectionSummary(run: RunRecord, inspection: RunInspection | undefined, allowModelText: boolean): string {
  const facts = [`task=${run.outcome.task.status}`, `termination=${run.outcome.termination.code}`];
  if (!inspection) return `${facts.join('; ')}.`;
  facts.push(`turns=${inspection.turns}`, `changedFiles=${inspection.changedPaths.length}`, `commands=${inspection.commands.length}`);
  if (inspection.rejectedApprovals) facts.push(`rejectedApprovals=${inspection.rejectedApprovals}`);
  if (allowModelText && inspection.finalMessage) facts.push(`finalMessage=${inspection.finalMessage}`);
  if (inspection.replayConditions?.length) facts.push(`hostConditions=${inspection.replayConditions.join(' | ')}`);
  return `${facts.join('; ')}.`;
}

function telemetrySummary(run: RunRecord, inspection: RunInspection | undefined): string {
  if (!inspection) return `Trace events ${run.trace.firstSequence}-${run.trace.lastSequence}.`;
  return [`turns=${inspection.turns}`, inspection.wallClockMs === undefined ? undefined : `wallClockMs=${inspection.wallClockMs}`, inspection.tokenCount === undefined ? undefined : `tokens=${inspection.tokenCount}`].filter((value): value is string => Boolean(value)).join('; ');
}

function runEvidence(run: RunRecord): string[] {
  return unique([
    ...run.outcome.task.evidenceRefs,
    ...run.outcome.cleanup.evidenceRefs,
    ...(run.outcome.termination.failure?.evidenceRefs ?? []),
    ...run.warnings.flatMap((warning) => warning.evidenceRefs),
    ...run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`),
  ]);
}

export function comparisonOwnedObservationRefs(
  taskCase: TaskCase,
  events: readonly { eventId: string }[] = [],
): string[] {
  return unique([
    ...recoveryEvidenceCatalog(taskCase).map((entry) => entry.ref),
    ...events.map((event) => `event:${event.eventId}`),
  ]);
}

export function briefingComparisonContext(context: ComparisonContext): ComparisonContext {
  const briefing = { ...context };
  delete briefing.ownedEvidenceRefs;
  delete briefing.attemptId;
  return briefing;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function kindFromConditions(conditions: readonly string[]): string {
  const hit = conditions.find((item) => item.startsWith('sourceRootKind='));
  return hit?.slice('sourceRootKind='.length).split(/[.\s]/, 1)[0] ?? 'unknown';
}
