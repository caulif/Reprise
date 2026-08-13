import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const SLASH_COMMANDS = ['/help', '/config', '/intake', '/run', '/history'] as const;
export const TIMELINE_FILTERS = ['ALL', 'TARGET', 'CONTROLLER', 'HARNESS'] as const;
export type TimelineFilter = typeof TIMELINE_FILTERS[number];
const ANSI = /\u001b\[[0-9;]*m/;

/** Truncate by visible width. Uncolored text keeps a plain ellipsis, without CSI reset artifacts. */
export function truncateFit(text: string, width: number, ellipsis = '...'): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const cut = truncateToWidth(text, width, ellipsis, false);
  return ANSI.test(text) ? cut : cut.replace(/\u001b\[[0-9;]*m/g, '');
}

export function slashCommands(): readonly string[] {
  return SLASH_COMMANDS;
}

export function isTextInput(value: string): boolean {
  return /^[^\u0000-\u001f\u007f]+$/.test(value);
}

export function nextOption<T extends { id: string }>(items: readonly T[], current: string): T | undefined {
  if (!items.length) return undefined;
  const index = items.findIndex((item) => item.id === current);
  return items[(index + 1) % items.length];
}

export function compact(value: string, limit: number, ellipsis = '...'): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return truncateFit(normalized, limit, ellipsis);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function missing(value: string | undefined, empty = '—'): string {
  return value?.trim() ? value : empty;
}
