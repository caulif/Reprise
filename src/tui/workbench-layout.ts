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
  const bodyOf = () => Math.max(1, height - fixed());

  // Drop lowest-priority chrome until body stays readable (≥4 when possible).
  const minBody = height >= 16 ? 4 : 1;
  while (bodyOf() < minBody && stage > 0) stage -= 1;
  while (bodyOf() < minBody && context > 0) context -= 1;
  while (bodyOf() < minBody && activity > 1) activity -= 1;
  while (bodyOf() < minBody && notice > 0) notice -= 1;
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
