import { compact, formatBytes, missing } from '../format.js';
import { t, type Locale } from '../i18n.js';
import type { HistoryCase, HistoryExperiment } from '../local-history.js';
import { showsDetailPane, type Theme } from '../theme.js';
import { joinColumns, kv, kvBlock, kvLinkBlock, panel } from '../widgets.js';

export type HistoryModel = {
  readonly totalBytes: number;
  readonly tab: 'runs' | 'cases';
  readonly items: readonly (HistoryCase | HistoryExperiment)[];
  readonly selected: number;
  readonly locale?: Locale;
  readonly detail?: HistoryCase | HistoryExperiment;
};

export function renderHistory(theme: Theme, width: number, model: HistoryModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const label = `${model.tab === 'runs' ? t(locale, 'historyRuns') : t(locale, 'historyCases')} · ${t(locale, 'historyStorage')} ${formatBytes(model.totalBytes)}`;
  if (!model.items.length) return panel(theme, label, [` ${model.tab === 'runs' ? t(locale, 'noLocalRuns') : t(locale, 'noLocalCases')}`], width);
  const range = visibleRange(model.items, model.selected, height === undefined ? 8 : Math.max(1, Math.floor((height - 4) / 2)));
  const rows = model.items.slice(range.start, range.end).flatMap((item, index) => {
    const selected = range.start + index === model.selected;
    const marker = selected ? theme.glyphs.cursor : ' ';
    const line = 'taskCase' in item
      ? ` ${marker} ${item.taskCase.caseId} ${theme.glyphs.sep} ${compact(item.taskCase.initialInput.text, 62, theme.glyphs.ellipsis)}`
      : ` ${marker} ${item.experimentId} ${theme.glyphs.sep} ${item.outcome ?? t(locale, 'incomplete')}`;
    const meta = 'taskCase' in item
      ? `     ${t(locale, 'imported')} ${item.taskCase.provenance.importedAt}`
      : `     ${t(locale, 'historyCaseTitle')} ${item.taskCaseId} ${theme.glyphs.sep} ${item.startedAt ?? t(locale, 'timeUnavailable')} ${theme.glyphs.sep} ${formatBytes(item.sizeBytes)}`;
    return selected
      ? [theme.style.selected(line), theme.style.selected(meta)]
      : [line, theme.style.muted(meta)];
  });
  const previewWidth = model.detail && showsDetailPane(theme) ? Math.max(28, Math.floor(width * 0.42)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const list = panel(theme, theme.style.harness(label), [...rows, theme.style.muted(` ${model.selected + 1}/${model.items.length}`)], listWidth);
  if (!model.detail || !previewWidth) return list;
  const right = renderHistoryDetail(theme, previewWidth, model.detail, locale);
  return joinColumns(list, right, listWidth, previewWidth, 1, theme);
}

export function renderHistoryDetail(theme: Theme, width: number, item: HistoryCase | HistoryExperiment, locale: Locale = 'en'): string[] {
  if ('taskCase' in item) {
    return panel(theme, t(locale, 'historyCaseTitle'), [
      ` TaskCase: ${item.taskCase.caseId}`,
      ...kvBlock(theme, 'Task', item.taskCase.initialInput.text, width),
      kv(theme, 'Source', `${item.taskCase.source.productId} ${theme.glyphs.sep} ${item.taskCase.source.sessionId}`, width - 2),
      kv(theme, 'Frozen', item.taskCase.provenance.importedAt, width - 2),
      ...kvLinkBlock(theme, 'Path', item.path, item.path, width),
    ], width);
  }
  return panel(theme, t(locale, 'historyRunTitle'), [
    kv(theme, 'ID', item.experimentId, width - 2),
    kv(theme, 'TaskCase', item.taskCaseId, width - 2),
    kv(theme, 'Run', missing(item.runId), width - 2),
    kv(theme, 'Outcome', item.outcome ?? 'incomplete or no record', width - 2),
    kv(theme, 'Started', item.startedAt ?? 'unavailable', width - 2),
    ...kvLinkBlock(theme, 'Report', item.reportPath ?? 'not generated', item.reportPath, width),
    kv(theme, 'Stored', formatBytes(item.sizeBytes), width - 2),
    ...kvLinkBlock(theme, 'Path', item.path, item.path, width),
  ], width);
}

export function historyHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Tab', t(locale, 'hintRunsCases')], ['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintDetail')], ['Esc', t(locale, 'hintHome')]];
}

export function historyDetailHints(isCase: boolean, hasReport = false, locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return isCase
    ? [['Enter', t(locale, 'hintUseCase')], ['t', t(locale, 'hintOpenPath')], ['Esc', t(locale, 'hintBack')]]
    : [...(hasReport ? [['o', t(locale, 'hintReport')]] as const : []), ['t', t(locale, 'hintOpenPath')], ['Esc', t(locale, 'hintBack')]];
}



function visibleRange<T>(items: readonly T[], selected: number, limit = 8): { start: number; end: number } {
  if (items.length <= limit) return { start: 0, end: items.length };
  const start = Math.max(0, Math.min(items.length - limit, selected - Math.floor(limit / 2)));
  return { start, end: start + limit };
}
