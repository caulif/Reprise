import { type Component, ScrollView, VStack, isViewportTUI, type TUI, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { ExperimentResult } from '../application/experiment.js';
import { compact, truncateFit } from './format.js';
import { renderHelp } from './overlays.js';
import { configHints, renderConfig, type ConfigModel } from './pages/config.js';
import { configFieldsForKind, languageFieldIndex } from '../infrastructure/harness-model-config.js';
import { historyDetailHints, historyHints, renderHistory, renderHistoryDetail, type HistoryModel } from './pages/history.js';
import { homeHints, renderHome, type HomeModel } from './pages/home.js';
import { inspectionHints, renderInspection, renderSessions, sessionsHints, type InspectionModel, type SessionsModel } from './pages/intake.js';
import { renderFailure, renderResult, resultHints, failureHints } from './pages/result.js';
import { renderPrepareSummary } from './pages/recovery-summary.js';
import { candidateModelHints, candidateProductHints, renderCandidateModelPicker, renderCandidateProductPicker, type CandidateModelPage, type CandidateProductModel } from './pages/candidate.js';
import {
  confirmHints, confirmCanStart, isRecoveryChrome, preflightHints, renderConfirmation, renderPreflight, renderSource, renderTimeline,
  runningChrome, runningHints, sourceHints,
  type ConfirmModel, type PreflightModel, type RunningModel, type SourceModel,
} from './pages/run.js';
import { t, type Locale } from './i18n.js';
import { OVERLAY_PAGES, overlayChromeRows, renderOverlaySheet } from './overlay-sheet.js';
import { createTheme, resolveDensity, showsDetailPane, type Theme } from './theme.js';
import { clipLines, MIN_VIEWPORT_ROWS } from './viewport.js';
import { budgetChrome, clipRegion, type WorkbenchSurfaceScope } from './workbench-layout.js';
import { divider, joinColumns, justify, keyHints, panel, pill } from './widgets.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';

export type { WorkbenchSurfaceScope };

export type WorkbenchPage =
  | 'loading' | 'home' | 'config' | 'history' | 'history-detail' | 'sessions' | 'inspection'
  | 'source' | 'preflight' | 'candidate-product' | 'candidate-model' | 'confirm' | 'running' | 'result' | 'error';

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

export type StageRailModel = { readonly text: string };
export type ActivityCardModel = { readonly lines: readonly string[] };
export type NoticeModel = { readonly text: string; readonly tone?: 'info' | 'warn' | 'danger' };
export type RecoverySummaryModel = { readonly lines: readonly string[]; readonly expandable: boolean };

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
  readonly stageRail?: StageRailModel;
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
    const header = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).header);
    const context = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).context);
    const stage = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).stage);
    const activity = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).activity);
    const list = new LinesView((width) => {
      const painted = paintFixed(createTheme(width), viewOf(), width, heightOf());
      return renderLayoutList(createTheme(width), viewOf(), width, painted.bodyRows);
    });
    const body = new ScrollView(list, { follow: 'none', primary: true, scrollbar: 'auto' });
    const notice = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).notice);
    const footer = new LinesView((width) => paintFixed(createTheme(width), viewOf(), width, heightOf()).footer);
    return new VStack([
      { component: header, grow: 0, shrink: 0, basis: 'auto' },
      { component: context, grow: 0, shrink: 0, basis: 'auto' },
      { component: stage, grow: 0, shrink: 0, basis: 'auto' },
      { component: activity, grow: 0, shrink: 0, basis: 'auto' },
      { component: body, grow: 1, shrink: 1, minSize: 4 },
      { component: notice, grow: 0, shrink: 0, basis: 'auto' },
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
  return [...painted.header, ...painted.context, ...painted.stage, ...painted.activity, ...body, ...painted.notice, ...painted.footer];
}

type PaintedFixed = {
  readonly header: string[];
  readonly context: string[];
  readonly stage: string[];
  readonly activity: string[];
  readonly notice: string[];
  readonly footer: string[];
  readonly bodyRows: number | undefined;
};

function paintFixed(theme: Theme, view: WorkbenchView, width: number, height?: number): PaintedFixed {
  const headerRaw = renderHeader(theme, view, width);
  const contextRaw = renderContextBar(theme, view, width);
  const stageRaw = renderStageRail(theme, view, width);
  const activityRaw = renderActivityCard(theme, view, width);
  const noticeRaw = renderNotice(theme, view, width);
  const footerRaw = renderFooter(theme, view, width);
  const budget = budgetChrome(height, {
    header: headerRaw.length,
    context: contextRaw.length,
    stage: stageRaw.length,
    activity: activityRaw.length,
    notice: noticeRaw.length,
    footer: footerRaw.length,
  });
  return {
    header: clipRegion(headerRaw, budget.header, 'head'),
    context: clipRegion(contextRaw, budget.context, 'head'),
    stage: clipRegion(stageRaw, budget.stage, 'head'),
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

function renderStageRail(theme: Theme, view: WorkbenchView, width: number): string[] {
  if (!view.stageRail?.text) return [];
  return [truncateFit(` ${view.stageRail.text}`, width, theme.glyphs.ellipsis)];
}

function renderActivityCard(theme: Theme, view: WorkbenchView, width: number): string[] {
  const card = view.activityCard;
  if (!card?.lines.length) {
    if (view.page === 'running' && view.running && !isPreparing(view.running)) {
      return runningChrome(theme, width, view.running);
    }
    return [];
  }
  return card.lines.map((line) => truncateFit(line.startsWith(' ') ? line : ` ${line}`, width, theme.glyphs.ellipsis));
}

function isPreparing(model: RunningModel): boolean {
  return model.preparePhase === 'check' || model.preparePhase === 'copy';
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

function runningHeaderKey(running: RunningModel): 'recoveringTitle' | 'stillRecoveringTitle' | 'candidateStartingTitle' | 'comparingTitle' | 'candidateRunningTitle' {
  if (isRecoveryChrome(running)) {
    const sinceStart = (running.tick ?? Date.now()) - (running.runStartedAt ?? Date.now());
    return sinceStart >= 30_000 ? 'stillRecoveringTitle' : 'recoveringTitle';
  }
  if (running.preparePhase === 'copy') return 'candidateStartingTitle';
  if (running.preparePhase === 'compare') return 'comparingTitle';
  return 'candidateRunningTitle';
}

function renderHeader(theme: Theme, view: WorkbenchView, width: number): string[] {
  const locale = view.locale ?? 'en';
  const running = view.page === 'running' || (view.page === 'result' && view.running) ? view.running : undefined;
  const brand = view.page === 'result'
    ? `${theme.style.harness('Reprise')}   ${t(locale, 'resultTitle')}`
    : running
      ? `${theme.style.harness('Reprise')}   ${t(locale, runningHeaderKey(running), { product: running.productLabel ?? t(locale, 'unknownAgent') })}`
      : theme.style.harness('Reprise v0.1.0');
  const summary = view.statusSummary;
  const status = summary
    ? pill(theme, summary.label, summary.tone ?? 'ok')
    : view.page === 'result'
      ? pill(theme, t(locale, 'done'), 'ok')
      : running
        ? pill(theme, running.cancelling ? t(locale, 'hintCancel') : t(locale, 'running'), running.cancelling ? 'warn' : 'ok')
        : identityStatus(theme, view);
  const metrics = summary?.elapsed ?? (running ? running.elapsed : modelSummary(theme, view));
  const right = `${metrics}   ${status}`;
  const leftWide = running || view.page === 'result' ? brand : `${brand}   ${compact(view.cwd, 48, theme.glyphs.ellipsis)}`;
  if (theme.density === 'compact' || visibleWidth(`${leftWide}   ${right}`) > width) {
    const cwdBudget = Math.max(8, width - visibleWidth(`${brand}   `));
    const left = running || view.page === 'result' ? brand : `${brand}   ${compact(view.cwd, cwdBudget, theme.glyphs.ellipsis)}`;
    return [truncateFit(left, width, theme.glyphs.ellipsis), truncateFit(right, width, theme.glyphs.ellipsis), divider(theme, width)];
  }
  return [justify(theme, leftWide, right, width), divider(theme, width)];
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
  if (view.page === 'running' && !view.cancelling && !view.comparePending) return [];
  if (view.page === 'preflight' && !view.preflight) return [];
  if (!view.message.trim()) return [];
  return view.message.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(` ${line}`, Math.max(1, width)));
}

function renderFooter(theme: Theme, view: WorkbenchView, width: number): string[] {
  return [divider(theme, width), keyHints(theme, hintsFor(view, theme), width)];
}

function renderBody(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const page = renderPage(theme, view, width, height);
  if (!view.inlineHelp) return page;
  return [...renderHelp(theme, width, view.page, view.locale ?? 'en'), '', ...page];
}

function renderPage(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'loading') return [];
  if (view.page === 'error') return renderFailure(theme, width, view.message, view.locale ?? 'en');
  if (OVERLAY_PAGES.has(view.page) && view.home && !view.running?.entries.length) {
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
    ? theme.style.muted(` ${t(locale, 'hideProcess')}`)
    : theme.style.muted(` ${expandLabel}`);
  const head = [...primary, '', cue];
  if (!view.processExpanded || !view.running?.entries.length) return [...head];
  const remain = height === undefined ? undefined : Math.max(4, height - head.length - 1);
  return [...head, '', ...renderTimeline(theme, width, view.running, remain)];
}

function renderSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const locale = view.locale ?? 'en';
  if (view.page === 'home' && view.home) return renderHome(theme, width, view.home);
  if (view.page === 'config' && view.config) return renderConfig(theme, width, view.config);
  if (view.page === 'history-detail' && view.historyDetail && !('taskCase' in view.historyDetail) && view.running?.entries.length) {
    const summary = renderHistoryDetail(theme, width, view.historyDetail, locale);
    return withProcess(theme, width, summary, view, height, t(locale, 'viewCandidateProcess'));
  }
  if ((view.page === 'history' || view.page === 'history-detail') && view.history) return renderHistory(theme, width, view.history, height);
  if (view.page === 'history-detail' && view.historyDetail) return renderHistoryDetail(theme, width, view.historyDetail, locale);
  if (view.page === 'sessions' && view.sessions) return renderSessions(theme, width, view.sessions, height);
  if (view.page === 'inspection' && view.inspection) return renderInspectionSurface(theme, view, width, height);
  if (view.page === 'source' && view.source) return renderSource(theme, width, view.source);
  if (view.page === 'candidate-product' && view.candidateProduct) {
    return withProcess(theme, width, [
      ...recoverySummaryLines(view),
      ...renderCandidateProductPicker(theme, width, view.candidateProduct),
    ], view, height, t(locale, 'viewRecoveryProcess'));
  }
  if (view.page === 'candidate-model' && view.candidateModel) {
    return withProcess(theme, width, [
      ...recoverySummaryLines(view),
      ...renderCandidateModelPicker(theme, width, view.candidateModel),
    ], view, height, t(locale, 'viewRecoveryProcess'));
  }
  if (view.page === 'preflight' && view.preflight) return renderPreflight(theme, width, view.preflight);
  if (view.page === 'preflight') {
    return panel(theme, t(locale, 'checkingSourceTitle'), [` ${view.message || t(locale, 'inspectingSource')}`], width);
  }
  if (view.page === 'confirm' && view.confirm) {
    return withProcess(theme, width, renderConfirmation(theme, width, view.confirm), view, height, t(locale, 'viewRecoveryProcess'));
  }
  if (view.page === 'running' && view.running) return renderRunningSurface(theme, view, width, height);
  if (view.page === 'result' && view.result) return renderResultSurface(theme, view, width, height);
  return [];
}

function recoverySummaryLines(view: WorkbenchView): string[] {
  const lines = view.recoverySummary?.lines ?? [];
  return lines.length ? [...lines, ''] : [];
}

function renderInspectionSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.inspection) return [];
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

function renderRunningSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.running) return [];
  const locale = view.locale ?? 'en';
  if (view.running.preparePhase === 'check' || view.running.preparePhase === 'copy') {
    return renderPrepareSummary(theme, width, view.running, locale);
  }
  if (view.running.preparePhase === 'compare') {
    const ended = theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'candidateEndedShort')}`);
    const remain = height === undefined ? undefined : Math.max(4, height - 2);
    return [ended, '', ...renderTimeline(theme, width, view.running, remain)];
  }
  return renderTimeline(theme, width, view.running, height);
}

function renderResultSurface(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (!view.result) return [];
  const locale = view.locale ?? 'en';
  const options = {
    ...(view.surfaceScope ? { surfaceScope: view.surfaceScope } : {}),
    ...(view.processExpanded ? { processExpanded: true } : {}),
  };
  const summary = renderResult(theme, width, view.result, locale, view.productLabel, Boolean(view.comparePending), options);
  const expand = view.surfaceScope === 'comparison'
    ? t(locale, 'viewComparisonProcess')
    : t(locale, 'viewCandidateProcess');
  return withProcess(theme, width, summary, view, height, expand);
}

function renderLayoutList(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'running' && view.running) return clipLines(renderTimeline(theme, width, view.running, height), height);
  return clipLines(renderBody(theme, view, width, height), height, view.bodyOffset ?? 0);
}

export function workbenchBodyOrigin(view: WorkbenchView, width: number, height?: number): { header: number; rail: number } {
  const painted = paintFixed(createTheme(width), view, width, height);
  return {
    header: painted.header.length + painted.context.length,
    rail: painted.stage.length + painted.activity.length,
  };
}

function hintsFor(view: WorkbenchView, theme: Theme): readonly (readonly [string, string])[] {
  const locale = view.locale ?? 'en';
  if (view.page === 'home') return homeHints(locale, view.home);
  if (view.page === 'config' && view.config) {
    const fields = configFieldsForKind(view.config.draft.kind);
    return configHints(view.config.editing, fields[view.config.selected], view.config.pendingToggle, view.config.selected >= languageFieldIndex(view.config.draft.kind), locale, Boolean(view.config.leaveConfirm));
  }
  if (view.page === 'history') return historyHints(locale);
  if (view.page === 'history-detail') {
    return historyDetailHints(
      Boolean(view.historyDetail && 'taskCase' in view.historyDetail),
      Boolean(view.historyDetail && !('taskCase' in view.historyDetail) && view.historyDetail.reportPath),
      locale,
    );
  }
  if (view.page === 'sessions') return sessionsHints(view.sessions, locale);
  if (view.page === 'inspection') return inspectionHints(locale);
  if (view.page === 'source') return sourceHints(locale);
  if (view.page === 'candidate-product') return candidateProductHints(locale);
  if (view.page === 'candidate-model') {
    return candidateModelHints(view.candidateModel?.status === 'ready' && Boolean(view.candidateModel.offers.length), locale);
  }
  if (view.page === 'preflight') return view.preflight ? preflightHints(locale) : [['Esc', t(locale, 'hintHome')]];
  if (view.page === 'confirm') return confirmHints(view.confirm ? confirmCanStart(view.confirm) : false, locale);
  if (view.page === 'running' && view.running) {
    const preparing = isRecoveryChrome(view.running) || view.running.preparePhase === 'copy';
    return runningHints(
      view.running.filter,
      theme.density !== 'wide',
      preparing,
      locale,
      Boolean(view.running.finding),
      Boolean(view.running.readingMode),
    );
  }
  if (view.page === 'result') return resultHints(locale, Boolean(view.comparePending));
  if (view.page === 'error') return failureHints(locale);
  return [['b', t(locale, 'hintBack')], ['Ctrl+C', t(locale, 'hintExit')]];
}
