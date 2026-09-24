import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { CandidateRunState } from '../core/schema.js';
import { fileLink, truncateFit } from './format.js';
import type { Theme } from './theme.js';

export type Column = { readonly key: string; readonly width?: number; readonly flex?: number };
export type Row = Readonly<Record<string, string>>;
export type LinkValueHit = { readonly x0: number; readonly x1: number };
export type KvLinkBlock = { readonly lines: readonly string[]; readonly hits: readonly (LinkValueHit | undefined)[] };

/** 1-based column where the kv value starts in a body line (` ${key} ${value}`). */
function kvLinkValueStart(labelWidth: number): number {
  return labelWidth + 3;
}

function panelInnerWidth(theme: Theme, width: number): number {
  return Math.max(1, width - (theme.framed ? 2 : theme.plainPage ? 1 : 3));
}

function panelBodyCol(theme: Theme): number {
  return theme.framed || theme.plainPage ? 1 : 3;
}

/** Pad one physical terminal row. CR/LF/tab become spaces so a "layout row" never spans multiple screen rows. */
export function pad(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  const flat = flattenTerminalRow(text);
  const visible = visibleWidth(flat);
  if (visible === width) return flat;
  if (visible > width) return truncateFit(flat, width, ellipsis);
  return `${flat}${' '.repeat(width - visible)}`;
}

/** Collapse row-breaking controls without stripping intentional ANSI from themed chrome. */
function flattenTerminalRow(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ');
}

export function panel(theme: Theme, title: string, body: readonly string[], width: number): string[] {
  return [...panelWithHits(theme, title, body, width).lines];
}

/**
 * One wrap pass owns both paint and pointer geometry.
 * Body-line hits (1-based cols inside the pre-chrome body line) map onto every
 * post-wrap screen row they intersect, with x clipped into that segment.
 */
export function panelWithHits<T extends LinkValueHit>(
  theme: Theme,
  title: string,
  body: readonly string[],
  width: number,
  bodyHits: ReadonlyMap<number, readonly T[]> = new Map(),
): { readonly lines: readonly string[]; readonly rowHits: ReadonlyMap<number, readonly T[]> } {
  const inner = panelInnerWidth(theme, width);
  const col = panelBodyCol(theme);
  const rowHits = new Map<number, readonly T[]>();
  const painted: string[] = [];
  let bodyScreenRow = 0;
  for (let bodyRow = 0; bodyRow < body.length; bodyRow += 1) {
    const line = body[bodyRow] ?? '';
    const parts = wrapBodyLine(line, inner);
    const hits = bodyHits.get(bodyRow);
    let visibleStart = 0;
    for (const part of parts) {
      const partWidth = Math.max(0, visibleWidth(part));
      if (hits?.length) {
        const partStart = visibleStart + 1;
        const partEnd = visibleStart + Math.max(1, partWidth);
        const clipped: T[] = [];
        for (const hit of hits) {
          if (hit.x1 < partStart || hit.x0 > partEnd) continue;
          const local0 = Math.max(hit.x0, partStart) - visibleStart;
          const local1 = Math.min(hit.x1, partEnd) - visibleStart;
          clipped.push({ ...hit, x0: local0 + col, x1: local1 + col });
        }
        if (clipped.length) rowHits.set(1 + bodyScreenRow, clipped);
      }
      painted.push(part);
      visibleStart += partWidth;
      bodyScreenRow += 1;
    }
  }
  const heading = ` ${title.trim()} `;
  if (theme.plainPage) {
    return {
      lines: [theme.style.strong(` ${title.trim()}`), ...painted.map((line) => ` ${line}`)],
      rowHits,
    };
  }
  if (!theme.framed) {
    return {
      lines: [`[ ${title.trim()} ]`, ...painted.map((line) => `   ${line}`)],
      rowHits,
    };
  }
  const g = theme.glyphs;
  const headingText = `${g.h}${heading}`;
  const topPad = Math.max(0, inner - visibleWidth(headingText));
  const top = `${g.tl}${headingText}${g.h.repeat(topPad)}${g.tr}`;
  const bottom = `${g.bl}${g.h.repeat(inner)}${g.br}`;
  return {
    lines: [top, ...painted.map((line) => `${g.v}${pad(line, inner, g.ellipsis)}${g.v}`), bottom],
    rowHits,
  };
}


