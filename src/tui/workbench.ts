import { type Component, ScrollView, VStack, isViewportTUI, type TUI, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { ExperimentResult } from '../application/experiment.js';
import { artifactsFromResult, listActions, footerHintPairs, optionalMode } from './action-model.js';
import { truncateFit } from './format.js';
import { renderHelp } from './overlays.js';
import { configHints, renderConfig, type ConfigModel } from './pages/config.js';
import { visibleConfigItems } from './config-input.js';
import { historyDetailHints, historyHints, renderHistory, renderHistoryDetail, type HistoryModel } from './pages/history.js';
import { homeHints, renderHome, type HomeModel } from './pages/home.js';
import { inspectionHints, renderInspection, renderSessions, sessionsHints, type InspectionModel, type SessionsModel } from './pages/intake.js';
import { renderFailure, renderResult, failureHints, type ResultRenderOptions } from './pages/result.js';
import { renderPrepareSummary, renderRecoverySummary } from './pages/recovery-summary.js';
import { candidateModelHints, candidateProductHints, renderCandidateModelPicker, renderCandidateProductPicker, type CandidateModelPage, type CandidateProductModel } from './pages/candidate.js';
import {
  confirmCanStart, isRecoveryChrome, preflightHints, renderConfirmation, renderPreflight, renderSource, renderTimeline,
  sourceHints,
  type ConfirmModel, type PreflightModel, type RunningModel, type SourceModel, type RecoveryPreviewModel,
} from './pages/run.js';
import { t, type Locale } from './i18n.js';
import { createTheme, resolveDensity, type Theme } from './theme.js';
import { clipLines, MIN_VIEWPORT_ROWS } from './viewport.js';
import { budgetChrome, clipRegion, composeWorkbenchGeometry, type WorkbenchGeometry, type WorkbenchSurfaceScope } from './workbench-layout.js';
import { justify, keyHints, panel, pill } from './widgets.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';

export type { WorkbenchSurfaceScope };

/** Shared geometry adapter retained for pointer dispatch and legacy static tests. */
export function measureWorkbenchGeometry(view: WorkbenchView, width: number, height: number): WorkbenchGeometry {
  const painted = paintFixed(createTheme(width), view, width, height);
  return composeWorkbenchGeometry({
    width,
    height,
    headerRows: painted.header.length,
    railRows: painted.context.length + painted.activity.length,
    messageRows: painted.notice.length,
    footerRows: painted.footer.length,
  });
}

export type WorkbenchPage =
  | 'loading' | 'home' | 'config' | 'history' | 'history-detail' | 'sessions' | 'inspection'
  | 'source' | 'preflight' | 'recovery-review' | 'candidate-product' | 'candidate-model' | 'confirm' | 'running' | 'result' | 'compare-confirm' | 'error';

/** Long-lived status badge — not a transient message. */
export type StatusSummaryModel = {
  readonly label: string;
  readonly tone?: 'ok' | 'warn' | 'off';
  readonly elapsed?: string;
};

export type ContextBarModel = {
  readonly taskTitle?: string;
  readonly productLabel?: string;
  readonly modelLabel?: string;
  readonly sourceLabel?: string;
};

export type ActivityCardModel = { readonly lines: readonly string[] };
export type NoticeModel = { readonly text: string; readonly tone?: 'info' | 'warn' | 'danger' };
export type RecoverySummaryModel = { readonly recovery: RecoveryPreviewModel; readonly expandable: boolean };

export type WorkbenchView = {
  readonly page: WorkbenchPage;
  readonly cwd: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly hasApiConfig: boolean;
  readonly hasUsableAuth?: boolean;
  readonly envName?: string;
  /** Display context for the selected or frozen product; never infer a Codex fallback. */
  readonly productLabel?: string;
  readonly productConfigured?: boolean;
  readonly hasTaskCase: boolean;
  readonly locale?: Locale;
  /** Short operational feedback only — not failure reasons or Agent prose. */
  readonly message: string;
  readonly inlineHelp?: boolean;
  readonly statusSummary?: StatusSummaryModel;
  readonly contextBar?: ContextBarModel;
  readonly activityCard?: ActivityCardModel;
  readonly notice?: NoticeModel;
  readonly recoverySummary?: RecoverySummaryModel;
  readonly surfaceScope?: WorkbenchSurfaceScope;
  readonly processExpanded?: boolean;
  readonly home?: HomeModel;
  readonly config?: ConfigModel;
  readonly history?: HistoryModel;
  readonly historyDetail?: HistoryCase | HistoryExperiment;
  readonly sessions?: SessionsModel;
  readonly inspection?: InspectionModel;
  readonly source?: SourceModel;
  readonly candidateProduct?: CandidateProductModel;
  readonly candidateModel?: CandidateModelPage;
  readonly preflight?: PreflightModel;
  readonly confirm?: ConfirmModel;
  readonly running?: RunningModel;
  readonly comparePending?: boolean;
  readonly resultAction?: import('./page-input.js').ResultAction;
  readonly resultDetails?: boolean;
  readonly bodyOffset?: number;
  readonly result?: ExperimentResult;
  readonly cancelling?: boolean;
};

class LinesView implements Component {
  readonly #lines: (width: number) => string[];
  constructor(lines: (width: number) => string[]) { this.#lines = lines; }
  invalidate(): void { /* parent requests render */ }
  render(width: number): string[] { return this.#lines(width); }
}

export class Workbench implements Component {
  readonly #view: () => WorkbenchView;
  readonly #viewport: () => { height?: number };
  constructor(view: () => WorkbenchView, viewport: () => { height?: number }) {
    this.#view = view;
    this.#viewport = viewport;
  }
  invalidate(): void { /* TUI requests the next frame */ }
  render(width: number): string[] {
    return renderWorkbench(this.#view(), width, this.#viewport().height);
  }
  createLayoutRoot(): Component {
    const viewOf = () => this.#view();
    const heightOf = () => this.#viewport().height;
    const usableHeight = (viewport: { height: number }) => viewport.height >= MIN_VIEWPORT_ROWS;
    const shortViewport = new LinesView((width) => renderWorkbench(viewOf(), width, heightOf()));
    const header = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).header);
    const context = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).context);
    const activity = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).activity);
    const list = new LinesView((width) => {
      const painted = paintFixed(createTheme(width), viewOf(), width, heightOf());
      return renderLayoutList(createTheme(width), viewOf(), width, painted.bodyRows);
    });
    const body = new ScrollView(list, { follow: 'none', primary: true, scrollbar: 'auto' });
    const notice = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).notice);
    const footer = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).footer);
    return new VStack([
      { component: shortViewport, grow: 0, shrink: 0, basis: 'auto', visible: (viewport) => !usableHeight(viewport) },
      { component: header, grow: 0, shrink: 0, basis: 'auto', visible: usableHeight },
      { component: context, grow: 0, shrink: 0, basis: 'auto', visible: usableHeight },
      { component: activity, grow: 0, shrink: 0, basis: 'auto', visible: usableHeight },
      { component: body, grow: 1, shrink: 1, minSize: 4, visible: usableHeight },
      { component: notice, grow: 0, shrink: 0, basis: 'auto', visible: usableHeight },
      { component: footer, grow: 0, shrink: 0, basis: 'auto', visible: usableHeight },
    ]);
  }
}

