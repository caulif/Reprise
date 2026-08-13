import type { Component } from '@earendil-works/pi-tui';
import { SelectList, type SelectListTheme } from '@earendil-works/pi-tui';
import { slashCommands } from './format.js';
import type { Theme } from './theme.js';
import { panel } from './widgets.js';

export const HELP_COMMANDS_LINE = 'Commands: /config, /intake, /run, /history';

export function helpLines(): readonly string[] {
  return [
    HELP_COMMANDS_LINE,
    '',
    ' Global      Esc      Back to Home',
    '             Ctrl+C   Cancel run, or exit',
    '             ?        This help',
    '',
    ' Lists       Up/Down  Select      Enter   Open',
    '             /        Search sessions',
    '             Tab      Switch tab',
    '',
    ' Running     f        Cycle filter',
    '             l / End  Follow latest',
    '             PgUp/Dn  Page',
    '',
    ' Config      s        Save locally (no network)',
    '             t        Test connection (network)',
  ];
}

export function renderHelp(theme: Theme, width: number): string[] {
  return panel(theme, 'Keys', helpLines().map((line) => ` ${line}`), Math.min(64, width));
}

export class HelpOverlay implements Component {
  readonly #theme: Theme;
  constructor(theme: Theme) { this.#theme = theme; }
  invalidate(): void { /* overlay content is static */ }
  render(width: number): string[] { return renderHelp(this.#theme, width); }
}

export function commandSelectList(theme: Theme, filter: string): SelectList {
  const items = slashCommands().map((command) => ({ value: command, label: command }));
  const list = new SelectList(items, 6, selectTheme(theme));
  list.setFilter(filter);
  return list;
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
