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
  type ComparisonFactsContext,
  type ComparisonReportFacts,
  type ComparisonResult,
} from '../agents/comparison-agent.js';
import type { AgentAuditSink, AgentToolDefinition, StructuredAgentResult } from '../infrastructure/agent/host.js';
import { recoveryEvidenceCatalog } from '../products/history/source-refs.js';
import {
  aggregateHistoricalUsage,
  busyMsFromHistoricalEvents,
  factsFromUsage,
  usagePricing,
} from './session-usage.js';
import { loadOperatorPricingOverride, MODEL_PRICING_TABLE_VERSION } from './model-pricing.js';
import type { ComparisonMetricSide } from '../agents/comparison-agent.js';

export type RunInspection = {
  runId: string;
  finalMessage?: string;
  changedPaths: readonly string[];
  runtimeGeneratedPaths: readonly string[];
  controllerWritePaths?: readonly string[];
  controllerExternalWritePaths?: readonly string[];
  commands: readonly string[];
  rejectedApprovals: number;
  turns: number;
  wallClockMs?: number;
  tokenCount?: number;
  tokenUsage?: { total?: number; input?: number; output?: number; cached?: number; reasoning?: number };
  costUsd?: number;
  pricingLookup?: "hit" | "miss" | "invalid";
  pricingModelId?: string;
  pricingSource?: string;
  pricingVersion?: string;
  pricingRates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  generationMs?: number;
  replayConditions?: readonly string[];
  workspaceEvidenceStatus?: 'available' | 'not_collected' | 'unavailable';
};

