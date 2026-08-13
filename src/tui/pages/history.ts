import { compact, missing } from '../format.js';
import type { HistoryCase, HistoryExperiment } from '../local-history.js';
import type { Theme } from '../theme.js';
import { kv, panel } from '../widgets.js';

export type HistoryModel = {
  readonly tab: 'runs' | 'cases';
  readonly items: readonly (HistoryCase | HistoryExperiment)[];
  readonly selected: number;
};

export function renderHistory(theme: Theme, width: number, model: HistoryModel): string[] {
  const label = model.tab === 'runs' ? 'Recent experiments' : 'TaskCases';
  if (!model.items.length) return panel(theme, label, [` No local ${model.tab === 'runs' ? 'experiments' : 'TaskCases'} yet.`], width);
  const rows = model.items.flatMap((item, index) => {
    const marker = index === model.selected ? theme.glyphs.cursor : ' ';
    if ('taskCase' in item) {
      return [
        ` ${marker} ${item.taskCase.caseId} ${theme.glyphs.sep} ${compact(item.taskCase.initialInput.text, 62, theme.glyphs.ellipsis)}`,
        `     imported ${item.taskCase.provenance.importedAt}`,
      ];
    }
    return [
      ` ${marker} ${item.experimentId} ${theme.glyphs.sep} ${item.outcome ?? 'incomplete'}`,
      `     TaskCase ${item.taskCaseId} ${theme.glyphs.sep} ${item.startedAt ?? 'time unavailable'}`,
    ];
  });
  return panel(theme, label, rows, width);
}

export function renderHistoryDetail(theme: Theme, width: number, item: HistoryCase | HistoryExperiment): string[] {
  if ('taskCase' in item) {
    return panel(theme, 'TaskCase', [
      ` TaskCase: ${item.taskCase.caseId}`,
      kv(theme, 'Task', compact(item.taskCase.initialInput.text, 500, theme.glyphs.ellipsis), width - 2),
      kv(theme, 'Source', `${item.taskCase.source.productId} ${theme.glyphs.sep} ${item.taskCase.source.sessionId}`, width - 2),
      kv(theme, 'Frozen', item.taskCase.provenance.importedAt, width - 2),
      kv(theme, 'Path', item.path, width - 2),
    ], width);
  }
  return panel(theme, 'Experiment', [
    kv(theme, 'ID', item.experimentId, width - 2),
    kv(theme, 'TaskCase', item.taskCaseId, width - 2),
    kv(theme, 'Run', missing(item.runId), width - 2),
    kv(theme, 'Outcome', item.outcome ?? 'incomplete or no record', width - 2),
    kv(theme, 'Started', item.startedAt ?? 'unavailable', width - 2),
    kv(theme, 'Report', item.reportPath ?? 'not generated', width - 2),
    kv(theme, 'Path', item.path, width - 2),
  ], width);
}

export function historyHints(): readonly (readonly [string, string])[] {
  return [['Tab', 'Runs/TaskCases'], ['↑↓', 'Select'], ['Enter', 'Detail'], ['Esc', 'Home']];
}

export function historyDetailHints(isCase: boolean): readonly (readonly [string, string])[] {
  return isCase ? [['Enter', 'Use this TaskCase'], ['Esc', 'Back']] : [['Esc', 'Back']];
}
