import { compact, formatBytes, missing, hitFileLink } from '../format.js';
import { t, type Locale } from '../i18n.js';
import type { HistoryCase, HistoryExperiment } from '../local-history.js';
import { deriveResultPresentationFromHistory, type ResultPresentation } from '../display-state.js';
import { localPathFromFileUrl } from '../open-report.js';
import type { Theme } from '../theme.js';
import { kv, kvBlock, kvLinkBlock, panel, panelWithHits, type LinkValueHit } from '../widgets.js';
import { relativeTime } from './intake.js';

export type HistoryModel = {
  readonly totalBytes: number;
  readonly invalidCaseCount?: number;
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
  const label = model.tab === 'runs' ? t(locale, 'historyRuns') : t(locale, 'historyCases');
  const diagnosis = model.tab === 'cases' && model.invalidCaseCount
    ? [` ${theme.glyphs.warn} ${t(locale, 'historyInvalidCaseCount', { count: model.invalidCaseCount })}`]
    : [];
  if (!model.items.length) return panel(theme, label, [...diagnosis, ` ${model.tab === 'runs' ? t(locale, 'noLocalRuns') : t(locale, 'noLocalCases')}`], width);
  const range = visibleRange(model.items, model.selected, height === undefined ? 8 : Math.max(1, Math.floor((height - 4) / 2)));
  const rows = model.items.slice(range.start, range.end).flatMap((item, index) => {
    const selected = range.start + index === model.selected;
    const marker = selected ? theme.glyphs.cursor : ' ';
    const title = 'taskCase' in item ? item.taskCase.initialInput.text : item.taskTitle ?? t(locale, 'recentTaskUnknown', { id: item.taskCaseId.slice(0, 8) });
    const status = 'taskCase' in item ? '' : t(locale, deriveResultPresentationFromHistory(item, locale).statusLabelKey);
    const when = 'taskCase' in item ? item.taskCase.provenance.importedAt : item.startedAt;
    const line = ` ${marker} ${compact(title.replace(/\s+/g, ' ').trim(), Math.max(20, width - 25), theme.glyphs.ellipsis)}`;
    const meta = `     ${relativeTime(when, Date.now(), locale)}${status ? ` ${theme.glyphs.sep} ${status}` : ''}${'taskCase' in item || !item.candidateProductId ? '' : ` ${theme.glyphs.sep} ${item.candidateProductId}${item.candidateModel ? ` · ${item.candidateModel}` : ''}`}`;
    return selected ? [theme.style.selected(line), theme.style.selected(meta)] : [line, theme.style.muted(meta)];
  });
  return panel(theme, theme.style.harness(label), [...diagnosis, ...rows, theme.style.muted(` ${model.selected + 1}/${model.items.length}`)], width);
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
    for (const line of kvBlock(theme, t(locale, 'taskLabel'), item.taskCase.initialInput.text, width)) push(line);
    push(kv(theme, t(locale, 'historySource'), item.taskCase.source.productId, width - 2));
    push(kv(theme, t(locale, 'historySavedAt'), item.taskCase.provenance.importedAt, width - 2));
    push('');
    push(theme.style.muted(` ${t(locale, 'historyTechnical')}`));
    push(kv(theme, t(locale, 'historyTaskId'), item.taskCase.caseId, width - 2));
    push(kv(theme, t(locale, 'historySource'), item.taskCase.source.sessionId, width - 2));
    pushLink(kvLinkBlock(theme, t(locale, 'historyLocation'), item.path, item.path, width), item.path);
    return panelWithHits(theme, t(locale, 'historyCaseTitle'), body, width, bodyHits);
  }
  const presentation = deriveResultPresentationFromHistory(item, locale);
  for (const line of kvBlock(theme, t(locale, 'taskLabel'), item.taskTitle ?? t(locale, 'recentTaskUnknown', { id: item.taskCaseId.slice(0, 8) }), width)) push(line);
  push(kv(theme, t(locale, 'statusLabel'), t(locale, presentation.statusLabelKey), width - 2));
  if (item.candidateProductId) push(kv(theme, t(locale, 'candidateLabel'), `${item.candidateProductId}${item.candidateModel ? ` · ${item.candidateModel}` : ''}`, width - 2));
  if (item.startedAt) push(kv(theme, t(locale, 'historyStartedAt'), item.startedAt, width - 2));
  push(kv(theme, t(locale, 'resultTask'), presentation.taskLabel, width - 2));
  push(kv(theme, t(locale, 'resultTermination'), item.outcome === 'interrupted' ? t(locale, 'historyInterrupted') : presentation.terminationLabel, width - 2));
  push(kv(theme, t(locale, 'resultCleanup'), presentation.cleanupLabel, width - 2));
  push(kv(theme, t(locale, 'resultComparison'), presentation.comparisonLabel, width - 2));
  if (item.incompleteModelInput) {
    for (const line of kvBlock(theme, t(locale, 'modelInputLabel'), t(locale, 'incompleteModelInput'), width)) push(line);
  }
  if (item.formatError) {
    const key = item.formatError === 'missing_metadata' ? 'historyMissingMetadata'
      : item.formatError === 'invalid_metadata' ? 'historyInvalidMetadata'
        : item.formatError === 'unreadable_record' ? 'historyUnreadableRecord' : 'unsupportedSchema';
    push(kv(theme, t(locale, 'historyFormat'), t(locale, key), width - 2));
  }
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
  push('');
  push(theme.style.muted(` ${t(locale, 'historyTechnical')}`));
  push(kv(theme, t(locale, 'historyRecordId'), item.experimentId, width - 2));
  push(kv(theme, t(locale, 'historyTaskId'), item.taskCaseId, width - 2));
  push(kv(theme, t(locale, 'historyRunId'), missing(item.runId), width - 2));
  push(kv(theme, t(locale, 'historyStoredSize'), formatBytes(item.sizeBytes), width - 2));
  pushLink(kvLinkBlock(theme, t(locale, 'historyLocation'), item.path, item.path, width), item.path);
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
function resolveHistoryHtmlPath(item: HistoryExperiment, clicked: string): string {
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
