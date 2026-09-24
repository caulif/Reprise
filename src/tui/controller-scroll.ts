import { matchesKey } from '@earendil-works/pi-tui';
import type { ControllerHandle, Consume } from './controller-input.js';
import { renderConfirmation } from './pages/run.js';
import { renderResultWithHits } from './pages/result.js';
import { renderHistoryDetail } from './pages/history.js';
import { createTheme } from './theme.js';
import { measureWorkbenchGeometry, pageTheme, resultRenderOptions } from './workbench.js';
import { artifactsFromResult, listActions } from './action-model.js';

export function scrollPageBody(c: ControllerHandle, data: string, page: 'confirm' | 'result' | 'history-detail'): Consume {
  const view = c.view();
  const width = c.columns();
  const height = c.viewport().height ?? 24;
  const bodyHeight = measureWorkbenchGeometry(view, width, height).body.height;
  const theme = pageTheme(createTheme(width), page);
  const length = page === 'confirm' && view.confirm
    ? renderConfirmation(theme, width, view.confirm).length
    : page === 'result' && c.result
      ? renderResultWithHits(theme, width, c.result, c.locale, view.productLabel, Boolean(c.compareChoice), resultRenderOptions(view)).lines.length
      : page === 'history-detail' && view.historyDetail
        ? renderHistoryDetail(theme, width, view.historyDetail, c.locale).length + (view.running?.entries.length ? 3 : 0)
        : 0;
  const max = Math.max(0, length - bodyHeight);
  const step = matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown') ? Math.max(1, bodyHeight - 2) : 1;
  const direction = matchesKey(data, 'up') || matchesKey(data, 'pageUp') ? -1 : 1;
  c.timelineReadOffset = Math.min(max, Math.max(0, c.timelineReadOffset + direction * step));
  c.render();
  return { consume: true };
}

export function ensureResultSelectionVisible(c: ControllerHandle): void {
  if (!c.result) return;
  const view = c.view();
  const width = c.columns();
  const height = c.viewport().height ?? 24;
  const bodyHeight = measureWorkbenchGeometry(view, width, height).body.height;
  const rendered = renderResultWithHits(pageTheme(createTheme(width), 'result'), width, c.result, c.locale, view.productLabel, Boolean(c.compareChoice), resultRenderOptions(view));
  const row = [...rendered.rowHits].find(([, hits]) => hits.some((hit) => hit.action === c.resultAction))?.[0];
  if (row === undefined) return;
  if (row < c.timelineReadOffset) c.timelineReadOffset = row;
  if (row >= c.timelineReadOffset + bodyHeight) c.timelineReadOffset = row - bodyHeight + 1;
}

export function resultChoices(c: ControllerHandle): import('./page-input.js').ResultAction[] {
  return listActions({
    page: 'result', locale: c.locale,
    mode: { comparePending: Boolean(c.compareChoice), processAvailable: c.timeline.length > 0 },
    artifacts: artifactsFromResult(c.result),
  }).filter((action) => action.enabled && action.id !== 'activate-primary' && action.id !== 'show-help')
    .map((action) => action.id as import('./page-input.js').ResultAction);
}
