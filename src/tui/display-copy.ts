import { t, type Locale, type MessageKey } from './i18n.js';
import type { Theme } from './theme.js';

/**
 * Stable deliver / activity identity → message key.
 * Fold/merge/classify keep the raw identity; paint localizes here.
 */
const TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  working: 'activityWorking',
  阅读: 'activityReading',
  检查: 'activityChecking',
  写入: 'activityWriting',
  运行: 'activityRunning',
  写入失败: 'toolWriteFailed',
  工具失败: 'toolFailed',
  'comparison.completed': 'comparisonDone',
  'comparison.failed': 'comparisonFailedWord',
  'comparison.cancelled': 'comparisonCancelled',
  'comparison.insufficient': 'comparisonInsufficient',
  'comparison.unknown': 'comparisonUnknown',
};

const DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  路径不在可写范围: 'detailWriteDenied',
  '不是 Git 仓库': 'detailNotGitRepo',
};

const PATH_FORMAT = /Path must be|must use|relative path|\.\./i;

const COMPARISON_DELIVER = new Set([
  'comparison.completed',
  'comparison.failed',
  'comparison.cancelled',
  'comparison.insufficient',
  'comparison.unknown',
]);

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

/** When color is off, keep severity readable via a textual marker next to the glyph. */
export function severityLabel(level: 'warning' | 'error' | undefined, locale: Locale, theme: Theme): string | undefined {
  if (!level) return undefined;
  if (theme.colorMode !== 'off') return undefined;
  return level === 'error' ? t(locale, 'severityError') : t(locale, 'severityWarning');
}

export function isComparisonDeliverTitle(title: string): boolean {
  return COMPARISON_DELIVER.has(title);
}

export function isDeliverHeadlineTitle(title: string): boolean {
  return title.startsWith('DONE ·')
    || title === '已恢复'
    || title === '部分恢复'
    || title === '无法恢复'
    || isComparisonDeliverTitle(title);
}

/** Paint tone for deliver headlines; identity is the stable title token, not localized copy. */
export function deliverTitleTone(title: string): 'ok' | 'warn' | 'danger' {
  if (title === '无法恢复' || title === 'comparison.failed') return 'danger';
  if (title === 'comparison.cancelled' || title === 'comparison.insufficient' || title === 'comparison.unknown') {
    return 'warn';
  }
  return 'ok';
}