export function justify(theme: Theme, left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return `${left}${' '.repeat(gap)}${right}`;
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width / 2)));
  const leftWidth = Math.max(0, width - rightWidth);
  return `${truncateFit(left, leftWidth, theme.glyphs.ellipsis)}${truncateFit(right, rightWidth, theme.glyphs.ellipsis)}`;
}

export function pill(theme: Theme, label: string, state: 'ok' | 'warn' | 'off' | 'danger'): string {
  const mark = state === 'ok' ? theme.glyphs.dot
    : state === 'danger' ? theme.glyphs.err
      : state === 'warn' ? theme.glyphs.warn
        : theme.glyphs.empty;
  const text = `${mark} ${label}`;
  if (state === 'ok') return theme.style.ok(text);
  if (state === 'warn') return theme.style.warn(text);
  if (state === 'danger') return theme.style.danger(text);
  return theme.style.muted(text);
}

export function keyHints(theme: Theme, hints: readonly (readonly [string, string])[], width: number): string {
  const format = (items: readonly (readonly [string, string])[]) => items.map(([key, label]) => `[${key}] ${label}`).join('  ');
  const items = [...hints];
  while (items.length && visibleWidth(` ${format(items)}`) > Math.max(1, width)) items.pop();
  return ` ${truncateFit(format(items), Math.max(1, width - 1), theme.glyphs.ellipsis)}`;
}

export function table(theme: Theme, rows: readonly Row[], columns: readonly Column[], width: number): string[] {
  const flexTotal = columns.reduce((sum, column) => sum + (column.flex ?? 0), 0);
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const leftover = Math.max(0, width - fixed);
  const widths = columns.map((column) => {
    if (column.width !== undefined) return column.width;
    if (!flexTotal) return Math.max(1, Math.floor(leftover / columns.length));
    return Math.max(1, Math.floor(leftover * (column.flex ?? 0) / flexTotal));
  });
  const assigned = widths.reduce((sum, value) => sum + value, 0);
  if (widths.length && assigned < width) widths[widths.length - 1] = (widths.at(-1) ?? 0) + (width - assigned);
  return rows.map((row) => columns.map((column, index) => {
    const cell = row[column.key] ?? '';
    return pad(cell, widths[index] ?? 0, theme.glyphs.ellipsis);
  }).join(''));
}

const RAIL: readonly CandidateRunState[] = [
  'created', 'preparing', 'launching', 'awaiting_target', 'awaiting_controller', 'finalizing', 'finished',
];

export type PreparePhase = 'check' | 'copy' | 'run' | 'compare';

/** One progress line: bar plus the current phase. No step list, no status copy. */
export function progressBar(theme: Theme, phase: PreparePhase, elapsed: string, width: number): string[] {
  const ratio = phase === 'check' ? 0.28 : phase === 'copy' ? 0.55 : phase === 'compare' ? 0.92 : 0.82;
  const barWidth = Math.max(10, Math.min(24, width - 18));
  const filled = Math.max(1, Math.round(ratio * barWidth));
  const fill = theme.framed ? '█' : '#';
  const rest = theme.framed ? '░' : '-';
  const bar = `[${fill.repeat(filled)}${rest.repeat(Math.max(0, barWidth - filled))}]`;
  const label = theme.style.accent(phase);
  const lineWidth = Math.max(1, width);
  return [pad(truncateFit(` ${bar}  ${label}  ${elapsed}`, lineWidth, theme.glyphs.ellipsis), lineWidth, theme.glyphs.ellipsis)];
}

