/** Shared workbench region geometry for paint and pointer hit-testing. */

export type WorkbenchRect = {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
};

export type WorkbenchGeometry = {
  readonly width: number;
  readonly height: number;
  readonly header: WorkbenchRect;
  readonly rail: WorkbenchRect;
  readonly body: WorkbenchRect;
  readonly message: WorkbenchRect;
  readonly footer: WorkbenchRect;
};

/** Stack fixed chrome top-to-bottom; body takes whatever rows remain (may be 0). */
export function composeWorkbenchGeometry(input: {
  readonly width: number;
  readonly height: number;
  readonly headerRows: number;
  readonly railRows: number;
  readonly messageRows: number;
  readonly footerRows: number;
}): WorkbenchGeometry {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const headerRows = Math.max(0, input.headerRows);
  const railRows = Math.max(0, input.railRows);
  const messageRows = Math.max(0, input.messageRows);
  const footerRows = Math.max(0, input.footerRows);
  const chrome = headerRows + railRows + messageRows + footerRows;
  const bodyRows = Math.max(0, height - chrome - (height < 16 ? 1 : 0));
  let row = 0;
  const header = rect(row, width, headerRows);
  row += headerRows;
  const rail = rect(row, width, railRows);
  row += railRows;
  const body = rect(row, width, bodyRows);
  row += bodyRows;
  const message = rect(row, width, messageRows);
  row += messageRows;
  const footer = rect(row, width, footerRows);
  return { width, height, header, rail, body, message, footer };
}

/** Map 1-based SGR coordinates onto the body; outside the body rect is a miss (no clamp). */
export function bodyCellAt(
  geometry: WorkbenchGeometry,
  terminalRow: number,
  terminalCol: number,
): { readonly bodyRow: number; readonly col: number } | undefined {
  const y = terminalRow - 1;
  const x = terminalCol - 1;
  const { body } = geometry;
  if (y < body.row || y >= body.row + body.height) return undefined;
  if (x < body.col || x >= body.col + body.width) return undefined;
  return { bodyRow: y - body.row, col: terminalCol };
}

function rect(row: number, width: number, height: number): WorkbenchRect {
  return { row, col: 0, width, height };
}

import { isShortViewport, MIN_VIEWPORT_ROWS } from './viewport.js';

/** Reading scope only — does not drive CandidateRun or workflow phase. */
export type WorkbenchSurfaceScope = 'overview' | 'recovery' | 'candidate' | 'comparison';

export type ChromeBudget = {
  readonly header: number;
  readonly context: number;
  readonly stage: number;
  readonly activity: number;
  readonly notice: number;
  readonly footer: number;
  readonly body: number;
};

export type ChromeRequest = {
  readonly header: number;
  readonly context: number;
  readonly stage: number;
  readonly activity: number;
  readonly notice: number;
  readonly footer: number;
};

/**
 * Compress fixed chrome by §15 priority when the viewport is short.
 * Keep header + footer + at least one body row; drop stage → context → activity → notice.
 */
export function budgetChrome(height: number | undefined, request: ChromeRequest): ChromeBudget {
  const footer = Math.max(0, request.footer);
  const header = Math.max(0, request.header);
  if (height === undefined) {
    return {
      header,
      context: request.context,
      stage: request.stage,
      activity: request.activity,
      notice: request.notice,
      footer,
      body: Number.POSITIVE_INFINITY,
    };
  }
  if (height < MIN_VIEWPORT_ROWS) {
    return { header: 0, context: 0, stage: 0, activity: 0, notice: 0, footer: 0, body: height };
  }
  const short = isShortViewport(height);
  let context = short ? Math.min(1, request.context) : request.context;
  let stage = short ? 0 : request.stage;
  let activity = short ? Math.min(1, request.activity) : request.activity;
  let notice = short ? Math.min(1, request.notice) : request.notice;
  let hdr = short ? Math.min(1, header) : header;
  let ftr = short ? Math.min(1, footer) : footer;

  const fixed = () => hdr + context + stage + activity + notice + ftr;
  // Keep one spare row on very short screens for terminal repaint/notice
  // transitions; this prevents a four-row body from hiding the live status.
  const bodyOf = () => Math.max(1, height - fixed() - (height < 16 ? 1 : 0));

  // Drop lowest-priority chrome until body stays readable (≥4 when possible).
  const minBody = height >= 16 ? 4 : 1;
  while (bodyOf() < minBody && stage > 0) stage -= 1;
  while (bodyOf() < minBody && context > 0) context -= 1;
  while (bodyOf() < minBody && activity > 1) activity -= 1;
  // Keep one notice row on short screens so cancellation/error state is not
  // silently replaced by an apparently healthy live view.
  while (bodyOf() < minBody && notice > 1) notice -= 1;
  while (bodyOf() < minBody && activity > 0) activity -= 1;
  while (bodyOf() < 1 && hdr > 1) hdr -= 1;
  while (bodyOf() < 1 && ftr > 1) ftr -= 1;

  return { header: hdr, context, stage, activity, notice, footer: ftr, body: bodyOf() };
}

export function clipRegion(lines: readonly string[], rows: number, keep: 'head' | 'tail' = 'head'): string[] {
  if (rows <= 0) return [];
  if (lines.length <= rows) return [...lines];
  return keep === 'head' ? lines.slice(0, rows) : lines.slice(-rows);
}
