import type { ExperimentResult } from '../application/experiment.js';
import type { HistoryExperiment } from '../application/experiment-history-list.js';
import type { RunOutcome } from '../core/schema.js';
import { t, type Locale, type MessageKey } from './i18n.js';

/** Minimal read-only facts for result presentation; avoids copying business enums. */
export type ResultPresentationInput = {
  readonly task: { readonly status: RunOutcome['task']['status'] | 'unknown' };
  readonly termination: { readonly kind: PresentationTerminationKind };
  readonly cleanup?: Pick<RunOutcome['cleanup'], 'status'> | undefined;
  readonly comparison: ComparisonPresentationInput;
};

type PresentationTerminationKind = RunOutcome['termination']['kind'] | 'unknown' | 'interrupted' | 'record_unread';
type ComparisonResult = ExperimentResult['comparison']['result'];
export type ComparisonPresentationInput =
  | { readonly status: Exclude<ComparisonResult['status'], 'completed' | 'failed'> | 'unknown' | 'pending' }
  | { readonly status: 'completed'; readonly detail: Extract<ComparisonResult, { status: 'completed' }>['value']['status'] | 'unknown' }
  | { readonly status: 'failed'; readonly failureDetail?: string };

export type ResultTone = 'ok' | 'warn' | 'danger' | 'neutral';
export type ReportArtifactKind = 'report' | 'diagnostic' | 'none';

export type ComparisonPresentationKind =
  | 'skipped'
  | 'pending'
  | 'cancelled'
  | 'failed'
  | 'insufficient_evidence'
  | 'completed'
  | 'unknown';

export type ResultPresentation = {
  readonly titleKey: MessageKey;
  readonly statusLabelKey: MessageKey;
  readonly statusTone: ResultTone;
  readonly taskLabel: string;
  readonly terminationLabel: string;
  readonly cleanupLabel: string;
  readonly comparisonLabel: string;
  readonly comparisonKind: ComparisonPresentationKind;
  readonly messageKey: MessageKey;
  readonly reportKind: ReportArtifactKind;
  readonly terminationTone: ResultTone;
};

function resultPresentationInputFrom(
  result: ExperimentResult,
  comparePending = false,
): ResultPresentationInput {
  const outcome = result.record.outcome;
  return {
    task: { status: outcome.task.status },
    termination: { kind: outcome.termination.kind },
    ...(outcome.cleanup ? { cleanup: { status: outcome.cleanup.status } } : {}),
    comparison: comparePending ? { status: 'pending' } : comparisonInputFromResult(result.comparison.result),
  };
}

export function deriveResultPresentationFromResult(
  result: ExperimentResult,
  locale: Locale,
  comparePending = false,
): ResultPresentation {
  return deriveResultPresentation(resultPresentationInputFrom(result, comparePending), locale);
}

/** Map HistoryExperiment / recentExperiment facts into the same presentation input as live results. */
function resultPresentationInputFromHistory(item: HistoryExperiment): ResultPresentationInput {
  return {
    task: { status: historyTaskStatus(item.taskStatus) },
    termination: { kind: historyTerminationKind(item.outcome) },
    cleanup: { status: historyCleanupStatus(item.cleanupStatus) },
    comparison: comparisonInputFromHistory(item),
  };
}

export function deriveResultPresentationFromHistory(
  item: HistoryExperiment,
  locale: Locale,
): ResultPresentation {
  return deriveResultPresentation(resultPresentationInputFromHistory(item), locale);
}

export function deriveResultPresentation(input: ResultPresentationInput, locale: Locale): ResultPresentation {
  const comparisonKind = classifyComparison(input.comparison);
  const terminationTone = terminationToneOf(input.termination.kind);
  const reportKind = reportKindOf(comparisonKind);
  const status = composeStatus(input.termination.kind, comparisonKind, terminationTone);
  const cleanupStatus = input.cleanup?.status;
  const overallStatus = cleanupStatus === 'incomplete'
    ? { labelKey: 'resultStatusCleanupIncomplete' as const, tone: worseTone(status.tone, 'warn') }
    : cleanupStatus === 'unknown' || cleanupStatus === undefined
      ? { labelKey: 'resultStatusCleanupUnknown' as const, tone: worseTone(status.tone, 'warn') }
      : status;
  return {
    titleKey: 'resultTitle',
    statusLabelKey: overallStatus.labelKey,
    statusTone: overallStatus.tone,
    taskLabel: taskLabelOf(input.task.status, locale),
    terminationLabel: t(locale, input.termination.kind === 'interrupted' ? 'historyInterrupted' : statusKeyForTermination(input.termination.kind)),
    cleanupLabel: cleanupLabelOf(input.cleanup?.status, locale),
    comparisonLabel: comparisonLabelOf(comparisonKind, input.comparison, locale),
    comparisonKind,
    messageKey: messageKeyOf(input.termination.kind, comparisonKind),
    reportKind,
    terminationTone,
  };
}

