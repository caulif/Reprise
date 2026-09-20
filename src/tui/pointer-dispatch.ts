import { dirname } from 'node:path';
import { createTheme } from './theme.js';
import { selectedIndexAfterFold } from './fold-process.js';
import { projectTimelineView } from './timeline-view.js';
import { hitFileLink } from './format.js';
import { dispatchHomeComposer, dispatchListPointer, parseSgrMouse, type Consume } from './page-input.js';
import { homePointerAction } from './pages/home.js';
import { historyDetailPointerAction, renderHistoryDetail } from './pages/history.js';
import { resolveResultPathLinks } from '../application/result-paths.js';
import { resultPointerAction, renderResultWithHits } from './pages/result.js';
import { hitAtBodyRow, keepSelectedVisible, layoutScrollback } from './scrollback.js';
import { timelineIdentity } from './timeline-read.js';
import { bodyCellAt } from './workbench-layout.js';
import { measureWorkbenchGeometry } from './workbench.js';
import type { ControllerHandle } from './controller-input.js';
import { resolveCompareChoice } from './controller-run.js';

export function consumeWheel(data: string): Consume | undefined {
  return dispatchListPointer(data) ? { consume: true } : undefined;
}

type ViewportPointerHost = {
  handleViewportInput?: (data: string) => { consume?: true } | undefined;
};

/** pi-tui registers `handleViewportInput` first and consumes SGR; yield wheel/click to the app. */
export function yieldPointerToApp(host: object): void {
  const target = host as ViewportPointerHost;
  const inner = target.handleViewportInput;
  if (typeof inner !== 'function') return;
  target.handleViewportInput = (data: string) => {
    if (isAppOwnedPointer(data)) return undefined;
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
    c.timelineReadOffset = Math.max(0, (c.timelineReadOffset ?? 0) + (pointer.action === 'up' ? -1 : 1));
    c.render();
    return { consume: true };
  }
  if (pointer.action !== 'click' || pointer.row === undefined || pointer.col === undefined) return { consume: true };
  if (!c.result) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col);
  if (!cell) return { consume: true };
  const { lines, rowHits } = renderResultWithHits(createTheme(cell.width), cell.width, c.result, c.locale, undefined, Boolean(c.compareChoice));
  const bodyRow = cell.bodyRow + (c.timelineReadOffset ?? 0);
  const line = lines[bodyRow];
  const href = line ? hitFileLink(line, cell.col) : undefined;
  const paths = resolveResultPathLinks(c.result);
  const action = resultPointerAction(lines, bodyRow, cell.col, c.locale, paths, rowHits);
  if (action === 'compare') {
    resolveCompareChoice(c, true);
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
  return { consume: true };
}

export function applyHomePointer(c: ControllerHandle, data: string): Consume | undefined {
  const pointer = dispatchListPointer(data);
  if (!pointer) return undefined;
  if (pointer.action === 'up' || pointer.action === 'down') {
    if (c.showSuggestions) {
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
    }
    return { consume: true };
  }
  if (pointer.action !== 'click' || pointer.row === undefined) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col ?? 1);
  if (!cell) return { consume: true };
  if (homePointerAction({
    taskCase: c.taskCase,
    recentExperiment: c.recentExperiment,
    hasApiConfig: true,
    composer: c.composer,
    showSuggestions: c.showSuggestions,
    locale: c.locale,
  }, cell.bodyRow) === 'open-recent') {
    return c.openRecentExperiment();
  }
  return { consume: true };
}

export function applyHistoryDetailPointer(c: ControllerHandle, data: string): Consume | undefined {
  const pointer = dispatchListPointer(data);
  if (!pointer) return undefined;
  if (pointer.action === 'up' || pointer.action === 'down') return undefined;
  if (pointer.action !== 'click' || pointer.row === undefined || pointer.col === undefined) return { consume: true };
  if (!c.historyDetail) return { consume: true };
  const cell = pointerBodyCell(c, pointer.row, pointer.col);
  if (!cell) return { consume: true };
  const lines = renderHistoryDetail(createTheme(cell.width), cell.width, c.historyDetail, c.locale);
  const action = historyDetailPointerAction(lines, cell.bodyRow, cell.col);
  if (action === 'open-report' && !('taskCase' in c.historyDetail)) {
    return c.openReport(c.historyDetail.path, c.historyDetail.reportPath);
  }
  if (action === 'open-local') return c.openLocal(c.historyDetail.path);
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
  if (c.readingMode && Math.abs(amount) >= 10) {
    c.timelineReadOffset = Math.max(0, (c.timelineReadOffset ?? 0) + amount);
    c.timelineFollowing = false;
    c.render();
    return { consume: true };
  }
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
