import type { TimingFacts } from '../core/timing-schema.js';
import type { AgentLocale } from './language.js';
import { Value } from '@sinclair/typebox/value';
import type { HostZoneSnapshot } from '../core/comparison-html.js';
import { ComparisonResultSchema, type ComparisonAgentEnvelope, type ComparisonEvidenceCatalogSnapshot } from '../core/schema.js';
import type { AgentAuditSink, AgentInvocation, AgentToolDefinition } from '../infrastructure/agent/host.js';

export type { ComparisonAgentEnvelope } from '../core/schema.js';
export type ComparisonResult = Omit<ComparisonAgentEnvelope, 'reportPath'> & { reportPath: 'report.html' };
export type ComparisonContext = {
  locale?: AgentLocale;
  task: { caseId: string; summary: string };
  baseline: { summary: string; evidenceRefs: readonly string[] };
  candidates: readonly { runId: string; evidenceRefs: readonly string[] }[];
  telemetry: readonly { runId: string }[];
  reportFacts: ComparisonReportFacts;
  artifactRefs: readonly string[];
  allowModelText: boolean;
  replayScope: { historical: string; candidate: string };
  hostReplay?: {
    sourceRootKind: string;
    stopKind: string;
    conditions: readonly string[];
  };
  promptContent?: string;
  /** Host-owned observation and run-event refs; omitted from the model briefing JSON. */
  ownedEvidenceRefs?: readonly string[];
  /** Host-registered media the Agent may cite; included in briefing facts/media.json. */
  media?: readonly { ref: string; shortRef?: string }[];
  shortEvidenceRefs?: readonly string[];
  hostZoneSnapshot?: HostZoneSnapshot;
  /** Attempt identity remains stable across compose and fresh review Sessions. */
  attemptId: string;
};

export type ComparisonFactsContext = Omit<ComparisonContext, "attemptId">;
export type ComparisonReportFacts = {
  nativeExecution?: readonly import('../core/schema.js').NativeExecutionObservation[];
  executionBoundary?: import('../core/schema.js').ExecutionBoundary;
  sessionDates?: { baseline?: string; candidate?: string };
  sessionAgents?: { baseline?: string; candidate?: string };
  run: { runId: string; outcome: string; terminationCode: string; initiatedBy: string; elapsedMs?: number; candidateElapsedMs?: number };
  models: { candidate: string; candidateRequested?: string; candidateResolved?: string; baseline?: string; controller?: string; comparison?: string };
  activity: { candidateTurns?: number; controllerCalls?: number; toolCalls?: { total: number; succeeded: number; failed: number; rejectedApprovals: number } };
  limits: { wallClockMs?: number; maxTargetTurns?: number; maxModelCalls?: number; triggered: readonly string[] };
  runtime: { productId: string; sandbox?: string; approvalPolicy?: string; network?: string };
  delivery: { changedPaths: readonly string[]; targetArtifactStatus: string; verificationStatus: string; changedPathsIndexed?: number; changedPathsOmitted?: number };
  replay: { sourceRootKind?: string; conditions: readonly string[]; baselineEvidence: string; candidateEvidence: string; baselineIsSubstitute?: boolean };
  metrics?: {
    baseline?: ComparisonMetricSide;
    candidate?: ComparisonMetricSide;
    timingComparable?: boolean;
    timingComparison?: import("../core/timing-schema.js").TimingComparison;
  };
};

export type ComparisonMetricSide = {
  elapsedMs?: number;
  timing?: TimingFacts;
  spanElapsedMs?: number;
  tokens?: { total: number; input?: number; output?: number; cached?: number; reasoning?: number };
  costUsd?: number;
  usageStatus?: "collected" | "not_collected" | "unknown";
  pricingStatus?: "collected" | "not_collected" | "pricing_unavailable" | "unknown";
  pricingVersion?: string;
  collectedAt?: string;
  provider?: string;
  pricingModelId?: string;
  pricingSource?: string;
  pricingRates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  toolCostsIncluded?: boolean;
};

