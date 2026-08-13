import type { TaskCase } from '../../core/schema.js';
import { compact, slashCommands } from '../format.js';
import type { HistoryExperiment } from '../local-history.js';
import { projectLabel, sessionTitle } from './intake.js';
import type { Theme } from '../theme.js';
import { joinColumns, panel } from '../widgets.js';

export type HomeModel = {
  readonly taskCase: TaskCase | undefined;
  readonly recentExperiment: HistoryExperiment | undefined;
  readonly hasApiConfig: boolean;
  readonly composer: string;
  readonly showSuggestions: boolean;
};

export function renderHome(theme: Theme, width: number, model: HomeModel): string[] {
  const commands = [
    commandLine('/config', 'Configure the API connection', model.hasApiConfig ? theme.style.ok(theme.glyphs.ok) : ''),
    commandLine('/intake', 'Import a Codex historical session', ''),
    commandLine('/run', 'Run the current TaskCase', runReadiness(theme, model)),
    commandLine('/history', 'Browse local TaskCases and experiments', ''),
  ];
  const vacant = theme.framed ? '—' : '-';
  const taskLabel = model.taskCase
    ? compact(`${sessionTitle(model.taskCase.initialInput.text)}${frozenStart(model.taskCase)}`, 42, theme.glyphs.ellipsis)
    : 'none selected';
  const project = model.taskCase
    ? projectLabel(historicalCwdOf(model.taskCase))
    : vacant;
  const workspace = [
    ` TaskCase   ${taskLabel}`,
    ` Project    ${project}`,
    ` Recent     ${model.recentExperiment ? `${model.recentExperiment.experimentId} ${theme.glyphs.sep} ${model.recentExperiment.outcome ?? 'incomplete'}` : 'no local experiments'}`,
  ];
  const welcomeWidth = theme.density === 'wide' ? leftWidth(width) : width;
  const currentWidth = theme.density === 'wide' ? rightWidth(width) : width;
  const welcome = panel(theme, 'Welcome / Recent runs', [' Local commands', '', ...commands], welcomeWidth);
  const current = panel(theme, 'Current workspace', workspace, currentWidth);
  const stacked = theme.density === 'wide'
    ? joinColumns(welcome, current, welcomeWidth, currentWidth, 2, theme)
    : [...welcome, '', ...current];
  const placeholder = `Enter a task or / command${theme.glyphs.ellipsis}`;
  const prompt = ` ${theme.glyphs.cursor} ${model.composer ? `${model.composer}▌` : placeholder}`;
  const suggestions = model.showSuggestions ? renderSuggestions(theme, width, model.composer) : [];
  return [
    ...stacked,
    ...(suggestions.length ? ['', ...suggestions] : []),
    '',
    prompt,
  ];
}

export function homeHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Run command'], ['Tab', 'Complete'], ['?', 'Keys'], ['Ctrl+C', 'Exit']];
}

function commandLine(command: string, description: string, status: string): string {
  const left = ` ${command.padEnd(10)} ${description}`;
  return status ? `${left}  ${status}` : left;
}

function runReadiness(theme: Theme, model: HomeModel): string {
  if (!model.taskCase) return theme.style.warn('needs a TaskCase');
  if (!model.hasApiConfig) return theme.style.warn('needs API config');
  return theme.style.ok(theme.glyphs.ok);
}

function renderSuggestions(theme: Theme, width: number, composer: string): string[] {
  const matches = slashCommands().filter((command) => command.startsWith(composer.toLowerCase()));
  const lines = matches.map((command, index) => ` ${index === 0 ? theme.glyphs.cursor : ' '} ${command}`);
  return panel(theme, 'Commands', lines.length ? lines : [' No matching commands'], Math.min(width, 52));
}

function leftWidth(width: number): number { return Math.floor((width - 2) / 2); }
function rightWidth(width: number): number { return width - leftWidth(width) - 2; }

function historicalCwdOf(taskCase: TaskCase): string | undefined {
  const cwd = taskCase.taskContext?.historicalCwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

function frozenStart(taskCase: TaskCase): string {
  const users = taskCase.transcript.filter((message) => message.role === 'user');
  const index = users.findIndex((message) => message.id === taskCase.initialInput.id);
  if (index < 0 || users.length < 2) return '';
  return ` · ${index + 1}/${users.length}`;
}
