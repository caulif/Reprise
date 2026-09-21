import type { TaskCase } from '../../core/schema.js';
import { compact, slashCommands } from '../format.js';
import { commandCatalog, t, type Locale } from '../i18n.js';
import { caretAt } from '../text-edit.js';
import type { HistoryExperiment } from '../local-history.js';
import type { Theme } from '../theme.js';
import { pad, panel } from '../widgets.js';
import { shellEnvAssignment } from '../../infrastructure/harness-model-config.js';
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

export function homeActions(model: HomeModel): readonly HomeActionId[] {
  const needsConfig = !model.hasApiConfig || model.hasUsableAuth === false;
  const actions: HomeActionId[] = needsConfig ? ['config', 'new-replay'] : ['new-replay'];
  if (model.recentExperiment) actions.push('open-recent');
  actions.push('history', 'help');
  if (!needsConfig) actions.push('config');
  return actions;
}

export function defaultHomeFocus(model: HomeModel): HomeActionId {
  return homeActions(model)[0] ?? 'new-replay';
}

export function renderHome(theme: Theme, width: number, model: HomeModel): string[] {
  const locale = model.locale ?? 'en';
  const focus = model.focus ?? defaultHomeFocus(model);
  const actions = homeActions(model);
  const body = [
    ` ${theme.style.harness(t(locale, 'productTagline'))}`,
    '',
    ...actions.flatMap((action) => actionRows(theme, model, locale, action, focus === action)),
    '',
    theme.style.muted(` ${t(locale, 'browse')}`),
    ...internalModelBlock(theme, model, locale),
    ...(model.envName && model.envSet === false ? [` ${shellEnvAssignment(model.envName)}`] : []),
  ];
  const placeholder = t(locale, 'composerHome');
  const prompt = ` ${theme.glyphs.cursor} ${model.composer ? caretAt(model.composer, model.composerCursor ?? model.composer.length) : theme.style.muted(placeholder)}`;
  const suggestions = model.showSuggestions ? renderSuggestions(theme, width, model) : [];
  return [
    ...body,
    ...(suggestions.length ? ['', ...suggestions] : []),
    '',
    prompt,
  ];
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

export function homePointerAction(model: HomeModel, bodyRow: number): HomeActionId | undefined {
  const actions = homeActions(model);
  // tagline + blank = rows 0-1
  let row = 2;
  for (const action of actions) {
    const span = action === 'new-replay' || action === 'open-recent' || action === 'history' || action === 'config' || action === 'help' ? 1 : 1;
    if (bodyRow >= row && bodyRow < row + span) return action;
    row += span;
  }
  return undefined;
}

function actionRows(theme: Theme, model: HomeModel, locale: Locale, action: HomeActionId, selected: boolean): string[] {
  const marker = selected ? theme.glyphs.cursor : ' ';
  if (action === 'new-replay') {
    const line = ` ${marker} ${theme.style.accent(t(locale, 'newReplay'))}  ${t(locale, 'newReplayDesc')}  ${theme.style.muted('/intake')}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'open-recent') {
    const overview = recentOverview(theme, model, locale);
    const line = ` ${marker} ${theme.style.muted(pad(t(locale, 'recentRun'), 12))} ${overview}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'history') {
    const status = model.recentExperiment ? '' : theme.style.muted(t(locale, 'noRecentRuns'));
    const line = ` ${marker} ${theme.style.accent('/history')}  ${t(locale, 'historyDesc')}${status ? `  ${status}` : ''}`;
    return [selected ? theme.style.selected(line) : line];
  }
  if (action === 'config') {
    const needs = !model.hasApiConfig || model.hasUsableAuth === false;
    const status = needs
      ? theme.style.warn(model.envName && model.envSet === false ? t(locale, 'envUnset') : t(locale, 'needsCred'))
      : '';
    const line = ` ${marker} ${theme.style.accent('/config')}   ${t(locale, 'configDesc')}${status ? `  ${status}` : ''}`;
    return [selected ? theme.style.selected(line) : line];
  }
  const line = ` ${marker} ${theme.style.accent('/help')}     ${t(locale, 'helpDesc')}`;
  return [selected ? theme.style.selected(line) : line];
}

function recentOverview(theme: Theme, model: HomeModel, locale: Locale): string {
  const recent = model.recentExperiment;
  if (!recent) return theme.style.muted(t(locale, 'noRecentRuns'));
  const task = compact(
    t(locale, 'recentTaskUnknown', { id: recent.taskCaseId.slice(0, 8) }),
    24,
    theme.glyphs.ellipsis,
  );
  const when = relativeTime(recent.startedAt, Date.now(), locale);
  const result = recentResultLabel(recent, locale);
  return t(locale, 'recentRunOverview', { task, when, result });
}

export function recentResultLabel(recent: HistoryExperiment, locale: Locale = 'en'): string {
  if (recent.formatError) return t(locale, 'resultOverviewUnknown');
  const parts: string[] = [];
  if (recent.taskStatus) parts.push(t(locale, 'resultOverviewCandidate', { status: recent.taskStatus }));
  if (recent.comparisonStatus) {
    parts.push(t(locale, 'resultOverviewComparison', { status: recent.comparisonStatus }));
  } else if (recent.outcome === 'interrupted') {
    parts.push(t(locale, 'resultOverviewInterrupted'));
  } else if (recent.outcome === 'unknown') {
    parts.push(t(locale, 'resultOverviewUnknown'));
  } else if (!recent.taskStatus && recent.outcome) {
    parts.push(t(locale, 'resultOverviewCandidate', { status: recent.outcome }));
  }
  const presentation = deriveResultPresentationFromHistory(recent, locale);
  if (presentation.reportKind === 'diagnostic') parts.push(t(locale, 'resultOverviewDiagnostic'));
  else if (presentation.reportKind === 'report') parts.push(t(locale, 'resultOverviewReport', { kind: 'Report' }));
  if (!parts.length) return t(locale, 'resultOverviewIncomplete');
  return parts.join(' · ');
}

function internalModelBlock(theme: Theme, model: HomeModel, locale: Locale): string[] {
  const label = internalModelLabel(theme, model, locale);
  const header = ` ${theme.style.muted(t(locale, 'internalCollabModel'))}  ${label}`;
  if (!model.modelDetailsExpanded) return [header];
  return [
    header,
    theme.style.muted(`   ${model.providerLabel ?? t(locale, 'noneSelected')} · ${model.modelId ?? t(locale, 'noneSelected')}`),
  ];
}

function internalModelLabel(theme: Theme, model: HomeModel, locale: Locale): string {
  if (model.modelId) return compact(model.modelId, 40, theme.glyphs.ellipsis);
  if (!model.hasApiConfig || model.hasUsableAuth === false) return theme.style.warn(t(locale, 'needsConfig'));
  return t(locale, 'noneSelected');
}

function renderSuggestions(theme: Theme, width: number, model: HomeModel): string[] {
  const locale = model.locale ?? 'en';
  const matches = commandCatalog(locale).filter((item) => item.command.startsWith(model.composer.toLowerCase())
    || slashCommands().some((command) => command.startsWith(model.composer.toLowerCase()) && command === item.command));
  const lines = matches.map((item, index) => ` ${index === 0 ? theme.glyphs.cursor : ' '} ${pad(item.command, 10)} ${item.description}`);
  return panel(theme, t(locale, 'commands'), lines.length ? lines : [` ${t(locale, 'noMatch')}`], Math.min(width, 72));
}
