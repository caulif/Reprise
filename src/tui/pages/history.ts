import { compact, formatBytes, missing, hitFileLink } from '../format.js';
import { t, type Locale } from '../i18n.js';
import type { HistoryCase, HistoryExperiment } from '../local-history.js';
import { deriveResultPresentationFromHistory, type ResultPresentation } from '../display-state.js';
import { localPathFromFileUrl } from '../open-report.js';
import { showsDetailPane, type Theme } from '../theme.js';
import { joinColumns, kv, kvBlock, kvLinkBlock, panel, panelWithHits, type LinkValueHit } from '../widgets.js';

export type HistoryModel = {
  readonly totalBytes: number;
  readonly tab: 'runs' | 'cases';
  readonly items: readonly (HistoryCase | HistoryExperiment)[];
  readonly selected: number;
  readonly locale?: Locale;
  readonly detail?: HistoryCase | HistoryExperiment;
};

export type HistoryDetailPointerHit =
  | { readonly action: 'open-report'; readonly reportPath: string }
  | { readonly action: 'open-local' };

type HistoryDetailLinkHit = LinkValueHit & { readonly path: string };
export type HistoryDetailRender = {
  readonly lines: readonly string[];
  readonly rowHits: ReadonlyMap<number, readonly HistoryDetailLinkHit[]>;
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
  return [...renderHistoryDetailWithHits(theme, width, item, locale).lines];
}

export function renderHistoryDetailWithHits(
  theme: Theme,
  width: number,
  item: HistoryCase | HistoryExperiment,
  locale: Locale = 'en',
): HistoryDetailRender {
  const body: string[] = [];
  const bodyHits = new Map<number, readonly HistoryDetailLinkHit[]>();
  const push = (line: string): void => { body.push(line); };
  const pushLink = (block: ReturnType<typeof kvLinkBlock>, path: string): void => {
    for (const [index, line] of block.lines.entries()) {
      const hit = block.hits[index];
      if (hit) bodyHits.set(body.length, [{ ...hit, path }]);
      body.push(line);
    }
  };
  if ('taskCase' in item) {
    push(` TaskCase: ${item.taskCase.caseId}`);
    for (const line of kvBlock(theme, 'Task', item.taskCase.initialInput.text, width)) push(line);
    push(kv(theme, 'Source', `${item.taskCase.source.productId} ${theme.glyphs.sep} ${item.taskCase.source.sessionId}`, width - 2));
    push(kv(theme, 'Frozen', item.taskCase.provenance.importedAt, width - 2));
    pushLink(kvLinkBlock(theme, 'Path', item.path, item.path, width), item.path);
    return panelWithHits(theme, t(locale, 'historyCaseTitle'), body, width, bodyHits);
  }
  const presentation = deriveResultPresentationFromHistory(item, locale);
  push(kv(theme, 'ID', item.experimentId, width - 2));
  push(kv(theme, 'TaskCase', item.taskCaseId, width - 2));
  push(kv(theme, 'Run', missing(item.runId), width - 2));
  push(kv(theme, 'Outcome', historyOutcomeLabel(item, locale), width - 2));
  push(kv(theme, 'Started', item.startedAt ?? 'unavailable', width - 2));
  push(kv(theme, t(locale, 'resultTask'), presentation.taskLabel, width - 2));
  push(kv(theme, t(locale, 'resultTermination'), presentation.terminationLabel, width - 2));
  push(kv(theme, t(locale, 'resultCleanup'), presentation.cleanupLabel, width - 2));
  push(kv(theme, t(locale, 'resultComparison'), presentation.comparisonLabel, width - 2));
  if (item.incompleteModelInput) {
    for (const line of kvBlock(theme, t(locale, 'modelInputLabel'), t(locale, 'incompleteModelInput'), width)) push(line);
  }
  if (item.formatError) push(kv(theme, 'Format', t(locale, 'unsupportedSchema'), width - 2));
  if (item.reportAttemptUnconfirmed) {
    for (const line of kvBlock(theme, t(locale, 'resultReport'), t(locale, 'historyReportUnconfirmed'), width)) push(line);
  }
  pushLink(kvLinkBlock(
    theme,
    historyPrimaryReportLabel(item, presentation, locale),
    item.reportPath ?? t(locale, 'resultReportNotGenerated'),
    item.reportPath,
    width,
  ), item.reportPath ?? '');
  if (item.previousReportPath && item.previousReportPath !== item.reportPath) {
    pushLink(kvLinkBlock(theme, t(locale, 'historyPreviousReport'), item.previousReportPath, item.previousReportPath, width), item.previousReportPath);
  }
  push(kv(theme, 'Stored', formatBytes(item.sizeBytes), width - 2));
  pushLink(kvLinkBlock(theme, 'Path', item.path, item.path, width), item.path);
  return panelWithHits(theme, t(locale, 'historyRunTitle'), body, width, bodyHits);
}

