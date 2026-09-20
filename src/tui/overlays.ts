import type { Component } from '@earendil-works/pi-tui';
import { SelectList, type SelectListTheme } from '@earendil-works/pi-tui';
import {
  activityRoleLabel,
  activityStatusLabel,
  entryRole,
} from './agent-activity.js';
import { type ActionContext, helpLinesFromActions, listActions, type UiAction } from './action-model.js';
import { slashCommands } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import type { TimelineEntry } from './timeline.js';
import { panel, wrapBodyLine } from './widgets.js';

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
  confirm: ['Enter      Start the candidate run', 'b          Change model', 'Esc        Back to Home'],
  running: [
    'Enter      Expand fold / excerpt, or open detail',
    'Esc        Close detail (while open)',
    'Ctrl+C     Request cancellation',
  ],
  result: [
    'c          Generate comparison card when offered',
    'o          Open report.html',
    'h          Open history final artifact',
    'f          Open candidate final artifact',
    't          Open trace folder (troubleshoot)',
    'w          Open isolated replica (troubleshoot)',
    'Esc        Back to Home',
  ],
  error: ['Enter / b / Esc  Back to Home'],
};

export type ActivityDetailModel = {
  readonly roleLabel: string;
  readonly title: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly statusLabel: string;
  readonly eventRefs: readonly string[];
  readonly truncated?: boolean;
  readonly linkUnknown?: boolean;
  readonly openOriginalHint: string;
};

/** Shared detail projection for overlay (<110) and wide sidebar (>=110). Public content only. */
export function activityDetailModel(
  entry: TimelineEntry,
  product: string,
  locale: Locale = 'zh',
): ActivityDetailModel {
  const role = entryRole(entry);
  const body = publicDetailBody(entry);
  return {
    roleLabel: activityRoleLabel(role, product, locale),
    title: entry.title,
    body,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    statusLabel: activityStatusLabel(entry.activityStatus, locale),
    eventRefs: (entry.eventRefs ?? []).map((ref) => `${ref.eventId}#${ref.sequence}`),
    ...(entry.truncated ? { truncated: true } : {}),
    ...(entry.linkUnknown ? { linkUnknown: true } : {}),
    openOriginalHint: t(locale, 'openOriginalRecord'),
  };
}

function publicDetailBody(entry: TimelineEntry): string {
  // Never surface private/model_request payloads; prefer public detail/original excerpt.
  if (entry.eventType === 'agent.model_request') return entry.title;
  const parts = [
    entry.detail,
    entry.original && entry.original !== entry.detail ? entry.original : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.join('\n\n') || entry.title;
}

export function renderActivityDetail(
  theme: Theme,
  width: number,
  model: ActivityDetailModel,
  locale: Locale = 'zh',
): string[] {
  const lines = [
    `${t(locale, 'activityDetailRole')}: ${model.roleLabel}`,
    `${t(locale, 'activityDetailTime')}: ${model.occurredAt} · #${model.sequence}`,
    ...(model.statusLabel ? [`${t(locale, 'activityDetailStatus')}: ${model.statusLabel}`] : []),
    ...(model.linkUnknown ? [t(locale, 'linkUnknownNote')] : []),
    ...(model.eventRefs.length
      ? [`${t(locale, 'activityDetailRefs')}: ${model.eventRefs.slice(0, 8).join(', ')}${model.eventRefs.length > 8 ? '…' : ''}`]
      : []),
    '',
    ...wrapBodyLine(model.body, Math.max(8, width - 4)),
    ...(model.truncated ? ['', t(locale, 'moreLines', { n: 1 })] : []),
    '',
    theme.style.muted(model.openOriginalHint),
  ];
  return panel(theme, t(locale, 'activityDetailTitle'), lines.map((line) => ` ${line}`), Math.min(72, width));
}

export function showsActivityDetailSidebar(theme: Theme): boolean {
  return theme.density === 'wide';
}

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
  const runningKeys = page === 'running' ? [
    ...PAGE_KEYS.running!,
    t(locale, 'helpCancelRun'),
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

export class ActivityDetailOverlay implements Component {
  readonly #theme: Theme;
  readonly #model: ActivityDetailModel;
  readonly #locale: Locale;
  constructor(theme: Theme, model: ActivityDetailModel, locale: Locale = 'zh') {
    this.#theme = theme;
    this.#model = model;
    this.#locale = locale;
  }
  invalidate(): void { /* detail content is fixed for the selected entry */ }
  render(width: number): string[] {
    return renderActivityDetail(this.#theme, width, this.#model, this.#locale);
  }
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
