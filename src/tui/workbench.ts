import { type Component, ScrollView, VStack, isViewportTUI, type TUI, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { CodexExperimentResult } from '../application/experiment.js';
import { compact, truncateFit } from './format.js';
import { renderHelp } from './overlays.js';
import { CONFIG_FIELDS, configHints, renderConfig, type ConfigModel } from './pages/config.js';
import { historyDetailHints, historyHints, renderHistory, renderHistoryDetail, type HistoryModel } from './pages/history.js';
import { homeHints, renderHome, type HomeModel } from './pages/home.js';
import { inspectionHints, renderInspection, renderSessions, sessionsHints, type InspectionModel, type SessionsModel } from './pages/intake.js';
import { renderFailure, renderResult, resultHints, failureHints } from './pages/result.js';
import { candidateModelHints, candidateProductHints, renderCandidateModelPicker, renderCandidateProductPicker, type CandidateModelPage, type CandidateProductModel } from './pages/candidate.js';
import {
  confirmHints, confirmCanStart, isRecoveryChrome, preflightHints, renderConfirmation, renderPreflight, renderSource, renderTimeline,
  runningChrome, runningHints, sourceHints,
  type ConfirmModel, type PreflightModel, type RunningModel, type SourceModel,
} from './pages/run.js';
import { t, type Locale } from './i18n.js';
import { OVERLAY_PAGES, overlayChromeRows, renderOverlaySheet } from './overlay-sheet.js';
import { renderActors, actorsHints } from './pages/actors.js';
import { renderViewer, viewerHints, type ViewerModel } from './pages/viewer.js';
import { createTheme, resolveDensity, showsDetailPane, type Theme } from './theme.js';
import { bodyHeight, clipLines, FOOTER_ROWS, isShortViewport, MIN_VIEWPORT_ROWS } from './viewport.js';
import { divider, joinColumns, justify, keyHints, panel, pill } from './widgets.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';

export type WorkbenchPage =
  | 'loading' | 'home' | 'config' | 'history' | 'history-detail' | 'sessions' | 'inspection'
  | 'source' | 'preflight' | 'candidate-product' | 'candidate-model' | 'confirm' | 'running' | 'result' | 'error';

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
  readonly message: string;
  readonly inlineHelp?: boolean;
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
  readonly result?: CodexExperimentResult;
  readonly cancelling?: boolean;
  readonly viewer?: ViewerModel;
  readonly actorsOpen?: boolean;
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
    const short = (): boolean => isShortViewport(this.#viewport().height);
    const header = new LinesView((width) => trimChrome(renderHeader(createTheme(width), this.#view(), width), short(), 'head'));
    const rail = new LinesView((width) => {
      const view = this.#view();
      if (view.page !== 'running' || !view.running) return [];
      return runningChrome(createTheme(width), width, view.running);
    });
    const list = new LinesView((width) => {
      const viewport = this.#viewport();
      const measuredViewport = viewport.height === undefined ? { width } : { width, height: viewport.height };
      const height = bodyHeight(measuredViewport, 1, isShortViewport(viewport.height) ? 1 : 2);
      return renderLayoutList(createTheme(width), this.#view(), width, height);
    });
    const body = new ScrollView(list, { follow: 'none', primary: true, scrollbar: 'auto' });
    const message = new LinesView((width) => trimChrome(renderMessage(createTheme(width), this.#view(), width), short(), 'head'));
    const footer = new LinesView((width) => trimChrome(renderFooter(createTheme(width), this.#view(), width), short(), 'tail'));
    return new VStack([
      { component: header, grow: 0, shrink: 0, basis: 'auto' },
      { component: rail, grow: 0, shrink: 0, basis: 'auto', visible: () => this.#view().page === 'running' },
      { component: body, grow: 1, shrink: 1, minSize: 4 },
      { component: message, grow: 0, shrink: 0, basis: 'auto' },
      { component: footer, grow: 0, shrink: 0, basis: 'auto' },
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
    return [
      ...wrapTextWithAnsi(t(locale, 'tooNarrow'), Math.max(1, width)),
      t(locale, 'resizeColumns'),
    ];
  }
  if (height !== undefined && height < MIN_VIEWPORT_ROWS) {
    return clipLines([
      ...wrapTextWithAnsi(t(locale, 'tooShort'), Math.max(1, width)),
      t(locale, 'resizeRows', { n: MIN_VIEWPORT_ROWS }),
    ], height);
  }
  const short = isShortViewport(height);
  const theme = createTheme(width);
  const header = trimChrome(renderHeader(theme, view, width), short, 'head');
  const message = trimChrome(renderMessage(theme, view, width), short, 'head');
  const footer = trimChrome(renderFooter(theme, view, width), short, 'tail');
  const available = bodyHeight({ width, ...(height === undefined ? {} : { height }) }, message.length + footer.length - FOOTER_ROWS, header.length);
  return [...header, ...clipLines(renderBody(theme, view, width, available), available), ...message, ...footer];
}

/** On a short viewport the dividers and wrapped status text cost more rows than the body can spare. */
function trimChrome(lines: string[], short: boolean, keep: 'head' | 'tail'): string[] {
  if (!short || lines.length <= 1) return lines;
  return keep === 'head' ? lines.slice(0, 1) : lines.slice(-1);
}

function modelSummary(theme: Theme, view: WorkbenchView): string {
  if (!view.modelId) return t(view.locale ?? 'en', 'noConfiguredModel');
  return `${view.modelId} ${theme.glyphs.sep} ${view.effort ?? 'medium'}`;
}

function harnessStatus(theme: Theme, view: WorkbenchView): string {
  const locale = view.locale ?? 'en';
  if (!view.hasApiConfig) return pill(theme, t(locale, 'harnessUnset'), 'off');
  if (view.hasUsableAuth === false) return pill(theme, t(locale, view.envName ? 'harnessEnvUnset' : 'harnessKeyMissing'), 'warn');
  return pill(theme, t(locale, 'harnessReady'), 'ok');
}

function identityStatus(theme: Theme, view: WorkbenchView): string {
  const locale = view.locale ?? 'en';
  const product = view.productLabel
    ? pill(theme, view.productLabel, view.productConfigured ? 'ok' : 'off')
    : pill(theme, t(locale, 'noAgentSelected'), 'off');
  const task = pill(theme, view.hasTaskCase ? t(locale, 'hasCase') : t(locale, 'noCase'), view.hasTaskCase ? 'ok' : 'off');
  return `${harnessStatus(theme, view)}  ${product}  ${task}`;
}

function runningHeaderKey(running: RunningModel): 'recoveringTitle' | 'candidateStartingTitle' | 'comparingTitle' | 'candidateRunningTitle' {
  if (isRecoveryChrome(running)) return 'recoveringTitle';
  if (running.preparePhase === 'copy') return 'candidateStartingTitle';
  if (running.preparePhase === 'compare') return 'comparingTitle';
  return 'candidateRunningTitle';
}

function renderHeader(theme: Theme, view: WorkbenchView, width: number): string[] {
  const locale = view.locale ?? 'en';
  const running = view.page === 'running' || (view.page === 'result' && view.running) ? view.running : undefined;
  const brand = view.page === 'result' && running
    ? `${theme.style.harness('Reprise')}   ${t(locale, 'resultTitle')}`
    : running
      ? `${theme.style.harness('Reprise')}   ${t(locale, runningHeaderKey(running), { product: running.productLabel ?? t(locale, 'unknownAgent') })}`
      : theme.style.harness('Reprise v0.1.0');
  const status = view.page === 'result' && running
    ? pill(theme, t(locale, 'done'), 'ok')
    : running
      ? pill(theme, running.cancelling ? t(locale, 'hintCancel') : t(locale, 'running'), running.cancelling ? 'warn' : 'ok')
      : identityStatus(theme, view);
  const metrics = running
    ? running.preparePhase === 'compare'
      ? running.elapsed
      : `${running.elapsed}   ${t(locale, 'replayRound', { n: Math.max(1, running.turns.used) })}`
    : modelSummary(theme, view);
  const right = `${metrics}   ${status}`;
  const leftWide = running ? brand : `${brand}   ${compact(view.cwd, 48, theme.glyphs.ellipsis)}`;
  if (theme.density === 'compact' || visibleWidth(`${leftWide}   ${right}`) > width) {
    const cwdBudget = Math.max(8, width - visibleWidth(`${brand}   `));
    const left = `${brand}   ${compact(view.cwd, cwdBudget, theme.glyphs.ellipsis)}`;
    return [
      truncateFit(left, width, theme.glyphs.ellipsis),
      truncateFit(right, width, theme.glyphs.ellipsis),
      divider(theme, width),
    ];
  }
  return [justify(theme, leftWide, right, width), divider(theme, width)];
}

function renderMessage(_theme: Theme, view: WorkbenchView, width: number): string[] {
  if (view.page === 'error') return [];
  if (view.page === 'running' && !view.cancelling) return [];
  if (view.page === 'preflight' && !view.preflight) return [];
  return view.message.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(` ${line}`, Math.max(1, width)));
}

function renderFooter(theme: Theme, view: WorkbenchView, width: number): string[] {
  const locale = view.locale ?? 'en';
  const product = view.running?.productLabel ?? t(locale, 'unknownAgent');
  const recovering = view.running ? isRecoveryChrome(view.running) : false;
  const preparing = recovering || view.running?.preparePhase === 'copy';
  const composer = view.page === 'running' && view.running
    ? ` ${theme.glyphs.cursor} ${theme.style.muted(t(locale, recovering ? 'noTypeRecovery' : preparing ? 'noTyping' : 'noTypeTarget', { product }))}`
    : undefined;
  return [
    ...(composer ? [theme.style.fillCanvas(truncateFit(composer, width, theme.glyphs.ellipsis))] : []),
    divider(theme, width),
    keyHints(theme, hintsFor(view, theme), width),
  ];
}

function renderBody(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const page = renderPage(theme, view, width, height);
  if (!view.inlineHelp) return page;
  return [...renderHelp(theme, width, view.page, view.locale ?? 'en'), '', ...page];
}

function renderPage(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'loading') return [];
  if (view.page === 'error') return renderFailure(theme, width, view.message, view.locale ?? 'en');
  if (view.viewer) {
    const canvas = renderSurface(theme, view, width, height);
    return clipLines(renderOverlaySheet(theme, canvas, renderViewer(theme, width, view.viewer, sheetHeight(height, canvas))), height);
  }
  if (view.actorsOpen && view.running) {
    const canvas = renderSurface(theme, view, width, height);
    return clipLines(renderOverlaySheet(theme, canvas, renderActors(theme, width, view.running, view.locale ?? 'en')), height);
  }
  if (OVERLAY_PAGES.has(view.page) && view.home) {
    const background = renderHome(theme, width, view.home);
    const canvas = renderSurface(theme, view, width, sheetHeight(height, background));
    return clipLines(renderOverlaySheet(theme, background, canvas), height);
  }
  return renderSurface(theme, view, width, height);
}

function sheetHeight(height: number | undefined, background: readonly string[]): number | undefined {
  if (height === undefined) return undefined;
  return Math.max(4, height - overlayChromeRows(background));
}

function renderSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'home' && view.home) return renderHome(theme, width, view.home);
  if (view.page === 'config' && view.config) return renderConfig(theme, width, view.config);
  if ((view.page === 'history' || view.page === 'history-detail') && view.history) return renderHistory(theme, width, view.history, height);
  if (view.page === 'history-detail' && view.historyDetail) return renderHistoryDetail(theme, width, view.historyDetail, view.locale ?? 'en');
  if (view.page === 'sessions' && view.sessions) return renderSessions(theme, width, view.sessions, height);
  if (view.page === 'inspection' && view.inspection) {
    if (view.sessions && showsDetailPane(theme)) {
      const listWidth = Math.max(28, Math.floor(width * 0.38));
      const detailWidth = width - listWidth - 1;
      return joinColumns(
        renderSessions(theme, listWidth, view.sessions, height, false, false),
        renderInspection(theme, detailWidth, view.inspection, height),
        listWidth, detailWidth, 1, theme,
      );
    }
    return renderInspection(theme, width, view.inspection, height);
  }
  if (view.page === 'source' && view.source) return renderSource(theme, width, view.source);
  if (view.page === 'candidate-product' && view.candidateProduct) return renderCandidateProductPicker(theme, width, view.candidateProduct);
  if (view.page === 'candidate-model' && view.candidateModel) return renderCandidateModelPicker(theme, width, view.candidateModel);
  if (view.page === 'preflight' && view.preflight) return renderPreflight(theme, width, view.preflight);
  if (view.page === 'preflight') {
    return panel(theme, t(view.locale ?? 'en', 'checkingSourceTitle'), [
      ` ${view.message || t(view.locale ?? 'en', 'inspectingSource')}`,
    ], width);
  }
  if (view.page === 'confirm' && view.confirm) return renderConfirmation(theme, width, view.confirm);
  if (view.page === 'running' && view.running) return renderTimeline(theme, width, view.running, height);
  if (view.page === 'result' && view.result) {
    const summary = renderResult(theme, width, view.result, view.locale ?? 'en', view.productLabel);
    if (!view.running?.entries.length) return summary;
    return [...renderTimeline(theme, width, view.running, height === undefined ? undefined : Math.max(6, height - summary.length - 1)), '', ...summary];
  }
  return [];
}

function renderLayoutList(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'running' && view.running) return clipLines(renderTimeline(theme, width, view.running, height), height);
  return clipLines(renderBody(theme, view, width, height), height);
}

function hintsFor(view: WorkbenchView, theme: Theme): readonly (readonly [string, string])[] {
  const locale = view.locale ?? 'en';
  if (view.page === 'home') return homeHints(locale, view.home);
  if (view.page === 'config' && view.config) {
    return configHints(view.config.editing, CONFIG_FIELDS[view.config.selected], view.config.pendingToggle, view.config.selected >= CONFIG_FIELDS.length, locale);
  }
  if (view.page === 'history') return historyHints(locale);
  if (view.page === 'history-detail') return historyDetailHints(Boolean(view.historyDetail && 'taskCase' in view.historyDetail), Boolean(view.historyDetail && !('taskCase' in view.historyDetail) && view.historyDetail.reportPath), locale);
  if (view.viewer) return viewerHints(locale);
  if (view.actorsOpen) return actorsHints(locale);
  if (view.page === 'sessions') return sessionsHints(view.sessions, locale);
  if (view.page === 'inspection') return inspectionHints(locale);
  if (view.page === 'source') return sourceHints(locale);
  if (view.page === 'candidate-product') return candidateProductHints(locale);
  if (view.page === 'candidate-model') return candidateModelHints(view.candidateModel?.status === 'ready' && Boolean(view.candidateModel.offers.length), locale);
  if (view.page === 'preflight') {
    if (!view.preflight) return [['Esc', t(locale, 'hintHome')]];
    return preflightHints(locale);
  }
  if (view.page === 'confirm') return confirmHints(view.confirm ? confirmCanStart(view.confirm) : false, locale);
  if (view.page === 'running' && view.running) {
    const preparing = isRecoveryChrome(view.running) || view.running.preparePhase === 'copy';
    return runningHints(view.running.filter, theme.density !== 'wide', preparing, locale, Boolean(view.running.finding));
  }
  if (view.page === 'result' && view.running?.finding) {
    return runningHints(view.running.filter, theme.density !== 'wide', false, locale, true);
  }
  if (view.page === 'result') return resultHints(locale);
  if (view.page === 'error') return failureHints(locale);
  return [['b', t(locale, 'hintBack')], ['Ctrl+C', t(locale, 'hintExit')]];
}
