import { dirname } from 'node:path';
import { createTheme } from './theme.js';
import { selectedIndexAfterFold } from './fold-process.js';
import { projectTimelineView } from './timeline-view.js';
import { hitFileLink } from './format.js';
import { artifactsFromResult, isActionEnabled, listActions } from './action-model.js';
import { t } from './i18n.js';
import { dispatchHomeComposer, dispatchListPointer, parseSgrMouse, type Consume } from './page-input.js';
import { homeActions, homePointerAction } from './pages/home.js';
import { historyDetailPointerAction, renderHistoryDetailWithHits } from './pages/history.js';
import { resolveResultPathLinks } from '../application/result-paths.js';
import { resultPointerAction, renderResultWithHits } from './pages/result.js';
import { hitAtBodyRow, keepSelectedVisible, layoutScrollback } from './scrollback.js';
import { timelineIdentity } from './timeline-read.js';
import { bodyCellAt } from './workbench-layout.js';
import { measureWorkbenchGeometry, pageTheme, resultRenderOptions } from './workbench.js';
import { resolveCompareChoice } from './controller-run.js';
import { scrollPageBody } from './controller-scroll.js';
import type { ControllerHandle } from './controller-input.js';

export function consumeWheel(data: string): Consume | undefined {
  return dispatchListPointer(data) ? { consume: true } : undefined;
}

type ViewportPointerHost = {
  handleViewportInput?: (data: string) => { consume?: true } | undefined;
};

/** The first listener must receive selection presses; later listeners cannot replay a skipped press. */
export function yieldPointerToApp(host: object, selectionOwnsPointer: () => boolean = () => false): void {
  const target = host as ViewportPointerHost;
  const inner = target.handleViewportInput;
  if (typeof inner !== 'function') return;
  target.handleViewportInput = (data: string) => {
    if (!selectionOwnsPointer() && isAppOwnedPointer(data)) return undefined;
    return inner.call(target, data);
  };
}

function isAppOwnedPointer(data: string): boolean {
  const mouse = parseSgrMouse(data);
  if (!mouse) return isX10Wheel(data);
  return mouse.button === 64 || mouse.button === 65 || (mouse.button === 0 && !mouse.release);
}

function isX10Wheel(data: string): boolean {
  if (data.length !== 6 || !data.startsWith('\x1b[M')) return false;
  return ((data.charCodeAt(3) - 32) & 64) !== 0;
}

export function applyResultPointer(c: ControllerHandle, data: string): Consume | undefined {
  const pointer = dispatchListPointer(data);
  if (!pointer) return undefined;
  if (pointer.action === 'up' || pointer.action === 'down') {
    return scrollPageBody(c, pointer.action === 'up' ? '\x1b[A' : '\x1b[B', 'result');
  }
  if (pointer.action !== 'click' || pointer.row === undefined || pointer.col === undefined) return { consume: true };
  if (!c.result) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col);
  if (!cell) return { consume: true };
  if (cell.bodyRow < 0) return { consume: true };
  const view = c.view();
  const { lines, rowHits } = renderResultWithHits(
    pageTheme(createTheme(cell.width), 'result'), cell.width, c.result, c.locale, view.productLabel, Boolean(c.compareChoice),
    resultRenderOptions(view),
  );
  const bodyRow = cell.bodyRow + (c.timelineReadOffset ?? 0);
  const line = lines[bodyRow];
  const href = line ? hitFileLink(line, cell.col) : undefined;
  const paths = resolveResultPathLinks(c.result);
  const action = resultPointerAction(lines, bodyRow, cell.col, c.locale, paths, rowHits);
  if (!action) return { consume: true };
  const artifacts = artifactsFromResult(c.result);
  const actions = listActions({
    page: 'result',
    locale: c.locale,
    mode: { comparePending: Boolean(c.compareChoice), processAvailable: c.timeline.length > 0 },
    artifacts,
  });
  if (!isActionEnabled(actions, action)) {
    const reason = actions.find((item) => item.id === action)?.disabledReasonKey;
    if (reason) {
      c.message = t(c.locale, reason);
      c.render();
    }
    return { consume: true };
  }
  if (action === 'compare') {
    c.resultAction = 'compare';
    c.page = 'compare-confirm';
    c.timelineReadOffset = 0;
    c.render(true);
    return { consume: true };
  }
  if (action === 'open-report') {
    if (!paths.report) return { consume: true };
    return c.openReport(c.result.experimentRoot ?? dirname(paths.report), paths.report);
  }
  if (action === 'open-history-final') return c.openResultArtifactHref(href, 'history');
  if (action === 'open-candidate-final') return c.openResultArtifactHref(href, 'candidate');
  if (action === 'open-trace') return c.openTrace();
  if (action === 'open-replica') return c.openReplica();
  if (action === 'view-process') { c.processExpanded = true; c.timelineReadOffset = 0; c.render(true); return { consume: true }; }
  if (action === 'toggle-details') { c.resultDetails = !c.resultDetails; c.render(true); return { consume: true }; }
  if (action === 'home') {
    if (c.compareChoice) resolveCompareChoice(c, false);
    return c.backToHome();
  }
  return { consume: true };
}