export function stateRail(theme: Theme, current: CandidateRunState | undefined, width: number): string[] {
  const g = theme.glyphs;
  const active = current ?? 'created';
  const activeIndex = Math.max(0, RAIL.indexOf(active));
  const parts: string[] = [];
  for (let index = 0; index < RAIL.length; index += 1) {
    const state = RAIL[index];
    if (state === 'awaiting_controller') continue;
    if (state === 'awaiting_target') {
      const loop = `awaiting_target ${g.sep === '-' ? '<>' : '⇄'} awaiting_controller`;
      const mark = active === 'awaiting_target' || active === 'awaiting_controller' ? g.dot : activeIndex > 3 ? g.ok : g.sep;
      const painted = mark === g.dot ? theme.style.accent(`${mark} ${loop}`) : theme.style.muted(`${mark} ${loop}`);
      parts.push(painted);
      continue;
    }
    const reached = index < activeIndex;
    const isCurrent = state === active;
    const mark = isCurrent ? g.dot : reached ? g.ok : g.sep;
    const label = `${mark} ${state}`;
    parts.push(isCurrent ? theme.style.accent(label) : theme.style.muted(label));
  }
  return wrapRail(parts, `  ${g.arrow}  `, Math.max(1, width));
}

function wrapRail(parts: readonly string[], gap: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const part of parts) {
    if (visibleWidth(part) > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(...wrapTextWithAnsi(part, width));
      continue;
    }
    const next = current ? `${current}${gap}${part}` : part;
    if (current && visibleWidth(next) > width) {
      lines.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

export function joinColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  gap = 1,
  theme?: Theme,
): string[] {
  const height = Math.max(left.length, right.length);
  const leftLines = extendPanel(left, height, leftWidth, theme);
  const rightLines = extendPanel(right, height, rightWidth, theme);
  const spacer = ' '.repeat(gap);
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(`${pad(leftLines[index] ?? '', leftWidth)}${spacer}${pad(rightLines[index] ?? '', rightWidth)}`);
  }
  return lines;
}

function extendPanel(lines: readonly string[], height: number, width: number, theme?: Theme): string[] {
  if (lines.length >= height) return [...lines];
  const extra = height - lines.length;
  const blank = theme?.framed
    ? `${theme.glyphs.v}${pad('', Math.max(0, width - 2))}${theme.glyphs.v}`
    : ' '.repeat(Math.max(0, width));
  const last = lines.at(-1) ?? '';
  if (theme?.framed && last.startsWith(theme.glyphs.bl)) {
    return [...lines.slice(0, -1), ...Array.from({ length: extra }, () => blank), last];
  }
  return [...lines, ...Array.from({ length: extra }, () => blank)];
}

const LEADING_PUNCT = /^[：:，。；、,.!?）)\]】»]+/u;
const PHRASE_BREAK = new Set(['：', '，', '。', '；', '、', '>']);

export function wrapBodyLine(line: string, width: number): string[] {
  if (width <= 0) return [''];
  return line.split(/\r?\n/).flatMap((part) => {
    const wrapped = /\u001b/.test(part) ? wrapTextWithAnsi(part, width) : wrapPreferBreaks(part, width);
    return attachLeadingPunctuation(wrapped, width);
  });
}

function wrapPreferBreaks(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let rest = text;
  while (visibleWidth(rest) > width) {
    const prefix = takePrefix(rest, width);
    const split = lastBreak(prefix);
    lines.push(rest.slice(0, split));
    rest = rest.slice(split);
  }
  if (rest) lines.push(rest);
  return lines.length ? lines : [''];
}

function takePrefix(text: string, width: number): string {
  let used = 0;
  let end = 0;
  for (const char of text) {
    const next = used + visibleWidth(char);
    if (end > 0 && next > width) break;
    used = next;
    end += char.length;
  }
  return text.slice(0, Math.max(end, 1));
}

function lastBreak(prefix: string): number {
  const phrase = lastPhraseBreak(prefix);
  if (phrase > 0) return phrase;
  const path = lastPathBreak(prefix);
  if (path > 0) return path;
  return prefix.length;
}

