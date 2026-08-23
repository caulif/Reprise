import type { TaskCase } from '../../core/schema.js';
import { compact, slashCommands } from '../format.js';
import { commandCatalog, t, type Locale } from '../i18n.js';
import { caretAt } from '../text-edit.js';
import type { HistoryExperiment } from '../local-history.js';
import { sessionTitle } from './intake.js';
import type { Theme } from '../theme.js';
import { pad, panel } from '../widgets.js';
import { shellEnvAssignment } from '../../infrastructure/harness-model-config.js';

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
};

export function renderHome(theme: Theme, width: number, model: HomeModel): string[] {
  const locale = model.locale ?? 'en';
  const taskLabel = model.taskCase
    ? compact(`${sessionTitle(model.taskCase.initialInput.text)}${frozenStart(model.taskCase)}`, 56, theme.glyphs.ellipsis)
    : t(locale, 'noneSelected');
  const continueRows = continueLines(theme, model, locale);
  const browseRows = [
    ` ${theme.style.accent('/intake')}    ${t(locale, 'intakeDesc')}`,
    ` ${theme.style.accent('/history')}   ${t(locale, 'historyDesc')}`,
    ` ${theme.style.accent('/config')}    ${t(locale, 'configDesc')}`,
    ` ${theme.style.accent('/lang')}      ${t(locale, 'langDesc')}`,
  ];
  const body = [
    theme.style.muted(` ${t(locale, 'lastCase')}  ${taskLabel}`),
    '',
    theme.style.muted(` ${t(locale, 'continue')}`),
    ...continueRows,
    '',
    theme.style.muted(` ${t(locale, 'browse')}`),
    ...browseRows,
    '',
    ` ${nextLine(theme, locale, model)}`,
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
      ['Tab', t(locale, 'hintTab')],
      ['Enter', t(locale, 'hintEnter')],
      ['Esc', t(locale, 'hintEsc')],
      ['?', t(locale, 'hintKeys')],
    ];
  }
  const enter = model?.recentExperiment ? t(locale, 'hintContinue') : t(locale, 'hintEnter');
  return [
    ['Enter', enter],
    ['r', t(locale, 'hintRun')],
    ['i', t(locale, 'hintImport')],
    ['?', t(locale, 'hintKeys')],
    ['Ctrl+C', t(locale, 'hintExit')],
  ];
}

function continueLines(theme: Theme, model: HomeModel, locale: Locale): string[] {
  const rows: string[] = [];
  if (model.recentExperiment) {
    const title = compact(model.recentExperiment.outcome ?? t(locale, 'recentRun'), 36, theme.glyphs.ellipsis);
    rows.push(row(theme, 'Enter', t(locale, 'recentRun'), title));
  }
  rows.push(row(theme, 'r', t(locale, 'runCurrent'), runReadiness(theme, model, locale)));
  rows.push(row(theme, 'i', t(locale, 'importSession'), ''));
  if (!model.hasApiConfig || model.hasUsableAuth === false) {
    const status = model.envName && model.envSet === false
      ? t(locale, 'envUnset')
      : t(locale, 'needsCred');
    rows.push(row(theme, 'c', t(locale, 'openConfig'), theme.style.warn(status)));
  }
  return rows;
}

function row(theme: Theme, key: string, description: string, status: string): string {
  const left = ` ${theme.style.muted(pad(key, 5))} ${description}`;
  return status ? `${left}  ${status}` : left;
}

function runReadiness(theme: Theme, model: HomeModel, locale: Locale): string {
  if (!model.taskCase) return theme.style.warn(t(locale, 'needsTask'));
  if (!model.hasApiConfig) return theme.style.warn(t(locale, 'needsConfig'));
  if (model.envName && model.envSet === false) return theme.style.warn(t(locale, 'needsEnv'));
  if (model.hasUsableAuth === false) return theme.style.warn(t(locale, 'needsCred'));
  return theme.style.ok(t(locale, 'sourceReady'));
}

function nextLine(theme: Theme, locale: Locale, model: HomeModel): string {
  if (!model.hasApiConfig) return theme.style.warn(t(locale, 'nextConfig'));
  if (model.envName && model.envSet === false) return theme.style.warn(t(locale, 'nextSetEnv', { name: model.envName }));
  if (model.hasUsableAuth === false) return theme.style.warn(t(locale, 'nextSetCred'));
  if (!model.taskCase) return t(locale, 'nextIntake');
  return t(locale, 'nextRun');
}

function renderSuggestions(theme: Theme, width: number, model: HomeModel): string[] {
  const locale = model.locale ?? 'en';
  const matches = commandCatalog(locale).filter((item) => item.command.startsWith(model.composer.toLowerCase())
    || slashCommands().some((command) => command.startsWith(model.composer.toLowerCase()) && command === item.command));
  const lines = matches.map((item, index) => ` ${index === 0 ? theme.glyphs.cursor : ' '} ${pad(item.command, 10)} ${item.description}`);
  return panel(theme, t(locale, 'commands'), lines.length ? lines : [` ${t(locale, 'noMatch')}`], Math.min(width, 72));
}

function frozenStart(taskCase: TaskCase): string {
  const users = taskCase.transcript.filter((message) => message.role === 'user');
  if (users.length < 2) return '';
  return ` · ${users.length} turns`;
}
