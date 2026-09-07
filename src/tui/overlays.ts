import type { Component } from '@earendil-works/pi-tui';
import { SelectList, type SelectListTheme } from '@earendil-works/pi-tui';
import { slashCommands } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import { panel } from './widgets.js';

/** Several keys mean different things per page (`f`, `t`, `d`), so help is scoped to where the user is. */
const PAGE_KEYS: Record<string, readonly string[]> = {
  home: [
    'Type       /command, then Enter',
    'Tab        Complete command',
  ],
  config: [
    'Up/Down    Select field',
    'Enter      Edit text, or toggle provider / effort',
    't          Test connection (network)',
    's          Save locally (no network)',
  ],
  sessions: [
    'Up/Down    Select          Enter   Start run',
    '/          Search',
    'f          Toggle eligible-only filter',
  ],
  inspection: [
    'Enter      Freeze the session from the first user task',
    't          Toggle model text sharing',
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
    'Enter      Confirm this model',
    'b          Change product',
  ],
  preflight: ['b          Edit source root', 'Esc        Back to Home'],
  confirm: ['Enter      Start the candidate run', 'b          Change model', 'Esc        Back to Home'],
  'compare-gate': ['Enter      Start comparison', 's          Skip comparison', 'Ctrl+C     Exit'],
  running: ['Ctrl+C     Request cancellation'],
  result: [
    'o          Open report.html',
    't          Open trace folder',
    'w          Open isolated replica',
    'Enter / b  Back to Home',
  ],
  error: ['Enter / b / Esc  Back to Home'],
};

export function helpLines(page?: string, locale: Locale = 'en'): readonly string[] {
  const scoped = page === undefined ? undefined : PAGE_KEYS[page];
  const homeKeys = page === 'home' ? [
    t(locale, 'helpTypeCommand'),
    t(locale, 'helpTabComplete'),
  ] : undefined;
  const runningKeys = page === 'running' ? [
    t(locale, 'helpCancelRun'),
    'Ctrl+G     Actors',
    'Tab        Switch pane',
    'd / Enter  Toggle details',
    'o          Open selected detail',
  ] : undefined;
  const keys = page === 'home' ? homeKeys : page === 'running' ? runningKeys : scoped;
  return [
    ...(page === 'home' || page === undefined ? [t(locale, 'helpCommands')] : []),
    '',
    ...(keys ? [` ${t(locale, 'helpThisPage', { page: page ?? '' })}`, ...keys.map((line) => `   ${line}`), ''] : []),
    ` ${t(locale, 'helpGlobalLine')}`,
    ` ${t(locale, 'helpCtrlC')}`,
    ` ${t(locale, 'helpQuestion')}`,
  ];
}

export function renderHelp(theme: Theme, width: number, page?: string, locale: Locale = 'en'): string[] {
  return panel(theme, t(locale, 'helpTitle'), helpLines(page, locale).map((line) => ` ${line}`), Math.min(64, width));
}

export class HelpOverlay implements Component {
  readonly #theme: Theme;
  readonly #page: string | undefined;
  readonly #locale: Locale;
  constructor(theme: Theme, page?: string, locale: Locale = 'en') {
    this.#theme = theme;
    this.#page = page;
    this.#locale = locale;
  }
  invalidate(): void { /* overlay content is fixed for the page it was opened on */ }
  render(width: number): string[] { return renderHelp(this.#theme, width, this.#page, this.#locale); }
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
