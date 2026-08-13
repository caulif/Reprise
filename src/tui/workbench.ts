import { type Component, HStack, ScrollView, VStack, isViewportTUI, type TUI, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { CodexExperimentResult } from '../application/codex-experiment.js';
import { compact, truncateFit } from './format.js';
import { renderHelp } from './overlays.js';
import { configHints, renderConfig, type ConfigModel } from './pages/config.js';
import { historyDetailHints, historyHints, renderHistory, renderHistoryDetail, type HistoryModel } from './pages/history.js';
import { homeHints, renderHome, type HomeModel } from './pages/home.js';
import { inspectionHints, renderInspection, renderSessions, sessionsHints, type InspectionModel, type SessionsModel } from './pages/intake.js';
import { renderResult, resultHints } from './pages/result.js';
import {
  confirmHints, preflightHints, renderConfirmation, renderPreflight, renderSource, renderTimeline,
  runningChrome, runningDetailPanel, runningHints, runningListPanel, sourceHints,
  type ConfirmModel, type PreflightModel, type RunningModel, type SourceModel,
} from './pages/run.js';
import { createTheme, resolveDensity, type Theme } from './theme.js';
import { bodyHeight, clipLines } from './viewport.js';
import { divider, justify, keyHints, pill } from './widgets.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';

export type WorkbenchPage =
  | 'loading' | 'home' | 'config' | 'history' | 'history-detail' | 'sessions' | 'inspection'
  | 'source' | 'preflight' | 'confirm' | 'running' | 'result' | 'error';

export type WorkbenchView = {
  readonly page: WorkbenchPage;
  readonly cwd: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly hasApiConfig: boolean;
  readonly hasTaskCase: boolean;
  readonly message: string;
  readonly inlineHelp?: boolean;
  readonly home?: HomeModel;
  readonly config?: ConfigModel;
  readonly history?: HistoryModel;
  readonly historyDetail?: HistoryCase | HistoryExperiment;
  readonly sessions?: SessionsModel;
  readonly inspection?: InspectionModel;
  readonly source?: SourceModel;
  readonly preflight?: PreflightModel;
  readonly confirm?: ConfirmModel;
  readonly running?: RunningModel;
  readonly result?: CodexExperimentResult;
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
    const header = new LinesView((width) => renderHeader(createTheme(width), this.#view(), width));
    const rail = new LinesView((width) => {
      const view = this.#view();
      if (view.page !== 'running' || !view.running) return [];
      return runningChrome(createTheme(width), width, view.running);
    });
    const list = new LinesView((width) => renderLayoutList(createTheme(width), this.#view(), width));
    const detail = new LinesView((width) => renderLayoutDetail(createTheme(width), this.#view(), width));
    const body = new HStack([
      { component: new ScrollView(list, { follow: 'end', primary: true, scrollbar: 'auto' }), grow: 1, shrink: 1, minSize: 20 },
      {
        component: new ScrollView(detail, { follow: 'end', scrollbar: 'auto' }),
        grow: 1, shrink: 1, minSize: 16,
        visible: (viewport) => {
          const view = this.#view();
          return view.page === 'running' && resolveDensity(viewport.width) === 'wide';
        },
      },
    ], { gap: 1 });
    const message = new LinesView((width) => renderMessage(createTheme(width), this.#view(), width));
    const footer = new LinesView((width) => renderFooter(createTheme(width), this.#view(), width));
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
  if (resolveDensity(width) === 'minimum') {
    return [
      ...wrapTextWithAnsi('Terminal is too narrow for Reprise.', Math.max(1, width)),
      'Resize to at least 32 columns.',
    ];
  }
  const theme = createTheme(width);
  const header = renderHeader(theme, view, width);
  const message = renderMessage(theme, view, width);
  const available = bodyHeight({ width, ...(height === undefined ? {} : { height }) }, message.length, header.length);
  return [...header, ...clipLines(renderBody(theme, view, width, available), available), ...message, ...renderFooter(theme, view, width)];
}

function modelSummary(theme: Theme, view: WorkbenchView): string {
  if (!view.modelId) return 'No configured model';
  return `${view.modelId} ${theme.glyphs.sep} ${view.effort ?? 'medium'}`;
}

function renderHeader(theme: Theme, view: WorkbenchView, width: number): string[] {
  const brand = 'Reprise v0.1.0';
  const running = view.page === 'running' ? view.running : undefined;
  const status = running
    ? pill(theme, running.cancelling ? 'cancelling' : 'running', running.cancelling ? 'warn' : 'ok')
    : `${pill(theme, view.hasApiConfig ? 'API ready' : 'API not configured', view.hasApiConfig ? 'ok' : 'off')}  ${pill(theme, view.hasTaskCase ? 'TaskCase' : 'No TaskCase', view.hasTaskCase ? 'ok' : 'off')}`;
  const metrics = running
    ? `${running.elapsed}   turn ${running.turns.used}${running.turns.max !== undefined ? `/${running.turns.max}` : ''}   calls ${running.calls.used}${running.calls.max !== undefined ? `/${running.calls.max}` : ''}`
    : modelSummary(theme, view);
  const right = `${metrics}   ${status}`;
  if (theme.density === 'compact') {
    const cwdBudget = Math.max(8, width - visibleWidth(`${brand}   `));
    const left = `${brand}   ${compact(view.cwd, cwdBudget, theme.glyphs.ellipsis)}`;
    return [
      truncateFit(left, width, theme.glyphs.ellipsis),
      truncateFit(right, width, theme.glyphs.ellipsis),
      divider(theme, width),
    ];
  }
  const left = `${brand}   ${compact(view.cwd, 48, theme.glyphs.ellipsis)}`;
  return [justify(theme, left, right, width), divider(theme, width)];
}

function renderMessage(theme: Theme, view: WorkbenchView, width: number): string[] {
  const painted = view.page === 'error' || /error|fail/i.test(view.message)
    ? theme.style.danger(` ${view.message}`)
    : ` ${view.message}`;
  return wrapTextWithAnsi(painted, Math.max(1, width));
}

function renderFooter(theme: Theme, view: WorkbenchView, width: number): string[] {
  return [divider(theme, width), keyHints(theme, hintsFor(view, theme), width)];
}

function renderBody(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  const page = renderPage(theme, view, width, height);
  if (!view.inlineHelp) return page;
  return [...renderHelp(theme, width), '', ...page];
}

function renderPage(theme: Theme, view: WorkbenchView, width: number, height?: number): string[] {
  if (view.page === 'loading' || view.page === 'error') return [];
  if (view.page === 'home' && view.home) return renderHome(theme, width, view.home);
  if (view.page === 'config' && view.config) return renderConfig(theme, width, view.config);
  if (view.page === 'history' && view.history) return renderHistory(theme, width, view.history);
  if (view.page === 'history-detail' && view.historyDetail) return renderHistoryDetail(theme, width, view.historyDetail);
  if (view.page === 'sessions' && view.sessions) return renderSessions(theme, width, view.sessions);
  if (view.page === 'inspection' && view.inspection) return renderInspection(theme, width, view.inspection, height);
  if (view.page === 'source' && view.source) return renderSource(theme, width, view.source);
  if (view.page === 'preflight' && view.preflight) return renderPreflight(theme, width, view.preflight);
  if (view.page === 'confirm' && view.confirm) return renderConfirmation(theme, width, view.confirm);
  if (view.page === 'running' && view.running) return renderTimeline(theme, width, view.running, height);
  if (view.page === 'result' && view.result) return renderResult(theme, width, view.result);
  return [];
}

function renderLayoutList(theme: Theme, view: WorkbenchView, width: number): string[] {
  if (view.page === 'running' && view.running && theme.density === 'wide') {
    return runningListPanel(theme, width, view.running);
  }
  if (view.page === 'running' && view.running) {
    const chrome = runningChrome(theme, width, view.running);
    return renderTimeline(theme, width, view.running).slice(chrome.length);
  }
  return renderBody(theme, view, width, undefined);
}

function renderLayoutDetail(theme: Theme, view: WorkbenchView, width: number): string[] {
  if (view.page === 'running' && view.running && theme.density === 'wide') {
    return runningDetailPanel(theme, width, view.running);
  }
  return [];
}

function hintsFor(view: WorkbenchView, theme: Theme): readonly (readonly [string, string])[] {
  if (view.page === 'home') return homeHints();
  if (view.page === 'config' && view.config) return configHints(view.config.editing);
  if (view.page === 'history') return historyHints();
  if (view.page === 'history-detail') return historyDetailHints(Boolean(view.historyDetail && 'taskCase' in view.historyDetail));
  if (view.page === 'sessions') return sessionsHints(view.sessions);
  if (view.page === 'inspection') return inspectionHints();
  if (view.page === 'source') return sourceHints();
  if (view.page === 'preflight') return preflightHints();
  if (view.page === 'confirm') return confirmHints();
  if (view.page === 'running' && view.running) return runningHints(view.running.filter, theme.density !== 'wide');
  if (view.page === 'result') return resultHints();
  return [['b', 'Back'], ['Ctrl+C', 'Exit']];
}
