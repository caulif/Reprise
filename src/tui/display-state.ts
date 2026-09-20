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
  readonly terminationLabel: string;
  readonly cleanupLabel: string;
  readonly comparisonLabel: string;
  readonly comparisonKind: ComparisonPresentationKind;
  readonly messageKey: MessageKey;
  readonly reportKind: ReportArtifactKind;
  readonly terminationTone: ResultTone;
  readonly cleanupTone: ResultTone;
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
  const cleanupTone = cleanupToneOf(input.cleanup?.status);
  const reportKind = reportKindOf(comparisonKind);
  const status = composeStatus(input.termination.kind, comparisonKind, terminationTone);
  return {
    titleKey: 'resultTitle',
    statusLabelKey: status.labelKey,
    statusTone: status.tone,
    taskLabel: taskLabelOf(input.task.status, locale),
    terminationLabel: terminationLabelOf(input.termination.kind, locale),
    cleanupLabel: cleanupLabelOf(input.cleanup?.status, locale),
    comparisonLabel: comparisonLabelOf(comparisonKind, input.comparison, locale),
    comparisonKind,
    messageKey: messageKeyOf(input.termination.kind, comparisonKind),
    reportKind,
    terminationTone,
    cleanupTone,
  };
}

export function classifyComparison(
  comparison: ExperimentResult['comparison']['result'],
  comparePending = false,
): ComparisonPresentationKind {
  if (comparePending) return 'pending';
  const status = comparison.status;
  if (status === 'skipped') return 'skipped';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'completed') {
    if (!('value' in comparison) || !comparison.value) return 'unknown';
    if (comparison.value.status === 'insufficient_evidence') return 'insufficient_evidence';
    if (comparison.value.status === 'completed') return 'completed';
    return 'unknown';
  }
  return 'unknown';
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

function cleanupToneOf(status: RunOutcome['cleanup']['status'] | undefined): ResultTone {
  if (status === 'incomplete' || status === 'unknown') return 'warn';
  if (status === 'complete' || status === 'not_needed') return 'ok';
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
    return { labelKey: statusKeyForTermination(termination, true), tone: terminationTone === 'ok' ? 'ok' : terminationTone };
  }
  if (comparison === 'completed') {
    if (terminationTone === 'ok') return { labelKey: 'resultStatusCompareDone', tone: 'ok' };
    return { labelKey: statusKeyForTermination(termination, false), tone: terminationTone };
  }
  return { labelKey: statusKeyForTermination(termination, false), tone: terminationTone };
}

function statusKeyForTermination(kind: RunOutcome['termination']['kind'], awaitingCompare: boolean): MessageKey {
  if (awaitingCompare) {
    if (kind === 'completed') return 'resultStatusCandidateEnded';
    if (kind === 'failed') return 'resultStatusCandidateFailed';
    if (kind === 'cancelled') return 'resultStatusCandidateCancelled';
    if (kind === 'blocked') return 'resultStatusCandidateBlocked';
    if (kind === 'stalled') return 'resultStatusCandidateStalled';
    if (kind === 'uncertain') return 'resultStatusCandidateUncertain';
    if (kind === 'limit_reached') return 'resultStatusCandidateLimit';
    return 'resultStatusCandidateOther';
  }
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

function terminationLabelOf(kind: RunOutcome['termination']['kind'], locale: Locale): string {
  if (kind === 'completed') return t(locale, 'terminationCompleted');
  if (kind === 'failed') return t(locale, 'terminationFailed');
  if (kind === 'cancelled') return t(locale, 'terminationCancelled');
  if (kind === 'blocked') return t(locale, 'terminationBlocked');
  if (kind === 'stalled') return t(locale, 'terminationStalled');
  if (kind === 'uncertain') return t(locale, 'terminationUncertain');
  if (kind === 'limit_reached') return t(locale, 'terminationLimitReached');
  return kind;
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
  if (kind === 'skipped' || kind === 'pending') return t(locale, 'comparisonSkipped');
  if (kind === 'cancelled') return t(locale, 'comparisonCancelled');
  if (kind === 'failed') {
    const failure = comparison.status === 'failed' ? comparison.failure : undefined;
    const detail = failure?.kind ?? failure?.code;
    return detail
      ? `${t(locale, 'comparisonFailedWord')} (${detail})`
      : t(locale, 'comparisonFailedWord');
  }
  if (kind === 'insufficient_evidence') return t(locale, 'comparisonInsufficient');
  if (kind === 'completed') return t(locale, 'comparisonDone');
  return t(locale, 'comparisonUnknown');
}

function worseTone(left: ResultTone, right: ResultTone): ResultTone {
  const rank: Record<ResultTone, number> = { ok: 0, neutral: 1, warn: 2, danger: 3 };
  return rank[left] >= rank[right] ? left : right;
}
