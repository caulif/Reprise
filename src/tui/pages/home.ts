import type { TaskCase } from '../../core/schema.js';
import { compact, slashCommands } from '../format.js';
import { commandCatalog, t, type Locale } from '../i18n.js';
import { caretAt } from '../text-edit.js';
import type { HistoryExperiment } from '../local-history.js';
import type { Theme } from '../theme.js';
import { pad, panel } from '../widgets.js';
import { createTheme } from '../theme.js';
import { relativeTime } from './intake.js';
import { deriveResultPresentationFromHistory } from '../display-state.js';

export type HomeActionId = 'new-replay' | 'open-recent' | 'history' | 'config' | 'help';

export type HomeModel = {
  readonly taskCase: TaskCase | undefined;
  readonly recentExperiment: HistoryExperiment | undefined;
  readonly hasApiConfig: boolean;
  readonly hasUsableAuth?: boolean;
  readonly envName?: string;
  readonly envSet?: boolean;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly composer: string;
  readonly composerCursor?: number;
  readonly showSuggestions: boolean;
  readonly locale?: Locale;
  readonly recoveryFailed?: boolean;
  readonly focus?: HomeActionId;
  readonly modelDetailsExpanded?: boolean;
};

export function homeActions(_model: HomeModel): readonly HomeActionId[] {
  return ['new-replay', 'history', 'config'];
}

export function defaultHomeFocus(model: HomeModel): HomeActionId {
  return homeActions(model)[0] ?? 'new-replay';
}

export function renderHome(theme: Theme, width: number, model: HomeModel): string[] {
  return renderHomeWithHits(theme, width, model).lines;
}

function renderHomeWithHits(theme: Theme, width: number, model: HomeModel): { lines: string[]; rowHits: ReadonlyMap<number, HomeActionId> } {
  const locale = model.locale ?? 'en';
  const focus = model.focus ?? defaultHomeFocus(model);
  const actions = homeActions(model);
  const lines = [
    ` ${theme.style.harness(t(locale, 'productTagline'))}`,
    '',
  ];
  const rowHits = new Map<number, HomeActionId>();
  for (const action of actions) {
    const rows = actionRows(theme, model, locale, action, focus === action);
    for (let index = 0; index < rows.length; index += 1) rowHits.set(lines.length + index, action);
    lines.push(...rows);
  }
  if (model.recentExperiment) lines.push('', theme.style.muted(` ${t(locale, 'recentRun')}: ${recentOverview(theme, model, locale)}`));
  const suggestions = model.showSuggestions ? renderSuggestions(theme, width, model) : [];
  if (suggestions.length) lines.push('', ...suggestions);
  if (model.composer || model.showSuggestions) lines.push('', ` ${theme.glyphs.cursor} ${caretAt(model.composer, model.composerCursor ?? model.composer.length)}`);
  return { lines, rowHits };
}

export function homeHints(locale: Locale = 'en', model?: HomeModel): readonly (readonly [string, string])[] {
  if (model?.composer.startsWith('/')) {
    return [
      ['↑↓', t(locale, 'hintSelect')],
      ['Tab', t(locale, 'hintTab')],
      ['Enter', t(locale, 'hintEnter')],
      ['Esc', t(locale, 'hintEsc')],
    ];
  }
  return [
    ['↑↓', t(locale, 'hintHomeSelect')],
    ['Enter', t(locale, 'hintActivate')],
    ['/', t(locale, 'hintCommand')],
    ['Ctrl+C', t(locale, 'hintExit')],
  ];
}

export function homePointerAction(model: HomeModel, bodyRow: number, width = 120): HomeActionId | undefined {
  const rows = renderHomeWithHits(createTheme(width), width, model).rowHits;
  return rows.get(bodyRow);
}

function actionRows(theme: Theme, model: HomeModel, locale: Locale, action: HomeActionId, selected: boolean): string[] {
  const marker = selected ? theme.glyphs.cursor : ' ';
  if (action === 'new-replay') {
    const line = ` ${marker} ${theme.style.accent(pad(t(locale, 'newReplay'), 20))} ${theme.style.muted('/intake')}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'open-recent') {
    const overview = recentOverview(theme, model, locale);
    const line = ` ${marker} ${theme.style.muted(pad(t(locale, 'recentRun'), 12))} ${overview}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'history') {
    const status = model.recentExperiment ? '' : theme.style.muted(t(locale, 'noRecentRuns'));
    const line = ` ${marker} ${theme.style.accent(pad(t(locale, 'historyDesc'), 20))} ${theme.style.muted('/history')}${status ? `  ${status}` : ''}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'config') {
    const needs = !model.hasApiConfig || model.hasUsableAuth === false;
    const status = needs
      ? theme.style.warn(model.envName && model.envSet === false ? t(locale, 'envUnset') : t(locale, 'needsCred'))
      : '';
    const line = ` ${marker} ${theme.style.accent(pad(t(locale, 'configDesc'), 20))} ${theme.style.muted('/config')}${status ? `  ${status}` : ''}`;
    return [selected ? theme.style.selected(line) : line];
  }
  const line = ` ${marker} ${theme.style.accent('/help')}     ${t(locale, 'helpDesc')}`;
  return [selected ? theme.style.selected(line) : line];
}

function recentOverview(theme: Theme, model: HomeModel, locale: Locale): string {
  const recent = model.recentExperiment;
  if (!recent) return theme.style.muted(t(locale, 'noRecentRuns'));
  const task = compact(
    recent.taskTitle ?? t(locale, 'recentTaskUnknown', { id: recent.taskCaseId.slice(0, 8) }),
    24,
    theme.glyphs.ellipsis,
  );
  const when = relativeTime(recent.startedAt, Date.now(), locale);
  const result = recentResultLabel(recent, locale);
  return t(locale, 'recentRunOverview', { task, when, result });
}

export function recentResultLabel(recent: HistoryExperiment, locale: Locale = 'en'): string {
  if (recent.formatError) return t(locale, 'resultOverviewUnknown');
  const presentation = deriveResultPresentationFromHistory(recent, locale);
  return t(locale, presentation.statusLabelKey);
}

function renderSuggestions(theme: Theme, width: number, model: HomeModel): string[] {
  const locale = model.locale ?? 'en';
  const matches = commandCatalog(locale).filter((item) => item.command.startsWith(model.composer.toLowerCase())
    || slashCommands().some((command) => command.startsWith(model.composer.toLowerCase()) && command === item.command));
  const lines = matches.map((item, index) => ` ${index === 0 ? theme.glyphs.cursor : ' '} ${pad(item.command, 10)} ${item.description}`);
  return panel(theme, t(locale, 'commands'), lines.length ? lines : [` ${t(locale, 'noMatch')}`], Math.min(width, 72));
}
