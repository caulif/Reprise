import { t, type Locale, type MessageKey } from './i18n.js';
import type { Theme } from './theme.js';

const TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  working: 'activityWorking',
  '阅读': 'activityReading',
  '检查': 'activityChecking',
  '写入': 'activityWriting',
  '运行': 'activityRunning',
  '写入失败': 'toolWriteFailed',
  '工具失败': 'toolFailed',
  '对照完成': 'comparisonDone',
  '对照失败': 'comparisonFailedWord',
  '对照已取消': 'comparisonCancelled',
  '证据不足': 'comparisonInsufficient',
};

const DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  '路径不在可写范围': 'detailWriteDenied',
  '不是 Git 仓库': 'detailNotGitRepo',
};

const PATH_FORMAT = /Path must be|must use|relative path|\.\./i;

export type AttentionTone = 'ok' | 'warn' | 'danger' | 'neutral';

export function displayOperatorTitle(title: string, locale: Locale): string {
  const key = TITLE_KEYS[title.replace(/^Candidate · /, '')];
  return key ? t(locale, key) : title;
}

export function displayOperatorDetail(detail: string | undefined, locale: Locale): string | undefined {
  if (!detail) return undefined;
  const key = DETAIL_KEYS[detail];
  if (key) return t(locale, key);
  return PATH_FORMAT.test(detail) ? t(locale, 'pathFormatError') : detail;
}

export function displayLiveCaption(title: string, detail: string | undefined, locale: Locale): string {
  const displayTitle = displayOperatorTitle(title, locale);
  if (title.replace(/^Candidate · /, '') === 'working') return displayTitle;
  const displayDetail = displayOperatorDetail(detail, locale);
  return displayDetail ? `${displayTitle} ${displayDetail}` : displayTitle;
}

export function displayTaskStatus(status: string, locale: Locale): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    apparently_completed: 'taskApparentlyCompleted',
    incomplete: 'taskIncomplete',
    indeterminate: 'taskIndeterminate',
    not_assessed: 'taskNotAssessed',
  };
  const key = keys[status];
  return key ? t(locale, key) : status;
}

export function displayTerminationKind(kind: string, locale: Locale): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    completed: 'terminationCompleted', cancelled: 'terminationCancelled', failed: 'terminationFailed',
    blocked: 'terminationBlocked', stalled: 'terminationStalled', limit_reached: 'terminationLimitReached',
    uncertain: 'terminationUncertain',
  };
  const key = keys[kind];
  return key ? t(locale, key) : kind;
}

export function displayCleanupStatus(status: string, locale: Locale): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    complete: 'cleanupComplete', incomplete: 'cleanupIncomplete', not_needed: 'cleanupNotNeeded', unknown: 'cleanupUnknown',
  };
  const key = keys[status];
  return key ? t(locale, key) : status;
}

export function terminationTone(kind: string): AttentionTone {
  if (kind === 'completed') return 'ok';
  if (kind === 'failed') return 'danger';
  if (kind === 'cancelled' || kind === 'blocked' || kind === 'stalled' || kind === 'limit_reached' || kind === 'uncertain') return 'warn';
  return 'neutral';
}

export function comparisonPresentation(
  comparison: { readonly status: string; readonly failure?: { readonly kind?: string; readonly code?: string }; readonly value?: { readonly status?: string } },
  locale: Locale,
): { readonly word: string; readonly diagnostic: string; readonly tone: AttentionTone; readonly failedArtifact: boolean } {
  if (comparison.status === 'skipped') return { word: t(locale, 'comparisonSkipped'), diagnostic: t(locale, 'resultDiagnostic'), tone: 'neutral', failedArtifact: false };
  if (comparison.status === 'cancelled') return { word: t(locale, 'comparisonCancelled'), diagnostic: t(locale, 'comparisonDiagnosticCancelled'), tone: 'warn', failedArtifact: true };
  if (comparison.status === 'failed') {
    const code = comparison.failure?.kind ?? comparison.failure?.code;
    return { word: code ? `${t(locale, 'comparisonFailedWord')} (${code})` : t(locale, 'comparisonFailedWord'), diagnostic: t(locale, 'comparisonDiagnosticFailed'), tone: 'danger', failedArtifact: true };
  }
  if (comparison.status === 'completed' && comparison.value?.status === 'insufficient_evidence') return { word: t(locale, 'comparisonInsufficient'), diagnostic: t(locale, 'comparisonDiagnosticInsufficient'), tone: 'warn', failedArtifact: false };
  if (comparison.status === 'completed') return { word: t(locale, 'comparisonDone'), diagnostic: t(locale, 'resultReport'), tone: 'ok', failedArtifact: false };
  return { word: t(locale, 'comparisonDiagnosticUnknown'), diagnostic: t(locale, 'comparisonDiagnosticUnknown'), tone: 'warn', failedArtifact: true };
}

export function severityLabel(level: 'warning' | 'error' | undefined, locale: Locale, theme: Theme): string | undefined {
  if (!level || theme.colorMode !== 'off') return undefined;
  return level === 'error' ? t(locale, 'severityError') : t(locale, 'severityWarning');
}

export function resultHeaderStatus(result: { readonly record: { readonly outcome: { readonly termination: { readonly kind: string } } }; readonly comparison: { readonly result: { readonly status: string; readonly value?: { readonly status?: string } } } }, locale: Locale): { readonly label: string; readonly tone: 'ok' | 'warn' | 'off' } {
  const kind = result.record.outcome.termination.kind;
  const cmp = result.comparison.result;
  if (kind !== 'completed') return { label: displayTerminationKind(kind, locale), tone: 'warn' };
  if (cmp.status === 'cancelled') return { label: t(locale, 'comparisonCancelled'), tone: 'warn' };
  if (cmp.status === 'failed') return { label: t(locale, 'comparisonFailedWord'), tone: 'warn' };
  if (cmp.status === 'completed' && cmp.value?.status === 'insufficient_evidence') return { label: t(locale, 'comparisonInsufficient'), tone: 'warn' };
  if (cmp.status === 'skipped') return { label: t(locale, 'candidateEnded'), tone: 'ok' };
  return { label: t(locale, 'candidateEnded'), tone: 'ok' };
}