export function mountWorkbench(tui: TUI, workbench: Workbench): void {
  if (isViewportTUI(tui)) tui.setLayoutRoot(workbench.createLayoutRoot());
  else tui.addChild(workbench);
}

export function renderWorkbench(view: WorkbenchView, width: number, height?: number): string[] {
  const locale = view.locale ?? 'en';
  if (resolveDensity(width) === 'minimum') {
    return [...wrapTextWithAnsi(t(locale, 'tooNarrow'), Math.max(1, width)), t(locale, 'resizeColumns')];
  }
  if (height !== undefined && height < MIN_VIEWPORT_ROWS) {
    return clipLines([
      ...wrapTextWithAnsi(t(locale, 'tooShort'), Math.max(1, width)),
      t(locale, 'resizeRows', { n: MIN_VIEWPORT_ROWS }),
    ], height);
  }
  const theme = createTheme(width);
  const painted = paintFixed(theme, view, width, height);
  const body = clipLines(renderBody(theme, view, width, painted.bodyRows), painted.bodyRows, view.bodyOffset ?? 0);
  return [...painted.header, ...painted.context, ...painted.activity, ...body, ...painted.notice, ...painted.footer];
}

type PaintedFixed = {
  readonly header: string[];
  readonly context: string[];
  readonly activity: string[];
  readonly notice: string[];
  readonly footer: string[];
  readonly bodyRows: number | undefined;
};