/** Shared classifier for result pages and timeline comparison.completed payloads. */
export function classifyComparisonStatus(
  invocationStatus: string | undefined,
  valueStatus?: string,
): ComparisonPresentationKind {
  if (invocationStatus === 'skipped') return 'skipped';
  if (invocationStatus === 'cancelled') return 'cancelled';
  if (invocationStatus === 'failed') return 'failed';
  if (invocationStatus === 'completed') {
    if (valueStatus === 'insufficient_evidence') return 'insufficient_evidence';
    if (valueStatus === 'completed') return 'completed';
    return 'unknown';
  }
  return 'unknown';
}

function classifyComparison(
  comparison: ComparisonPresentationInput,
): ComparisonPresentationKind {
  if (comparison.status === 'pending') return 'pending';
  if (comparison.status === 'completed') {
    return classifyComparisonStatus(comparison.status, comparison.detail);
  }
  return classifyComparisonStatus(comparison.status);
}

function comparisonKindTitleKey(kind: ComparisonPresentationKind): MessageKey {
  if (kind === 'failed') return 'comparisonFailedWord';
  if (kind === 'cancelled') return 'comparisonCancelled';
  if (kind === 'insufficient_evidence') return 'comparisonInsufficient';
  if (kind === 'completed') return 'comparisonDone';
  if (kind === 'skipped' || kind === 'pending') return 'comparisonSkipped';
  return 'comparisonUnknown';
}

/** Timeline comparison titles stay zh-first (historical canvas); still routed through i18n keys. */
export function comparisonKindTitle(kind: ComparisonPresentationKind, locale: Locale = 'zh'): string {
  return t(locale, comparisonKindTitleKey(kind));
}

export function comparisonKindError(kind: ComparisonPresentationKind): boolean {
  return kind === 'failed' || kind === 'cancelled' || kind === 'insufficient_evidence' || kind === 'unknown';
}

function reportKindOf(kind: ComparisonPresentationKind): ReportArtifactKind {
  if (kind === 'completed') return 'report';
  if (kind === 'failed' || kind === 'cancelled' || kind === 'insufficient_evidence' || kind === 'unknown') {
    return 'diagnostic';
  }
  return 'none';
}

function terminationToneOf(kind: PresentationTerminationKind): ResultTone {
  if (kind === 'completed') return 'ok';
  if (kind === 'failed') return 'danger';
  return 'warn';
}

function composeStatus(
  termination: PresentationTerminationKind,
  comparison: ComparisonPresentationKind,
  terminationTone: ResultTone,
): { labelKey: MessageKey; tone: ResultTone } {
  if (comparison === 'cancelled') {
    return { labelKey: 'resultStatusCompareCancelled', tone: worseTone(terminationTone, 'warn') };
  }
  if (comparison === 'failed') {
    return { labelKey: 'resultStatusCompareFailed', tone: worseTone(terminationTone, 'danger') };
  }
  if (comparison === 'insufficient_evidence') {
    return { labelKey: 'resultStatusCompareInsufficient', tone: worseTone(terminationTone, 'warn') };
  }
  if (comparison === 'unknown') {
    return { labelKey: 'resultStatusCompareUnknown', tone: worseTone(terminationTone, 'warn') };
  }
  if (comparison === 'pending' || comparison === 'skipped') {
    return { labelKey: statusKeyForTermination(termination), tone: terminationTone === 'ok' ? 'ok' : terminationTone };
  }
  if (comparison === 'completed') {
    if (terminationTone === 'ok') return { labelKey: 'resultStatusCompareDone', tone: 'ok' };
    return { labelKey: statusKeyForTermination(termination), tone: terminationTone };
  }
  return { labelKey: statusKeyForTermination(termination), tone: terminationTone };
}

function statusKeyForTermination(kind: PresentationTerminationKind): MessageKey {
  if (kind === 'completed') return 'resultStatusCandidateEnded';
  if (kind === 'failed') return 'resultStatusCandidateFailed';
  if (kind === 'cancelled') return 'resultStatusCandidateCancelled';
  if (kind === 'blocked') return 'resultStatusCandidateBlocked';
  if (kind === 'stalled') return 'resultStatusCandidateStalled';
  if (kind === 'uncertain' || kind === 'unknown' || kind === 'interrupted' || kind === 'record_unread') return 'resultStatusCandidateUncertain';
  if (kind === 'limit_reached') return 'resultStatusCandidateLimit';
  return 'resultStatusCandidateOther';
}

