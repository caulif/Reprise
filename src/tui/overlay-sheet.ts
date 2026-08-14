import type { Theme } from './theme.js';

export const OVERLAY_PAGES = new Set([
  'config', 'history', 'history-detail', 'sessions', 'inspection',
  'source', 'preflight', 'confirm',
]);

export const OVERLAY_BACKGROUND_ROWS = 5;

export function overlayChromeRows(background: readonly string[]): number {
  return Math.min(OVERLAY_BACKGROUND_ROWS, background.length) + 1;
}

export function renderOverlaySheet(theme: Theme, background: readonly string[], sheet: readonly string[]): string[] {
  const dimmed = background.slice(0, Math.min(OVERLAY_BACKGROUND_ROWS, background.length)).map((line) => theme.style.muted(line));
  return [...dimmed, '', ...sheet];
}