export function historyHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Tab', t(locale, 'hintRunsCases')], ['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintDetail')], ['Esc', t(locale, 'hintHome')]];
}

export function historyDetailHints(isCase: boolean, hasReport = false, locale: Locale = 'en'): readonly (readonly [string, string])[] {
  if (isCase) {
    return [['Enter', t(locale, 'hintUseCase')], ['Esc', t(locale, 'hintBack')]];
  }
  return [
    ...(hasReport ? [['o', t(locale, 'hintOpenReport')]] as const : []),
    ['Esc', t(locale, 'hintBack')],
  ];
}

/** Resolve history detail OSC-8 hits; HTML artifacts open via openReport with the clicked path. */
export function historyDetailPointerAction(
  lines: readonly string[],
  row: number,
  col: number,
  item?: HistoryExperiment,
  rowHits?: ReadonlyMap<number, readonly HistoryDetailLinkHit[]>,
): HistoryDetailPointerHit | undefined {
  const directHit = rowHits?.get(row)?.find((hit) => col >= hit.x0 && col <= hit.x1);
  const href = directHit?.path ?? hitFileLink(lines[row] ?? '', col);
  if (!href) return undefined;
  const clicked = directHit?.path ?? hrefPath(href);
  if (!isComparisonHtml(clicked)) return { action: 'open-local' };
  const reportPath = item ? resolveHistoryHtmlPath(item, clicked) : clicked;
  return { action: 'open-report', reportPath };
}

/** Map an OSC-8 / file URL target back onto the experiment's stored HTML paths. */
export function resolveHistoryHtmlPath(item: HistoryExperiment, clicked: string): string {
  const candidates = [item.reportPath, item.previousReportPath].filter((path): path is string => Boolean(path));
  const clickedKey = pathMatchKey(clicked);
  for (const candidate of candidates) {
    if (pathMatchKey(candidate) === clickedKey) return candidate;
  }
  return clicked;
}

function historyPrimaryReportLabel(
  item: HistoryExperiment,
  presentation: ResultPresentation,
  locale: Locale,
): string {
  if (item.reportAttemptUnconfirmed) return t(locale, 'historyPreviousReport');
  if (presentation.reportKind === 'diagnostic') return t(locale, 'resultDiagnostic');
  return t(locale, 'resultReport');
}

function hrefPath(href: string): string {
  if (/^file:/i.test(href)) {
    try {
      return localPathFromFileUrl(href);
    } catch {
      return href;
    }
  }
  return href;
}

function isComparisonHtml(path: string): boolean {
  const base = pathBasename(path).toLowerCase();
  return base === 'report.html' || base === 'comparison-failure.html';
}

function pathMatchKey(path: string): string {
  return pathBasename(path).toLowerCase();
}

function pathBasename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const cut = normalized.split('/').pop() ?? normalized;
  try {
    return decodeURIComponent(cut);
  } catch {
    return cut;
  }
}

function visibleRange<T>(items: readonly T[], selected: number, limit = 8): { start: number; end: number } {
  if (items.length <= limit) return { start: 0, end: items.length };
  const start = Math.max(0, Math.min(items.length - limit, selected - Math.floor(limit / 2)));
  return { start, end: start + limit };
}

function historyOutcomeLabel(item: HistoryExperiment, locale: Locale): string {
  if (item.formatError) return t(locale, 'unsupportedSchema');
  if (item.outcome === 'interrupted') return t(locale, 'interrupted');
  if (item.outcome === 'unknown') return t(locale, 'unknownOutcome');
  return item.outcome ?? t(locale, 'incomplete');
}