export interface ComparisonAgentPort {
  readonly workflow?: 'autonomous';
  /** Opts into bound findings tools, draft binding and persisted independent review. */
  readonly requireFindings?: boolean;
  /** Requires actual draft inspection even when using the legacy findings protocol. */
  readonly reviewInspectionRequired?: boolean;
  compare(
    context: ComparisonContext,
    tools?: readonly AgentToolDefinition[],
    audit?: AgentAuditSink,
    signal?: AbortSignal,
    options?: ComparisonCompareOptions,
  ): Promise<AgentInvocation<ComparisonResult>>;
  cancel(attemptId: string, factRef?: string): Promise<void>;
  release?(attemptId: string): void | Promise<void>;
}

export type ComparisonCompareOptions = {
  /** Same-process getter; must not be persisted into comparison.requested JSON. */
  getEvidenceCatalog?: () => Pick<ComparisonEvidenceCatalogSnapshot, "links" | "media">;
  /** Returns only a fully publishable result, including actual current inspection delivery to a subsequent generation request. */
  getSubmittedResult?: () => Promise<ComparisonResult | undefined>;
  /** Accepted author draft exists; this ends composition, never certifies review or publication. */
  hasAcceptedDraft?: () => boolean;
  onReviewStarted?: (sessionId: string) => void | Promise<void>;
  getSubmissionFailure?: () => { code: 'draft_invalid' | 'preview_failed'; message: string; kind?: 'protocol' | 'timeout' | 'tool' };
  getSubmissionState?: () => string;
  preflightDraft?: () => Promise<{ digest: string; error?: string }>;
  enforcePhaseBoundaries?: boolean;
  reviewFindings?: boolean;
  getFindingsState?: () => string;
  findingsReady?: () => boolean;
  closeBoundedInvestigation?: (boundary: { sessionId: string; reason: 'bounded_investigation_timeout' }, signal: AbortSignal) => Promise<void>;
  /** Accepted discovery snapshot exists; does not certify readiness or semantic correctness. */
  hasSavedFindings?: () => boolean;
  /** Actual full current/stale accepted draft delivered in this review; not final publication certification. */
  hasReviewDraftMaterial?: () => boolean;
  /** Actual formal inspection delivered for the current binding; does not certify semantics. */
  hasCurrentReviewInspection?: () => boolean;
  onDraftAuditStarted?: (sessionId: string) => void | Promise<void>;
  isRepairRead?: (params: unknown) => Promise<boolean>;
  estimateUsageCost?: (payload: Record<string, unknown>) => number | {
    costUsd?: number; pricingModelId?: string; pricingVersion?: string; pricingSource?: string;
    rates?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  } | undefined;
};

function comparisonEvidenceAllowlist(context: ComparisonFactsContext): Set<string> {
  return new Set(context.shortEvidenceRefs ?? []);
}

function validateComparisonEvidence(
  value: ComparisonAgentEnvelope,
  available: ReadonlySet<string>,
): string | undefined {
  if (available.size === 0) return undefined;
  const unknown = value.evidenceRefs.filter((ref) => !available.has(ref));
  if (unknown.length === 0) return undefined;
  const listed = [...available].sort().join(", ") || "(empty)";
  return `unknown evidence refs: ${unknown.join(", ")}; current catalog: ${listed}`;
}

export function assertComparisonResult(
  value: unknown,
  context: ComparisonFactsContext,
  getEvidenceCatalog?: ComparisonCompareOptions["getEvidenceCatalog"],
): asserts value is ComparisonResult {
  if (!Value.Check(ComparisonResultSchema, value)) {
    throw new Error("Invalid ComparisonEnvelope: schema validation failed.");
  }
  const record = value;
  if (record.reportPath !== "report.html") {
    throw new Error("Invalid ComparisonEnvelope: schema validation failed.");
  }
  const available = getEvidenceCatalog
    ? new Set(shortRefsOf(getEvidenceCatalog().links))
    : comparisonEvidenceAllowlist(context);
  const unknown = validateComparisonEvidence(record, available);
  if (unknown) {
    throw new Error(`Invalid ComparisonEnvelope: ${unknown}`);
  }
}

function shortRefsOf(items: readonly { shortRef?: string }[]): string[] { return items.flatMap((item) => (item.shortRef ? [item.shortRef] : [])); }