export function buildComparisonContext(
  taskCase: TaskCase,
  runs: readonly RunRecord[],
  inspections: readonly RunInspection[] = [],
  pricing?: { dataDir?: string; comparisonModel?: string },
): ComparisonFactsContext {
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
      evidenceRefs: runEvidence(run),
    })),
    telemetry: runs.map((run) => ({ runId: run.attempt.runId })),
    reportFacts: buildReportFacts(primary, inspection, taskCase, hostReplay, pricing),
    artifactRefs: unique(runs.flatMap((run) => run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`))),
    allowModelText: true,
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
  attemptId: string;
  dataDir?: string;
  comparisonModel?: string;
}): Promise<{ context: ComparisonContext; result: StructuredAgentResult<ComparisonResult> }> {
  if (!input.attemptId) throw new Error("Comparison attemptId is required.");
  const facts = buildComparisonContext(input.taskCase, input.runs, input.inspections, {
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.comparisonModel ? { comparisonModel: input.comparisonModel } : {}),
  });
  const context: ComparisonContext = {
    ...facts,
    attemptId: input.attemptId,
  };
  const result = await input.agent.compare(context, input.tools, input.audit);
  if (result.status === 'completed') assertComparisonResult(result.value, context);
  return { context, result };
}

function buildReportFacts(
  run: RunRecord | undefined,
  inspection: RunInspection | undefined,
  taskCase: TaskCase,
  hostReplay: ComparisonContext['hostReplay'],
  pricing?: { dataDir?: string; comparisonModel?: string },
): ComparisonReportFacts {
  if (!run) return {
    run: { runId: 'unavailable', outcome: 'unavailable', terminationCode: 'unavailable', initiatedBy: 'unavailable' },
    models: comparisonModels(taskCase, undefined, pricing?.comparisonModel), activity: {}, limits: { triggered: [] }, runtime: { productId: 'unavailable' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: evidenceLevel(taskCase.baseline.evidenceRefs), candidateEvidence: 'unavailable' },
  };
  const triggered = run.outcome.termination.kind === 'limit_reached' ? [run.outcome.termination.code] : [];
  const metrics = projectedMetrics(taskCase, inspection, run, pricing?.dataDir);
  return {
    run: { runId: run.attempt.runId, outcome: run.outcome.task.status, terminationCode: run.outcome.termination.code, initiatedBy: run.outcome.termination.initiatedBy, ...(inspection?.wallClockMs === undefined ? {} : { candidateElapsedMs: inspection.wallClockMs }) },
    models: comparisonModels(taskCase, run, pricing?.comparisonModel),
    activity: { ...(inspection ? { candidateTurns: inspection.turns } : {}) },
    limits: { wallClockMs: run.attempt.policy.wallClockMs, maxTargetTurns: run.attempt.policy.maxTargetTurns, maxModelCalls: run.attempt.policy.maxModelCalls, triggered },
    runtime: { productId: run.attempt.candidate.productId },
    delivery: {
      changedPaths: inspection?.changedPaths ?? [],
      targetArtifactStatus: run.artifactRefs.length ? 'artifacts_recorded' : 'not_collected',
      verificationStatus: run.outcome.task.status,
      ...(inspection ? { changedPathsIndexed: inspection.changedPaths.length } : {}),
    },
    replay: { ...(hostReplay?.sourceRootKind ? { sourceRootKind: hostReplay.sourceRootKind } : {}), conditions: hostReplay?.conditions ?? [], baselineEvidence: evidenceLevel(taskCase.baseline.evidenceRefs), candidateEvidence: evidenceLevel(run.outcome.task.evidenceRefs) },
    ...(metrics ? { metrics } : {}),
  };
}

function comparisonModels(taskCase: TaskCase, run: RunRecord | undefined, comparisonModel?: string): ComparisonReportFacts["models"] {
  const baseline = taskCase.sourceRuntimeEvidence.model;
  const comparison = usableComparisonModel(comparisonModel);
  if (!run) {
    return { candidate: "unavailable", ...(baseline ? { baseline } : {}), ...(comparison ? { comparison } : {}) };
  }
  return {
    candidate: run.manifest?.resolvedModel.resolved ?? run.attempt.candidate.requestedModel,
    candidateRequested: run.attempt.candidate.requestedModel,
    ...(run.manifest?.resolvedModel.resolved ? { candidateResolved: run.manifest.resolvedModel.resolved } : {}),
    ...(baseline ? { baseline } : {}),
    ...(run.manifest ? { controller: run.manifest.controller.requestedModel } : {}),
    ...(comparison ? { comparison } : {}),
  };
}

function usableComparisonModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "unavailable") return undefined;
  return trimmed;
}

function projectedMetrics(taskCase: TaskCase, inspection: RunInspection | undefined, run: RunRecord, dataDir?: string): ComparisonReportFacts['metrics'] {
  const baselineUsage = aggregateHistoricalUsage(taskCase.historicalEvents);
  const baselineBusy = busyMsFromHistoricalEvents(taskCase.historicalEvents);
  const baselineTokens = factsFromUsage(baselineUsage);
  const override = dataDir ? loadOperatorPricingOverride(dataDir) : undefined;
  const baselinePriced = usagePricing(baselineUsage, taskCase.sourceRuntimeEvidence.model, undefined, {
    productId: taskCase.source.productId,
    ...(override ? { override } : {}),
  });
  const lastHistorical = taskCase.historicalEvents.at(-1);
  const baselineCollectedAt = typeof lastHistorical?.timestamp === "string" ? lastHistorical.timestamp : undefined;
  return {
    baseline: sideMetrics(baselineBusy, baselineTokens, baselinePriced.costUsd, {
      provider: taskCase.source.productId,
      usagePresent: baselineUsage !== undefined,
      ...(baselineCollectedAt ? { collectedAt: baselineCollectedAt } : {}),
      ...pricingFields(baselinePriced),
    }),
    candidate: sideMetrics(inspection?.wallClockMs, inspection?.tokenUsage, inspection?.costUsd, {
      provider: run.attempt.candidate.productId,
      usagePresent: inspection?.tokenUsage !== undefined || inspection?.costUsd !== undefined,
      collectedAt: run.attempt.createdAt,
      ...pricingFields({
        lookup: inspection?.pricingLookup ?? (inspection?.costUsd !== undefined ? "hit" : "miss"),
        ...(inspection?.pricingModelId ? { pricingModelId: inspection.pricingModelId } : {}),
        ...(inspection?.pricingSource ? { pricingSource: inspection.pricingSource } : {}),
        ...(inspection?.pricingVersion ? { pricingVersion: inspection.pricingVersion } : {}),
        ...(inspection?.pricingRates ? { rates: inspection.pricingRates } : {}),
      }),
    }),
  };
}

function pricingFields(priced: {
  lookup: "hit" | "miss" | "invalid";
  pricingModelId?: string;
  pricingSource?: string;
  pricingVersion?: string;
  rates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
}): {
  pricingLookup?: "invalid";
  pricingModelId?: string;
  pricingSource?: string;
  pricingVersion?: string;
  rates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
} {
  return {
    ...(priced.lookup === "invalid" ? { pricingLookup: "invalid" as const } : {}),
    ...(priced.pricingModelId ? { pricingModelId: priced.pricingModelId } : {}),
    ...(priced.pricingSource ? { pricingSource: priced.pricingSource } : {}),
    ...(priced.pricingVersion ? { pricingVersion: priced.pricingVersion } : {}),
    ...(priced.rates ? { rates: priced.rates } : {}),
  };
}

function sideMetrics(
  elapsedMs: number | undefined,
  tokens: RunInspection['tokenUsage'] | undefined,
  costUsd: number | undefined,
  meta: {
    provider: string;
    collectedAt?: string;
    usagePresent: boolean;
    pricingLookup?: "invalid";
    pricingModelId?: string;
    pricingSource?: string;
    pricingVersion?: string;
    rates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  },
): ComparisonMetricSide {
  const total = tokens === undefined ? undefined : tokenTotal(tokens);
  const usageStatus = total !== undefined
    ? "collected" as const
    : meta.usagePresent
      ? "unknown" as const
      : "not_collected" as const;
  const pricingStatus = meta.pricingLookup === "invalid"
    ? "unknown" as const
    : total !== undefined && costUsd !== undefined
      ? "collected" as const
      : total !== undefined
        ? "pricing_unavailable" as const
        : meta.usagePresent || costUsd !== undefined
          ? "unknown" as const
          : "not_collected" as const;
  return {
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(total === undefined || tokens === undefined ? {} : {
      tokens: {
        total,
        ...(tokens.input === undefined ? {} : { input: tokens.input }),
        ...(tokens.output === undefined ? {} : { output: tokens.output }),
        ...(tokens.cached === undefined ? {} : { cached: tokens.cached }),
        ...(tokens.reasoning === undefined ? {} : { reasoning: tokens.reasoning }),
      },
    }),
    ...(costUsd === undefined ? {} : { costUsd, pricingVersion: meta.pricingVersion ?? MODEL_PRICING_TABLE_VERSION }),
    usageStatus,
    pricingStatus,
    toolCostsIncluded: false,
    provider: meta.provider,
    ...(meta.collectedAt ? { collectedAt: meta.collectedAt } : {}),
    ...(meta.pricingModelId ? { pricingModelId: meta.pricingModelId } : {}),
    ...(meta.pricingSource ? { pricingSource: meta.pricingSource } : {}),
    ...(meta.rates ? { pricingRates: meta.rates } : {}),
  };
}

function tokenTotal(tokens: NonNullable<RunInspection['tokenUsage']>): number | undefined {
  if (tokens.total !== undefined) return tokens.total;
  if (tokens.input === undefined && tokens.output === undefined && tokens.cached === undefined) return undefined;
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cached ?? 0);
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

export function briefingComparisonContext(context: ComparisonContext | ComparisonFactsContext): ComparisonFactsContext {
  const { attemptId: _attemptId, ownedEvidenceRefs: _owned, ...briefing } = {
    attemptId: "",
    ...context,
  };
  return briefing;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function kindFromConditions(conditions: readonly string[]): string {
  const hit = conditions.find((item) => item.startsWith('sourceRootKind='));
  return hit?.slice('sourceRootKind='.length).split(/[.\s]/, 1)[0] ?? 'unknown';
}
