import { t, type Locale, type MessageKey } from './i18n.js';
import type { Theme } from './theme.js';

/** Operator-facing labels for stable timeline titles. Fold/merge keep the raw title; paint localizes here. */
const TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  working: 'activityWorking',
  阅读: 'activityReading',
  检查: 'activityChecking',
  写入: 'activityWriting',
  运行: 'activityRunning',
  写入失败: 'toolWriteFailed',
  工具失败: 'toolFailed',
  对照完成: 'comparisonDone',
  对照失败: 'comparisonFailedWord',
  对照已取消: 'comparisonCancelled',
  证据不足: 'comparisonInsufficient',
};

const DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  路径不在可写范围: 'detailWriteDenied',
  '不是 Git 仓库': 'detailNotGitRepo',
};

const PATH_FORMAT = /Path must be|must use|relative path|\.\./i;

export type AttentionTone = 'ok' | 'warn' | 'danger' | 'neutral';

export function displayOperatorTitle(title: string, locale: Locale): string {
  const stripped = title.replace(/^Candidate · /, '');
  const key = TITLE_KEYS[stripped];
  if (key) return t(locale, key);
  return title;
}

export function displayOperatorDetail(detail: string | undefined, locale: Locale): string | undefined {
  if (!detail) return undefined;
  const key = DETAIL_KEYS[detail];
  if (key) return t(locale, key);
  if (PATH_FORMAT.test(detail)) return t(locale, 'pathFormatError');
  return detail;
}

export function displayLiveCaption(entryTitle: string, entryDetail: string | undefined, locale: Locale): string {
  const title = displayOperatorTitle(entryTitle, locale);
  const detail = displayOperatorDetail(entryDetail, locale);
  if (TITLE_KEYS[entryTitle.replace(/^Candidate · /, '')] === 'activityWorking') return title;
  return detail ? `${title} ${detail}` : title;
}

export function displayTaskStatus(status: string, locale: Locale): string {
  if (status === 'apparently_completed') return t(locale, 'taskApparentlyCompleted');
  if (status === 'incomplete') return t(locale, 'taskIncomplete');
  if (status === 'indeterminate') return t(locale, 'taskIndeterminate');
  if (status === 'not_assessed') return t(locale, 'taskNotAssessed');
  return status;
}

export function displayTerminationKind(kind: string, locale: Locale): string {
  if (kind === 'completed') return t(locale, 'terminationCompleted');
  if (kind === 'cancelled') return t(locale, 'terminationCancelled');
  if (kind === 'failed') return t(locale, 'terminationFailed');
  if (kind === 'blocked') return t(locale, 'terminationBlocked');
  if (kind === 'stalled') return t(locale, 'terminationStalled');
  if (kind === 'limit_reached') return t(locale, 'terminationLimitReached');
  if (kind === 'uncertain') return t(locale, 'terminationUncertain');
  return kind;
}

export function displayCleanupStatus(status: string, locale: Locale): string {
  if (status === 'complete') return t(locale, 'cleanupComplete');
  if (status === 'incomplete') return t(locale, 'cleanupIncomplete');
  if (status === 'not_needed') return t(locale, 'cleanupNotNeeded');
  if (status === 'unknown') return t(locale, 'cleanupUnknown');
  return status;
}

export function terminationTone(kind: string): AttentionTone {
  if (kind === 'completed') return 'ok';
  if (kind === 'cancelled' || kind === 'blocked' || kind === 'stalled' || kind === 'limit_reached' || kind === 'uncertain') {
    return 'warn';
  }
  if (kind === 'failed') return 'danger';
  return 'neutral';
}

export function comparisonPresentation(
  comparison: { readonly status: string; readonly failure?: { readonly kind?: string; readonly code?: string }; readonly value?: { readonly status?: string } },
  locale: Locale,
): { readonly word: string; readonly diagnostic: string; readonly tone: AttentionTone; readonly failedArtifact: boolean } {
  if (comparison.status === 'skipped') {
    return { word: t(locale, 'comparisonSkipped'), diagnostic: t(locale, 'resultDiagnostic'), tone: 'neutral', failedArtifact: false };
  }
  if (comparison.status === 'cancelled') {
    return {
      word: t(locale, 'comparisonCancelled'),
      diagnostic: t(locale, 'comparisonDiagnosticCancelled'),
      tone: 'warn',
      failedArtifact: true,
    };
  }
  if (comparison.status === 'failed') {
    const code = comparison.failure?.kind ?? comparison.failure?.code;
    return {
      word: code ? `${t(locale, 'comparisonFailedWord')} (${code})` : t(locale, 'comparisonFailedWord'),
      diagnostic: t(locale, 'comparisonDiagnosticFailed'),
      tone: 'danger',
      failedArtifact: true,
    };
  }
  if (comparison.status === 'completed' && comparison.value?.status === 'insufficient_evidence') {
    return {
      word: t(locale, 'comparisonInsufficient'),
      diagnostic: t(locale, 'comparisonDiagnosticInsufficient'),
      tone: 'warn',
      failedArtifact: false,
    };
  }
  if (comparison.status === 'completed') {
    return {
      word: t(locale, 'comparisonDone'),
      diagnostic: t(locale, 'resultReport'),
      tone: 'ok',
      failedArtifact: false,
    };
  }
  return {
    word: t(locale, 'comparisonDiagnosticUnknown'),
    diagnostic: t(locale, 'comparisonDiagnosticUnknown'),
    tone: 'warn',
    failedArtifact: true,
  };
}

/** When color is off, keep severity readable via a textual marker next to the glyph. */
export function severityLabel(level: 'warning' | 'error' | undefined, locale: Locale, theme: Theme): string | undefined {
  if (!level) return undefined;
  if (theme.colorMode !== 'off') return undefined;
  return level === 'error' ? t(locale, 'severityError') : t(locale, 'severityWarning');
}

export function resultHeaderStatus(
  result: {
    readonly record: { readonly outcome: { readonly termination: { readonly kind: string } } };
    readonly comparison: { readonly result: { readonly status: string; readonly value?: { readonly status?: string } } };
  },
  locale: Locale,
): { readonly label: string; readonly tone: 'ok' | 'warn' | 'off' } {
  const kind = result.record.outcome.termination.kind;
  const cmp = result.comparison.result;
  if (kind === 'cancelled') return { label: t(locale, 'terminationCancelled'), tone: 'warn' };
  if (kind === 'failed') return { label: t(locale, 'terminationFailed'), tone: 'warn' };
  if (kind === 'blocked' || kind === 'stalled' || kind === 'uncertain' || kind === 'limit_reached') {
    return { label: displayTerminationKind(kind, locale), tone: 'warn' };
  }
  if (cmp.status === 'cancelled') return { label: t(locale, 'comparisonCancelled'), tone: 'warn' };
  if (cmp.status === 'failed') return { label: t(locale, 'comparisonFailedWord'), tone: 'warn' };
  if (cmp.status === 'completed' && cmp.value?.status === 'insufficient_evidence') {
    return { label: t(locale, 'comparisonInsufficient'), tone: 'warn' };
  }
  if (cmp.status === 'skipped') return { label: t(locale, 'candidateEnded'), tone: 'ok' };
  return { label: t(locale, 'candidateEnded'), tone: 'ok' };
}
