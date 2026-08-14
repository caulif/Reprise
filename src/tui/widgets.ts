import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { CandidateRunState } from '../core/schema.js';
import { fileLink, truncateFit } from './format.js';
import type { Theme } from './theme.js';

export type Column = { readonly key: string; readonly width?: number; readonly flex?: number };
export type Row = Readonly<Record<string, string>>;

export function pad(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  const visible = visibleWidth(text);
  if (visible === width) return text;
  if (visible > width) return truncateFit(text, width, ellipsis);
  return `${text}${' '.repeat(width - visible)}`;
}

export function panel(theme: Theme, title: string, body: readonly string[], width: number): string[] {
  const heading = ` ${title.trim()} `;
  if (!theme.framed) {
    const inner = Math.max(1, width - 3);
    return [`[ ${title.trim()} ]`, ...body.flatMap((line) => wrapBodyLine(line, inner)).map((line) => `   ${line}`)];
  }
  const inner = Math.max(1, width - 2);
  const g = theme.glyphs;
  const headingText = `${g.h}${heading}`;
  const topPad = Math.max(0, inner - visibleWidth(headingText));
  const top = `${g.tl}${headingText}${g.h.repeat(topPad)}${g.tr}`;
  const bottom = `${g.bl}${g.h.repeat(inner)}${g.br}`;
  const wrapped = body.flatMap((line) => wrapBodyLine(line, inner)).map((line) => `${g.v}${pad(line, inner, g.ellipsis)}${g.v}`);
  return [top, ...wrapped, bottom];
}


export function divider(theme: Theme, width: number): string {
  return theme.glyphs.h.repeat(Math.max(1, width));
}

export function justify(theme: Theme, left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return `${left}${' '.repeat(gap)}${right}`;
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width / 2)));
  const leftWidth = Math.max(0, width - rightWidth);
  return `${truncateFit(left, leftWidth, theme.glyphs.ellipsis)}${truncateFit(right, rightWidth, theme.glyphs.ellipsis)}`;
}

export function pill(theme: Theme, label: string, state: 'ok' | 'warn' | 'off'): string {
  const mark = state === 'ok' ? theme.glyphs.dot : state === 'warn' ? theme.glyphs.warn : theme.glyphs.empty;
  const text = `${mark} ${label}`;
  if (state === 'ok') return theme.style.ok(text);
  if (state === 'warn') return theme.style.warn(text);
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

export function prepareRail(theme: Theme, phase: Exclude<PreparePhase, 'run' | 'compare'>, elapsed: string, width: number, _detail?: string): string[] {
  return progressBar(theme, phase, elapsed, width);
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
  return ` ${label} ${value}`;
}

/** Label plus wrapped value; continuation lines indent under the value, not under a mid-glyph. */
export function kvBlock(theme: Theme, key: string, value: string, width: number): string[] {
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const labelWidth = 12;
  const valueWidth = Math.max(8, inner - labelWidth - 2);
  const wrapped = wrapBodyLine(value, valueWidth);
  const indent = ' '.repeat(labelWidth);
  return wrapped.map((line, index) => (
    index === 0
      ? ` ${pad(key, labelWidth, theme.glyphs.ellipsis)} ${line}`
      : ` ${indent} ${line}`
  ));
}

/** Like kvBlock, but each wrapped visible segment opens the same local path. */
export function kvLinkBlock(theme: Theme, key: string, label: string, absolutePath: string | undefined, width: number): string[] {
  const vacant = theme.framed ? '—' : '-';
  if (!absolutePath || !label.trim() || label === vacant) return kvBlock(theme, key, label, width);
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const labelWidth = 12;
  const valueWidth = Math.max(8, inner - labelWidth - 2);
  const wrapped = wrapBodyLine(label, valueWidth);
  const indent = ' '.repeat(labelWidth);
  return wrapped.map((line, index) => {
    const linked = fileLink(theme.style.accent(line), absolutePath);
    return index === 0
      ? ` ${pad(key, labelWidth, theme.glyphs.ellipsis)} ${linked}`
      : ` ${indent} ${linked}`;
  });
}
