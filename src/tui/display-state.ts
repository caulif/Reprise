import type { ExperimentResult } from '../application/experiment.js';
import type { RunOutcome } from '../core/schema.js';
import { t, type Locale, type MessageKey } from './i18n.js';

/** Minimal read-only facts for result presentation; avoids copying business enums. */
export type ResultPresentationInput = {
  readonly task: Pick<RunOutcome['task'], 'status'>;
  readonly termination: Pick<RunOutcome['termination'], 'kind' | 'code'>;
  readonly cleanup?: Pick<RunOutcome['cleanup'], 'status'> | undefined;
  readonly comparison: ExperimentResult['comparison']['result'];
  readonly comparePending?: boolean;
};

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
  readonly cleanupLabel: string;
  readonly comparisonLabel: string;
  readonly comparisonKind: ComparisonPresentationKind;
  readonly messageKey: MessageKey;
  readonly reportKind: ReportArtifactKind;
  readonly terminationTone: ResultTone;
};

export function resultPresentationInputFrom(
  result: ExperimentResult,
  comparePending = false,
): ResultPresentationInput {
  const outcome = result.record.outcome;
  return {
    task: { status: outcome.task.status },
    termination: { kind: outcome.termination.kind, code: outcome.termination.code },
    ...(outcome.cleanup ? { cleanup: { status: outcome.cleanup.status } } : {}),
    comparison: result.comparison.result,
    ...(comparePending ? { comparePending: true } : {}),
  };
}

export function deriveResultPresentationFromResult(
  result: ExperimentResult,
  locale: Locale,
  comparePending = false,
): ResultPresentation {
  return deriveResultPresentation(resultPresentationInputFrom(result, comparePending), locale);
}

export function deriveResultPresentation(input: ResultPresentationInput, locale: Locale): ResultPresentation {
  const comparisonKind = classifyComparison(input.comparison, input.comparePending === true);
  const terminationTone = terminationToneOf(input.termination.kind);
  const reportKind = reportKindOf(comparisonKind);
  const status = composeStatus(input.termination.kind, comparisonKind, terminationTone);
  return {
    titleKey: 'resultTitle',
    statusLabelKey: status.labelKey,
    statusTone: status.tone,
    taskLabel: taskLabelOf(input.task.status, locale),
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

export function classifyComparison(
  comparison: ExperimentResult['comparison']['result'],
  comparePending = false,
): ComparisonPresentationKind {
  if (comparePending) return 'pending';
  if (comparison.status === 'completed') {
    const valueStatus = 'value' in comparison && comparison.value ? comparison.value.status : undefined;
    return classifyComparisonStatus(comparison.status, valueStatus);
  }
  return classifyComparisonStatus(comparison.status);
}

export function comparisonKindTitleKey(kind: ComparisonPresentationKind): MessageKey {
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

function terminationToneOf(kind: RunOutcome['termination']['kind']): ResultTone {
  if (kind === 'completed') return 'ok';
  if (kind === 'failed') return 'danger';
  if (kind === 'cancelled' || kind === 'blocked' || kind === 'limit_reached' || kind === 'stalled' || kind === 'uncertain') {
    return 'warn';
  }
  return 'neutral';
}

function composeStatus(
  termination: RunOutcome['termination']['kind'],
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

function statusKeyForTermination(kind: RunOutcome['termination']['kind']): MessageKey {
  if (kind === 'completed') return 'resultStatusCandidateEnded';
  if (kind === 'failed') return 'resultStatusCandidateFailed';
  if (kind === 'cancelled') return 'resultStatusCandidateCancelled';
  if (kind === 'blocked') return 'resultStatusCandidateBlocked';
  if (kind === 'stalled') return 'resultStatusCandidateStalled';
  if (kind === 'uncertain') return 'resultStatusCandidateUncertain';
  if (kind === 'limit_reached') return 'resultStatusCandidateLimit';
  return 'resultStatusCandidateOther';
}

function messageKeyOf(
  termination: RunOutcome['termination']['kind'],
  comparison: ComparisonPresentationKind,
): MessageKey {
  if (comparison === 'cancelled') return 'resultCompareCancelled';
  if (comparison === 'failed') return 'resultCompareFailed';
  if (comparison === 'insufficient_evidence') return 'resultCompareInsufficient';
  if (comparison === 'unknown') return 'resultCompareUnknown';
  if (comparison === 'skipped' || comparison === 'pending') return 'resultSkipped';
  if (termination === 'blocked') return 'resultBlocked';
  if (termination === 'failed') return 'resultFailed';
  if (termination === 'cancelled') return 'resultCancelled';
  if (termination === 'completed') return 'resultCompleted';
  return 'resultOther';
}

function taskLabelOf(status: RunOutcome['task']['status'], locale: Locale): string {
  if (status === 'apparently_completed') return t(locale, 'taskApparentlyCompleted');
  if (status === 'incomplete') return t(locale, 'taskIncomplete');
  if (status === 'indeterminate') return t(locale, 'taskIndeterminate');
  if (status === 'not_assessed') return t(locale, 'taskNotAssessed');
  return status;
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
  comparison: ExperimentResult['comparison']['result'],
  locale: Locale,
): string {
  if (kind === 'failed') {
    const failure = comparison.status === 'failed' ? comparison.failure : undefined;
    const detail = failure?.kind ?? failure?.code;
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