export function applyHomePointer(c: ControllerHandle, data: string): Consume | undefined {
  const pointer = dispatchListPointer(data);
  if (!pointer) return undefined;
  if (pointer.action === 'up' || pointer.action === 'down') {
    if (c.showSuggestions || c.composer.startsWith('/')) {
      const cycled = dispatchHomeComposer({
        composer: c.composer,
        cursor: c.composerCursor,
        showSuggestions: true,
      }, pointer.action === 'up' ? '\x1b[A' : '\x1b[B');
      if (cycled) {
        c.composer = cycled.state.composer;
        c.composerCursor = cycled.state.cursor;
        c.showSuggestions = cycled.state.showSuggestions;
        c.syncCommandOverlay();
        c.render();
      }
      return { consume: true };
    }
    const model = {
      taskCase: c.taskCase,
      recentExperiment: c.recentExperiment,
      hasApiConfig: c.hasSavedModelConfig,
      hasUsableAuth: c.hasSavedModelConfig && c.harnessAuthOk,
      composer: c.composer,
      showSuggestions: c.showSuggestions,
      locale: c.locale,
      focus: c.homeFocus,
    };
    const actions = homeActions(model);
    if (actions.length) {
      const current = Math.max(0, actions.indexOf(c.homeFocus));
      const next = (current + (pointer.action === 'up' ? -1 : 1) + actions.length) % actions.length;
      c.homeFocus = actions[next] ?? 'new-replay';
      c.render();
    }
    return { consume: true };
  }
  if (pointer.action !== 'click' || pointer.row === undefined) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col ?? 1);
  if (!cell) return { consume: true };
  const action = homePointerAction({
    taskCase: c.taskCase,
    recentExperiment: c.recentExperiment,
    hasApiConfig: c.hasSavedModelConfig,
    hasUsableAuth: c.hasSavedModelConfig && c.harnessAuthOk,
    composer: c.composer,
    showSuggestions: c.showSuggestions,
    locale: c.locale,
    focus: c.homeFocus,
  }, cell.bodyRow, cell.width);
  if (!action) return { consume: true };
  c.homeFocus = action;
  if (action === 'open-recent') return c.openRecentExperiment();
  if (action === 'new-replay') {
    c.message = t(c.locale, 'discoveringSessions');
    c.render();
    void c.loadSessions();
    return { consume: true };
  }
  if (action === 'history') {
    c.message = t(c.locale, 'readingHistory');
    c.render();
    void c.loadHistory();
    return { consume: true };
  }
  if (action === 'config') {
    void c.openConfig();
    return { consume: true };
  }
  c.message = `${t(c.locale, 'helpCommands')}.`;
  c.render();
  return { consume: true };
}

export function applyHistoryDetailPointer(c: ControllerHandle, data: string): Consume | undefined {
  const pointer = dispatchListPointer(data);
  if (!pointer) return undefined;
  if (pointer.action === 'up' || pointer.action === 'down') return c.processExpanded ? undefined : scrollPageBody(c, pointer.action === 'up' ? '\x1b[A' : '\x1b[B', 'history-detail');
  if (pointer.action !== 'click' || pointer.row === undefined || pointer.col === undefined) return { consume: true };
  if (!c.historyDetail) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col);
  if (!cell) return { consume: true };
  const detailWidth = cell.width;
  const detailCol = cell.col;
  const detailRender = renderHistoryDetailWithHits(pageTheme(createTheme(detailWidth), 'history-detail'), detailWidth, c.historyDetail, c.locale);
  const detail = c.historyDetail;
  const action = historyDetailPointerAction(
    detailRender.lines,
    cell.bodyRow + (c.timelineReadOffset ?? 0),
    detailCol,
    'taskCase' in detail ? undefined : detail,
    detailRender.rowHits,
  );
  if (action?.action === 'open-report' && !('taskCase' in detail)) {
    return c.openReport(detail.path, action.reportPath);
  }
  if (action?.action === 'open-local') return c.openLocal(detail.path);
  return undefined;
}