function paintFixed(theme: Theme, view: WorkbenchView, width: number, height?: number): PaintedFixed {
  const headerRaw = renderHeader(theme, view, width);
  const contextRaw = renderContextBar(theme, view, width);
  const activityRaw = renderActivityCard(theme, view, width);
  const noticeRaw = renderNotice(theme, view, width);
  const footerRaw = renderFooter(theme, view, width);
  const budget = budgetChrome(height, {
    header: headerRaw.length,
    context: contextRaw.length,
    stage: 0,
    activity: activityRaw.length,
    notice: noticeRaw.length,
    footer: footerRaw.length,
  });
  return {
    header: clipRegion(headerRaw, budget.header, 'head'),
    context: clipRegion(contextRaw, budget.context, 'head'),
    activity: clipRegion(activityRaw, budget.activity, 'head'),
    notice: clipRegion(noticeRaw, budget.notice, 'head'),
    footer: clipRegion(footerRaw, budget.footer, 'tail'),
    bodyRows: height === undefined ? undefined : budget.body,
  };
}

function renderContextBar(theme: Theme, view: WorkbenchView, width: number): string[] {
  const bar = view.contextBar;
  if (!bar) return [];
  const locale = view.locale ?? 'en';
  const parts = [
    bar.taskTitle ? `${t(locale, 'taskLabel')} ${bar.taskTitle}` : undefined,
    bar.productLabel,
    bar.modelLabel,
    bar.sourceLabel,
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return [];
  return [truncateFit(` ${parts.join(` ${theme.glyphs.sep} `)}`, width, theme.glyphs.ellipsis)];
}

function renderActivityCard(theme: Theme, view: WorkbenchView, width: number): string[] {
  const card = view.activityCard;
  if (!card?.lines.length) return [];
  return card.lines.map((line) => truncateFit(line.startsWith(' ') ? line : ` ${line}`, width, theme.glyphs.ellipsis));
}

function renderHeader(theme: Theme, view: WorkbenchView, width: number): string[] {
  const locale = view.locale ?? 'en';
  const brand = theme.style.harness('Reprise');
  if (view.page === 'home') return [brand];
  const running = view.page === 'running' || (view.page === 'result' && view.running) ? view.running : undefined;
  const summary = view.statusSummary;
  const status = summary
    ? pill(theme, summary.label, summary.tone ?? 'ok')
    : running ? pill(theme, running.cancelling ? t(locale, 'cancellationRequested') : t(locale, 'running'), running.cancelling ? 'warn' : 'ok') : '';
  const metrics = summary?.elapsed ?? running?.elapsed;
  const right = [metrics, status].filter(Boolean).join('  ');
  if (!right) return [brand];
  const leftWide = brand;
  if (theme.density === 'compact' || visibleWidth(`${leftWide}   ${right}`) > width) {
    return [truncateFit(`${brand}  ${right}`, width, theme.glyphs.ellipsis)];
  }
  return [justify(theme, leftWide, right, width)];
}

function renderNotice(theme: Theme, view: WorkbenchView, width: number): string[] {
  if (view.notice?.text) {
    const paint = view.notice.tone === 'danger' ? theme.style.danger
      : view.notice.tone === 'warn' ? theme.style.warn
        : theme.style.muted;
    return paint(` ${view.notice.text}`).split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }
  return renderMessage(theme, view, width);
}

function renderMessage(_theme: Theme, view: WorkbenchView, width: number): string[] {
  if (view.page === 'error') return [];
  // Selection mode intentionally exposes its entry notice. The terminal owns the
  // actual selection and copy, so this is guidance rather than a copy result.
  if (view.page === 'running' && !view.running?.readingMode && !view.cancelling && !view.comparePending) return [];
  if (view.page === 'preflight' && !view.preflight) return [];
  if (!view.message.trim()) return [];
  return view.message.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(` ${line}`, Math.max(1, width)));
}