function lastPhraseBreak(prefix: string): number {
  let best = -1;
  const arrow = prefix.lastIndexOf(' -> ');
  if (arrow > 0) best = arrow + 4;
  for (let index = 0; index < prefix.length; index += 1) {
    const ch = prefix[index] ?? '';
    if ((ch === ' ' || ch === '\t') && /^\s*$/.test(prefix.slice(index + 1))) continue;
    if ((ch === ' ' || ch === '\t' || PHRASE_BREAK.has(ch)) && index + 1 < prefix.length) best = index + 1;
  }
  return best;
}

function lastPathBreak(prefix: string): number {
  let best = -1;
  for (let index = 0; index < prefix.length; index += 1) {
    const ch = prefix[index];
    if (ch === '\\' && index + 1 < prefix.length) best = index + 1;
    if (ch === '/' && isPathSlash(prefix, index) && index + 1 < prefix.length) best = index + 1;
  }
  return best;
}

/** Slash is a path break, not a word like WhatsApp/WeChat. */
function isPathSlash(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1] ?? '';
  const next = text[index + 1] ?? '';
  if (prev === '/' || next === '/') return true;
  if (prev === ':' && text[index - 2] === '/') return true;
  if (text.includes('\\') || /^[A-Za-z]:/.test(text)) return true;
  if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next) && !text.slice(0, index).includes('/')) return false;
  return Boolean(next);
}

function attachLeadingPunctuation(lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const lead = out.length ? LEADING_PUNCT.exec(line)?.[0] : undefined;
    if (lead && visibleWidth((out.at(-1) ?? '') + lead) <= width) {
      out[out.length - 1] = `${out.at(-1) ?? ''}${lead}`;
      const rest = line.slice(lead.length);
      if (rest) out.push(rest);
      continue;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

export function kv(theme: Theme, key: string, value: string, width: number): string {
  void width;
  const labelWidth = Math.max(12, visibleWidth(key));
  const label = pad(key, labelWidth, theme.glyphs.ellipsis);
  return ` ${theme.style.muted(label)} ${value}`;
}

/** Label plus wrapped value; continuation lines indent under the value, not under a mid-glyph. */
export function kvBlock(theme: Theme, key: string, value: string, width: number): string[] {
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const labelWidth = Math.max(12, visibleWidth(key));
  const valueWidth = Math.max(8, inner - labelWidth - 2);
  const wrapped = wrapBodyLine(value, valueWidth);
  const indent = ' '.repeat(labelWidth);
  return wrapped.map((line, index) => (
    index === 0
      ? ` ${theme.style.muted(pad(key, labelWidth, theme.glyphs.ellipsis))} ${line}`
      : ` ${indent} ${line}`
  ));
}

/** Like kvBlock, but each wrapped visible segment opens the same local path. */
export function kvLinkBlock(theme: Theme, key: string, label: string, absolutePath: string | undefined, width: number): KvLinkBlock {
  const vacant = theme.framed ? '—' : '-';
  if (!absolutePath || !label.trim() || label === vacant) {
    const lines = kvBlock(theme, key, label, width);
    return { lines, hits: lines.map(() => undefined) };
  }
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const labelWidth = Math.max(12, visibleWidth(key));
  const valueWidth = Math.max(8, inner - labelWidth - 2);
  const wrapped = wrapBodyLine(label, valueWidth);
  const indent = ' '.repeat(labelWidth);
  const valueStart = kvLinkValueStart(labelWidth);
  const lines: string[] = [];
  const hits: (LinkValueHit | undefined)[] = [];
  for (const [index, segment] of wrapped.entries()) {
    const linked = theme.style.accent(fileLink(segment, absolutePath));
    lines.push(index === 0
      ? ` ${theme.style.muted(pad(key, labelWidth, theme.glyphs.ellipsis))} ${linked}`
      : ` ${indent} ${linked}`);
    hits.push({ x0: valueStart, x1: valueStart + Math.max(1, visibleWidth(segment)) - 1 });
  }
  return { lines, hits };
}