export function clickCanvasAt(c: ControllerHandle, terminalRow: number): Consume {
  const cell = pointerBodyCell(c, terminalRow, 1);
  if (!cell) return { consume: true };
  const visible = c.visibleTimeline();
  const folded = projectTimelineView(c.timeline, visible, new Set(c.expandedFolds), c.timelineRevision);
  const selected = selectedIndexAfterFold(visible, folded, visible[c.timelineSelected] ?? c.timeline[c.timelineSelected]);
  const window = canvasWindow(c);
  const layout = layoutScrollback(createTheme(window.width), window.width, folded, selected, c.locale, 'product', window.height, 0, c.timelineReadOffset ?? 0, '00:00', c.timelineFollowing, c.timelineRevision);
  // Live status / follow chrome sits in the body allocation but is not a hit target.
  const contentRows = Math.max(0, window.height - layout.chrome);
  if (cell.bodyRow >= contentRows) return { consume: true };
  if (cell.bodyRow < 0) return { consume: true };
  const hit = hitAtBodyRow(layout.hits, cell.bodyRow);
  if (hit?.fold && hit.itemId) {
    c.expandedFolds = c.expandedFolds.includes(hit.itemId)
      ? c.expandedFolds.filter((id) => id !== hit.itemId)
      : [...c.expandedFolds, hit.itemId];
  }
  const target = hit ? folded[hit.index] : undefined;
  if (target) {
    const identity = timelineIdentity(target);
    const raw = visible.findIndex((entry) => timelineIdentity(entry) === identity);
    c.timelineSelected = raw >= 0 ? raw : Math.min(hit?.index ?? 0, Math.max(0, visible.length - 1));
    c.timelineAnchor = identity;
    c.timelineFollowing = false;
  }
  c.render();
  return { consume: true };
}

export function moveTimelineVisible(c: ControllerHandle, amount: number): Consume {
  const entries = c.visibleTimeline();
  const next = Math.max(0, Math.min(Math.max(0, entries.length - 1), c.timelineSelected + amount));
  const window = canvasWindow(c);
  const folded = projectTimelineView(c.timeline, entries, new Set(c.expandedFolds), c.timelineRevision);
  const selectedFolded = selectedIndexAfterFold(entries, folded, entries[next] ?? entries[c.timelineSelected]);
  const layout = layoutScrollback(createTheme(window.width), window.width, folded, selectedFolded, c.locale, 'product', window.height, 0, c.timelineReadOffset ?? 0, '00:00', c.timelineFollowing, c.timelineRevision);
  c.timelineReadOffset = keepSelectedVisible(layout.selectedAt, c.timelineReadOffset ?? 0, layout.total, Math.max(1, window.height - layout.chrome));
  c.timelineSelected = next;
  c.timelineFollowing = c.timelineSelected === Math.max(0, entries.length - 1);
  const current = entries[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  c.render();
  return { consume: true };
}

function pointerBodyCell(c: ControllerHandle, terminalRow: number, terminalCol: number): { bodyRow: number; col: number; width: number } | undefined {
  const width = c.columns();
  const height = c.viewport().height ?? 24;
  const geometry = measureWorkbenchGeometry(c.view(), width, height);
  const cell = bodyCellAt(geometry, terminalRow, terminalCol);
  if (!cell) return undefined;
  return { bodyRow: cell.bodyRow, col: cell.col, width };
}

function canvasWindow(c: ControllerHandle): { width: number; height: number } {
  const width = c.columns();
  const height = c.viewport().height ?? 24;
  const geometry = measureWorkbenchGeometry(c.view(), width, height);
  return { width, height: Math.max(1, geometry.body.height) };
}