function renderFooter(theme: Theme, view: WorkbenchView, width: number): string[] {
  return [keyHints(theme, hintsFor(view, theme), width)];
}

function renderBody(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const page = renderPage(theme, view, width, height);
  if (!view.inlineHelp) return page;
  const locale = view.locale ?? 'en';
  const preparing = Boolean(view.running && (isRecoveryChrome(view.running) || view.running.preparePhase === 'copy'));
  const actions = listActions({
    page: view.page,
    locale,
    mode: optionalMode({
      processExpanded: Boolean(view.processExpanded),
      preparing,
      comparing: view.running?.preparePhase === 'compare',
      finding: Boolean(view.running?.finding),
      reading: Boolean(view.running?.readingMode),
      comparePending: Boolean(view.comparePending),
      findAllowed: !preparing,
      ...(view.confirm ? { canStartConfirm: confirmCanStart(view.confirm) } : {}),
      ...(view.confirm?.recovery?.failureAction ? { recoveryFailureAction: view.confirm.recovery.failureAction } : {}),
    }),
    artifacts: view.processExpanded ? {} : artifactsFromResult(view.result),
  });
  return [...renderHelp(theme, width, view.page, locale, actions), '', ...page];
}

function renderPage(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'loading') return [];
  if (view.page === 'error') return renderFailure(theme, width, view.message, view.locale ?? 'en');
  return renderSurface(pageTheme(theme, view.page), view, width, height);
}

export function pageTheme(theme: Theme, page: WorkbenchView['page']): Theme {
  return ['config', 'history', 'history-detail', 'sessions', 'inspection', 'candidate-product', 'candidate-model', 'confirm', 'result', 'compare-confirm', 'recovery-review'].includes(page)
    ? { ...theme, framed: false, plainPage: true }
    : theme;
}

function withProcess(
  theme: Theme,
  width: number,
  primary: readonly string[],
  view: WorkbenchView,
  height: number | undefined,
  expandLabel: string,
): string[] {
  const locale = view.locale ?? 'en';
  const cue = view.processExpanded
    ? theme.style.muted(` ${compactThemeGlyphs(theme, t(locale, 'hideProcess'))}`)
    : theme.style.muted(` ${compactThemeGlyphs(theme, expandLabel)}`);
  const head = [...primary, '', cue];
  if (!view.processExpanded || !view.running?.entries.length) return [...head];
  const remain = height === undefined ? undefined : Math.max(4, height - head.length - 1);
  return [...head, '', ...renderTimeline(theme, width, view.running, remain)];
}

function compactThemeGlyphs(theme: Theme, text: string): string {
  return text
    .replaceAll('✓', theme.glyphs.ok)
    .replaceAll('✗', theme.glyphs.err)
    .replaceAll('●', theme.glyphs.dot)
    .replaceAll('○', theme.glyphs.empty)
    .replaceAll('▸', theme.glyphs.arrow)
    .replaceAll('▾', theme.glyphs.arrow)
    .replaceAll('…', theme.glyphs.ellipsis);
}

function renderSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const locale = view.locale ?? 'en';
  if (view.page === 'home' && view.home) return renderHome(theme, width, view.home);
  if (view.page === 'config' && view.config) return renderConfig(theme, width, view.config);
  if (view.page === 'history-detail' && view.historyDetail && !('taskCase' in view.historyDetail) && view.running?.entries.length) {
    if (view.processExpanded) return renderTimeline(theme, width, view.running, height);
    const summary = renderHistoryDetail(theme, width, view.historyDetail, locale);
    return withProcess(theme, width, summary, view, height, t(locale, 'viewCandidateProcess'));
  }
  if (view.page === 'history' && view.history) return renderHistory(theme, width, view.history, height);
  if (view.page === 'history-detail' && view.historyDetail) return renderHistoryDetail(theme, width, view.historyDetail, locale);
  if (view.page === 'sessions' && view.sessions) return renderSessions(theme, width, view.sessions, height);
  if (view.page === 'inspection' && view.inspection) return renderInspectionSurface(theme, view, width, height);
  if (view.page === 'source' && view.source) return renderSource(theme, width, view.source);
  if (view.page === 'candidate-product' && view.candidateProduct) {
    return withProcess(theme, width, [
      ...recoverySummaryLines(theme, view, width),
      ...renderCandidateProductPicker(theme, width, view.candidateProduct),
    ], view, height, t(locale, 'viewRecoveryProcess'));
  }
  if (view.page === 'candidate-model' && view.candidateModel) {
    return renderCandidateModelPicker(theme, width, view.candidateModel, height);
  }
  if (view.page === 'preflight' && view.preflight) return renderPreflight(theme, width, view.preflight);
  if (view.page === 'recovery-review') {
    return [
      ...recoverySummaryLines(theme, view, width, true),
      ` ${t(locale, 'recoveryReviewContinue')}`,
    ];
  }
  if (view.page === 'preflight') {
    return panel(theme, t(locale, 'checkingSourceTitle'), [` ${view.message || t(locale, 'inspectingSource')}`], width);
  }
  if (view.page === 'confirm' && view.confirm) {
    return withProcess(theme, width, renderConfirmation(theme, width, view.confirm), view, height, t(locale, 'viewRecoveryProcess'));
  }
  if (view.page === 'running' && view.running) return renderRunningSurface(theme, view, width, height);
  if (view.page === 'result' && view.result) return renderResultSurface(theme, view, width, height);
  if (view.page === 'compare-confirm' && view.result) {
    return [
      ` ${t(locale, 'compareConfirmTitle')}`,
      '',
      ` ${t(locale, 'compareConfirmBody')}`,
      '',
      ` ${t(locale, 'compareConfirmCost')}`,
    ];
  }
  return [];
}

function recoverySummaryLines(theme: Theme, view: WorkbenchView, width: number, expanded = false): string[] {
  const summary = view.recoverySummary;
  const lines = summary ? renderRecoverySummary(theme, width, summary.recovery, view.locale ?? 'en', expanded) : [];
  return lines.length ? [...lines, ''] : [];
}

function renderInspectionSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.inspection) return [];
  return renderInspection(theme, width, view.inspection, height);
}

function renderRunningSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.running) return [];
  const locale = view.locale ?? 'en';
  if (view.running.preparePhase === 'check' || view.running.preparePhase === 'copy') {
    return renderPrepareSummary(theme, width, view.running, locale);
  }
  if (view.running.preparePhase === 'compare') {
    const ended = theme.style.muted(` ${t(locale, 'comparingTitle')} · ${view.running.elapsed}`);
    const remain = height === undefined ? undefined : Math.max(4, height - 2);
    return [ended, '', ...renderTimeline(theme, width, view.running, remain)];
  }
  return renderTimeline(theme, width, view.running, height);
}

function renderResultSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.result) return [];
  const locale = view.locale ?? 'en';
  if (view.processExpanded && view.running?.entries.length) return renderTimeline(theme, width, view.running, height);
  return renderResult(theme, width, view.result, locale, view.productLabel, Boolean(view.comparePending), resultRenderOptions(view));
}

export function resultRenderOptions(view: WorkbenchView): ResultRenderOptions {
  return {
    ...(view.surfaceScope ? { surfaceScope: view.surfaceScope } : {}),
    ...(view.processExpanded ? { processExpanded: true } : {}),
    ...(view.running?.phaseClocks ? { phaseClocks: view.running.phaseClocks } : {}),
    ...(view.resultAction ? { selectedAction: view.resultAction } : {}),
    ...(view.resultDetails ? { detailsExpanded: true } : {}),
    processAvailable: Boolean(view.running?.entries.length),
  };
}

