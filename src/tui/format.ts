import { pathToFileURL } from 'node:url';
import { getCapabilities, hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isFsAbsolute } from '../core/paths.js';

const SLASH_COMMANDS = ['/help', '/config', '/intake', '/history', '/lang'] as const;
export const TIMELINE_FILTERS = ['ALL', 'PRODUCT', 'INPUT'] as const;
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

export function unwrapBracketedPaste(value: string): string {
  const match = /^\u001b\[200~([\s\S]*)\u001b\[201~$/.exec(value);
  return match ? match[1] ?? '' : value;
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

export { formatBytes } from '../core/format.js';

/** Short operator-facing text for the error page; keep the original Error for logs and causes. */
export function operatorErrorMessage(error: unknown): string {
  const codeValue = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const code = typeof codeValue === 'string' ? codeValue : '';
  const message = errorMessage(error);
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || /operation not permitted, rename/i.test(message)) {
    return 'Could not publish the isolated baseline. Windows still had a lock on the copied files. Return and start again from /intake.';
  }
  return message;
}

export function missing(value: string | undefined, empty = '—'): string {
  return value?.trim() ? value : empty;
}

/** Visible label plus OSC 8 file:// link when the terminal supports it. Wrap the label first. */
export function fileLink(label: string, absolutePath: string): string {
  const safeLabel = stripTerminalSequences(label);
  if (!safeLabel || !absolutePath || !isFsAbsolute(absolutePath)) return safeLabel;
  const href = stripTerminalSequences(pathToFileURL(absolutePath).href);
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return stripTerminalSequences(absolutePath);
  if (getCapabilities().hyperlinks) return hyperlink(safeLabel, href);
  return stripTerminalSequences(absolutePath);
}
