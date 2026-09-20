import { pathToFileURL } from 'node:url';
import { getCapabilities, hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isFsAbsolute } from '../core/paths.js';
import { t, type Locale } from './i18n.js';

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

/** Display copy of untrusted live text: strip terminal sequences, then collapse whitespace to one line. */
export function sanitizeLiveCaption(value: string): string {
  return stripTerminalSequences(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { formatBytes } from '../core/format.js';

/** Short operator-facing text for the error page; keep the original Error for logs and causes. */
export function operatorErrorMessage(error: unknown, locale: Locale = 'en'): string {
  const codeValue = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const code = typeof codeValue === 'string' ? codeValue : '';
  const message = errorMessage(error);
  const windowsLock = code === 'EPERM' || code === 'EBUSY' || /operation not permitted, rename/i.test(message)
    || (code === 'EACCES' && process.platform === 'win32');
  if (windowsLock) {
    return t(locale, 'errorBaselineLock');
  }
  if (code === 'ENAMETOOLONG' || /filename too long|invalid index-pack/i.test(message)) {
    return t(locale, 'errorGitSinkPathTooLong');
  }
  if (message.includes('git_remote_unprotected')) {
    return t(locale, 'errorGitRemoteUnprotected');
  }
  if (message.includes('incomplete_object_store')) {
    return t(locale, 'errorGitObjectStoreIncomplete');
  }
  if (/GitSinkManifestSchema/.test(message)) {
    return t(locale, 'errorGitSinkCatalogInvalid');
  }
  return message;
}

export function missing(value: string | undefined, empty = '—'): string {
  return value?.trim() ? value : empty;
}

/** Visible short label plus OSC 8 file:// link when the terminal supports it. Never replace the label with the absolute path. */
export function fileLink(label: string, absolutePath: string): string {
  const safeLabel = stripTerminalSequences(label);
  if (!safeLabel || !absolutePath || !isFsAbsolute(absolutePath)) return safeLabel;
  const href = stripTerminalSequences(pathToFileURL(absolutePath).href);
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return safeLabel;
  if (getCapabilities().hyperlinks) return hyperlink(safeLabel, href);
  return safeLabel;
}

const OSC8 = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;

/** 1-based visible columns of OSC 8 labels on a rendered line. */
function fileLinkSpans(line: string): readonly { x0: number; x1: number; href: string }[] {
  const spans: { x0: number; x1: number; href: string }[] = [];
  const osc8 = new RegExp(OSC8.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = osc8.exec(line))) {
    const href = match[1] ?? '';
    const label = match[2] ?? '';
    if (!href || !label) continue;
    const x0 = visibleWidth(stripOsc8(line.slice(0, match.index))) + 1;
    const x1 = x0 + Math.max(1, visibleWidth(label)) - 1;
    spans.push({ x0, x1, href });
  }
  return spans;
}

export function hitFileLink(line: string, col: number): string | undefined {
  return fileLinkSpans(line).find((span) => col >= span.x0 && col <= span.x1)?.href;
}

function stripOsc8(text: string): string {
  return text.replace(new RegExp(OSC8.source, 'g'), '$2');
}