function renderLayoutList(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'running' && view.running) return clipLines(renderTimeline(theme, width, view.running, height), height);
  return clipLines(renderBody(theme, view, width, height), height, view.bodyOffset ?? 0);
}

export function workbenchBodyOrigin(view: WorkbenchView, width: number, height?: number): { header: number; rail: number } {
  const painted = paintFixed(createTheme(width), view, width, height);
  return {
    header: painted.header.length + painted.context.length,
    rail: painted.activity.length,
  };
}

function hintsFor(view: WorkbenchView, theme: Theme): readonly (readonly [string, string])[] {
  const locale = view.locale ?? 'en';
  if (view.page === 'home') return homeHints(locale, view.home);
  if (view.page === 'config' && view.config) {
    const fields = visibleConfigItems(view.config.draft.kind, view.config.advanced);
    const selected = fields[view.config.selected];
    return configHints(view.config.editing, selected === 'more' ? (view.config.advanced ? 'less' : 'more') : selected === 'language' ? undefined : selected, view.config.pendingToggle, selected === 'language', locale, Boolean(view.config.leaveConfirm));
  }
  if (view.page === 'history') return historyHints(locale, view.history?.items.length ?? 0);
  if (view.page === 'history-detail') {
    return [...historyDetailHints(
      Boolean(view.historyDetail && 'taskCase' in view.historyDetail),
      Boolean(view.historyDetail && !('taskCase' in view.historyDetail) && view.historyDetail.reportPath),
      locale,
    )];
  }
  if (view.page === 'sessions') return sessionsHints(view.sessions, locale);
  if (view.page === 'inspection') return inspectionHints(locale);
  if (view.page === 'source') return sourceHints(locale);
  if (view.page === 'candidate-product') return candidateProductHints(locale, view.candidateProduct?.products.length ?? 0);
  if (view.page === 'recovery-review') return [['Enter', t(locale, 'recoveryReviewContinue')], ['Esc', t(locale, 'hintBack')]];
  if (view.page === 'candidate-model') {
    return candidateModelHints(view.candidateModel?.status === 'ready' && Boolean(view.candidateModel.offers.length), locale, view.candidateModel?.offers.length ?? 0);
  }
  if (view.page === 'preflight') return view.preflight ? preflightHints(locale) : [['Esc', t(locale, 'hintHome')]];
  if (view.page === 'confirm') {
    const hints = footerHintPairs(listActions({
      page: 'confirm',
      locale,
      mode: { canStartConfirm: view.confirm ? confirmCanStart(view.confirm) : false },
    }), locale);
    return hints.slice(0, 3);
  }
  if (view.page === 'running' && view.running) {
    const preparing = isRecoveryChrome(view.running) || view.running.preparePhase === 'copy';
    return footerHintPairs(listActions({
      page: 'running',
      locale,
      mode: {
        preparing,
        comparing: view.running.preparePhase === 'compare',
        finding: Boolean(view.running.finding),
        reading: Boolean(view.running.readingMode),
        findAllowed: !preparing,
      },
      narrow: theme.density !== 'wide',
    }), locale);
  }
  if (view.page === 'result') {
    if (view.processExpanded) return [['Esc', t(locale, 'hintBack')], ['?', t(locale, 'hintHelp')]];
    const hints = footerHintPairs(listActions({
      page: 'result',
      locale,
      mode: { comparePending: Boolean(view.comparePending), processAvailable: Boolean(view.running?.entries.length) },
      artifacts: artifactsFromResult(view.result),
    }), locale);
    return hints.slice(0, 3);
  }
  if (view.page === 'compare-confirm') return [['Enter', t(locale, 'compareConfirmStart')], ['Esc', t(locale, 'hintBack')]];
  if (view.page === 'error') return failureHints(locale);
  return [['b', t(locale, 'hintBack')], ['Ctrl+C', t(locale, 'hintExit')]];
}