function messageKeyOf(
  termination: PresentationTerminationKind,
  comparison: ComparisonPresentationKind,
): MessageKey {
  if (comparison === 'cancelled') return 'resultCompareCancelled';
  if (comparison === 'failed') return 'resultCompareFailed';
  if (comparison === 'insufficient_evidence') return 'resultCompareInsufficient';
  if (comparison === 'unknown') return 'resultCompareUnknown';
  // A cancelled candidate remains cancelled even when the deferred comparison
  // gate is skipped as part of the same cancellation race.
  if (termination === 'cancelled') return 'resultCancelled';
  if (comparison === 'skipped' || comparison === 'pending') return 'resultSkipped';
  if (termination === 'blocked') return 'resultBlocked';
  if (termination === 'failed') return 'resultFailed';
  if (termination === 'completed') return 'resultCompleted';
  return 'resultOther';
}

function taskLabelOf(status: ResultPresentationInput['task']['status'], locale: Locale): string {
  if (status === 'apparently_completed') return t(locale, 'taskApparentlyCompleted');
  if (status === 'incomplete') return t(locale, 'taskIncomplete');
  if (status === 'indeterminate') return t(locale, 'taskIndeterminate');
  return t(locale, 'taskNotAssessed');
}

function cleanupLabelOf(status: RunOutcome['cleanup']['status'] | undefined, locale: Locale): string {
  if (status === 'complete') return t(locale, 'cleanupComplete');
  if (status === 'not_needed') return t(locale, 'cleanupNotNeeded');
  if (status === 'incomplete') return t(locale, 'cleanupIncomplete');
  if (status === 'unknown') return t(locale, 'cleanupUnknown');
  return t(locale, 'cleanupUnknown');
}

function comparisonLabelOf(
  kind: ComparisonPresentationKind,
  comparison: ComparisonPresentationInput,
  locale: Locale,
): string {
  if (kind === 'failed') {
    const detail = comparison.status === 'failed' ? comparison.failureDetail : undefined;
    return detail
      ? `${t(locale, 'comparisonFailedWord')} (${detail})`
      : t(locale, 'comparisonFailedWord');
  }
  return t(locale, comparisonKindTitleKey(kind));
}

function worseTone(left: ResultTone, right: ResultTone): ResultTone {
  const rank: Record<ResultTone, number> = { ok: 0, neutral: 1, warn: 2, danger: 3 };
  return rank[left] >= rank[right] ? left : right;
}

const TASK_STATUSES = new Set<RunOutcome['task']['status']>([
  'apparently_completed',
  'incomplete',
  'indeterminate',
  'not_assessed',
]);

const TERMINATION_KINDS = new Set<RunOutcome['termination']['kind']>([
  'completed',
  'limit_reached',
  'stalled',
  'cancelled',
  'blocked',
  'failed',
  'uncertain',
]);

const CLEANUP_STATUSES = new Set<RunOutcome['cleanup']['status']>([
  'not_needed',
  'complete',
  'incomplete',
  'unknown',
]);

function isSetMember<T>(values: ReadonlySet<T>, value: unknown): value is T {
  return [...values].some((member) => member === value);
}

function historyTaskStatus(status: string | undefined): ResultPresentationInput['task']['status'] {
  return isSetMember(TASK_STATUSES, status) ? status : 'unknown';
}

function historyTerminationKind(outcome: string | undefined): PresentationTerminationKind {
  if (isSetMember(TERMINATION_KINDS, outcome)) return outcome;
  if (outcome === 'interrupted') return outcome;
  if (outcome === 'record unread') return 'record_unread';
  return 'unknown';
}

function historyCleanupStatus(status: string | undefined): RunOutcome['cleanup']['status'] {
  return isSetMember(CLEANUP_STATUSES, status) ? status : 'unknown';
}

function comparisonInputFromResult(comparison: ComparisonResult): ComparisonPresentationInput {
  if (comparison.status === 'completed') return { status: 'completed', detail: comparison.value?.status ?? 'unknown' };
  if (comparison.status === 'failed') return { status: 'failed', failureDetail: comparison.failure.kind ?? comparison.failure.code };
  return { status: comparison.status };
}

function comparisonInputFromHistory(item: HistoryExperiment): ComparisonPresentationInput {
  const status = item.comparisonStatus;
  if (status === 'skipped' || status === 'cancelled' || status === 'pending') return { status };
  if (status === 'failed') {
    const failureDetail = item.comparisonFailure?.trim();
    return { status: 'failed', ...(failureDetail ? { failureDetail } : {}) };
  }
  if (status === 'completed') {
    const detail = item.comparisonDetail === 'completed' || item.comparisonDetail === 'insufficient_evidence'
      ? item.comparisonDetail : 'unknown';
    return { status: 'completed', detail };
  }
  return { status: 'unknown' };
}
