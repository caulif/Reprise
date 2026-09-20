import type { Component } from '@earendil-works/pi-tui';
import { SelectList, type SelectListTheme } from '@earendil-works/pi-tui';
import { type ActionContext, helpLinesFromActions, listActions, type UiAction } from './action-model.js';
import { slashCommands } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import { panel } from './widgets.js';

/** Fallback static keys for pages not yet migrated onto the shared action model. */
const PAGE_KEYS: Record<string, readonly string[]> = {
  home: [
    'Type       /command, then Enter',
    'Tab        Complete command',
  ],
  config: [
    'Up/Down    Select field',
    'Enter      Edit text, or toggle provider / effort',
    'Ctrl+T     Test connection (network)',
    'Ctrl+S     Save locally (no network)',
  ],
  sessions: [
    'Up/Down    Select          Enter   Open',
    'Type       Filter the list',
    'Ctrl+F     Toggle eligible-only filter',
    'Ctrl+N     Load more',
    'Ctrl+R     Refresh from the first page',
  ],
  inspection: [
    'Enter      Freeze the session from the first user task',
    'd          Toggle outcome detail',
  ],
  history: [
    'Up/Down    Select          Enter   Open',
    'Tab        Switch runs / cases',
  ],
  'history-detail': [
    'Enter      Use this TaskCase',
    'o          Open report',
    't          Open local path',
  ],
  source: ['Enter      Start the isolated run', 'Esc        Back to Home'],
  'candidate-product': [
    'Up/Down    Select candidate product',
    'Enter      Choose that product\'s models',
    'b          Back',
  ],
  'candidate-model': [
    'Up/Down    Select model',
    'Enter      Start the isolated run',
    'b          Change product',
  ],
  preflight: ['Esc        Back to Home'],
  error: ['Enter / b / Esc  Back to Home'],
};

const ACTION_HELP_PAGES = new Set(['running', 'result', 'confirm']);

export function helpLines(
  page?: string,
  locale: Locale = 'en',
  actions?: readonly UiAction[],
): readonly string[] {
  if (actions) return helpLinesFromActions(actions, locale, page);
  if (page && ACTION_HELP_PAGES.has(page)) {
    return helpLinesFromActions(listActions({ page, locale }), locale, page);
  }
  const scoped = page === undefined ? undefined : PAGE_KEYS[page];
  const homeKeys = page === 'home' ? [
    t(locale, 'helpTypeCommand'),
    t(locale, 'helpTabComplete'),
    'Up/Down    Choose a matching /command',
  ] : undefined;
  const keys = page === 'home' ? homeKeys : scoped;
  return [
    ...(page === 'home' || page === undefined ? [t(locale, 'helpCommands')] : []),
    '',
    ...(keys ? [` ${t(locale, 'helpThisPage', { page: page ?? '' })}`, ...keys.map((line) => `   ${line}`), ''] : []),
    ` ${t(locale, 'helpGlobalLine')}`,
    ` ${t(locale, 'helpCtrlC')}`,
    ` ${t(locale, 'helpQuestion')}`,
  ];
}

export function renderHelp(
  theme: Theme,
  width: number,
  page?: string,
  locale: Locale = 'en',
  actions?: readonly UiAction[],
): string[] {
  return panel(theme, t(locale, 'helpTitle'), helpLines(page, locale, actions).map((line) => ` ${line}`), Math.min(64, width));
}

export class HelpOverlay implements Component {
  readonly #theme: Theme;
  readonly #page: string | undefined;
  readonly #locale: Locale;
  readonly #actions: readonly UiAction[] | undefined;
  constructor(theme: Theme, page?: string, locale: Locale = 'en', actions?: readonly UiAction[]) {
    this.#theme = theme;
    this.#page = page;
    this.#locale = locale;
    this.#actions = actions;
  }
  invalidate(): void { /* overlay content is fixed for the page it was opened on */ }
  render(width: number): string[] {
    return renderHelp(this.#theme, width, this.#page, this.#locale, this.#actions);
  }
}

export function helpActionsForContext(ctx: ActionContext): readonly UiAction[] {
  return listActions(ctx);
}

export function commandSelectList(theme: Theme): SelectList {
  return new SelectList(slashCommands().map((command) => ({ value: command, label: command })), 6, selectTheme(theme));
}

function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: theme.style.accent,
    selectedText: theme.style.accent,
    description: theme.style.muted,
    scrollInfo: theme.style.muted,
    noMatch: theme.style.muted,
  };
}
