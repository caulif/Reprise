import { compact, type TimelineFilter } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import type { TimelineEntry } from './timeline.js';
import { pad, wrapBodyLine } from './widgets.js';

export type Voice = 'input' | 'product' | 'summary' | 'controller';

export type CanvasHit = {
  readonly y: number;
  readonly index: number;
  readonly fold: boolean;
  readonly itemId?: string;
};

function voiceOf(entry: TimelineEntry): Voice | undefined {
  if (entry.hidden) return undefined;
  if (isQuietMcpStatus(entry)) return undefined;
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·')) return 'input';
  if (entry.title.startsWith('⎿ ')) {
    if (entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane)) return 'product';
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    return 'controller';
  }
  if (entry.kind === 'narrate') {
    if (entry.lane === 'comparison') return 'summary';
    if (entry.lane === 'recovery') return 'summary';
    return 'controller';
  }
  if (entry.kind === 'fold') {
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    if (entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane)) return 'product';
    return 'controller';
  }
  if (entry.kind === 'live' || entry.placeholder) {
    if (entry.lane === 'controller') return 'controller';
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    if (entry.source === 'TARGET') return 'product';
  }
  if (entry.title.startsWith('已恢复') || entry.title.startsWith('部分恢复') || entry.title.startsWith('无法恢复') || entry.title.startsWith('恢复')) return 'summary';
  if (entry.title.startsWith('DONE ·') || entry.title.startsWith('控制Agent') || entry.lane === 'controller') {
    return 'controller';
  }
  if (entry.title.startsWith('Working') || entry.title.startsWith('State:')
    || entry.title.startsWith('Turn settled') || entry.title.startsWith('Isolation')
    || entry.title.startsWith('Runtime') || entry.title.startsWith('Stage')) {
    return undefined;
  }
  if (entry.source === 'HARNESS' && entry.level !== 'error' && entry.lane !== 'comparison' && entry.lane !== 'recovery') {
    return undefined;
  }
  if (entry.title.startsWith('对照') || entry.title === '证据不足' || entry.lane === 'comparison' || entry.title.startsWith('Candidate stopped')
    || entry.title.startsWith('Controller done') || entry.title.startsWith('Stop requested')) {
    return 'summary';
  }
  if (entry.source === 'TARGET' || entry.level === 'error') return 'product';
  if (entry.source === 'CONTROLLER') return 'controller';
  return undefined;
}

export function matchesFilter(entry: TimelineEntry, filter: TimelineFilter): boolean {
  const voice = voiceOf(entry);
  if (!voice) return false;
  if (filter === 'ALL') return true;
  if (filter === 'INPUT') return voice === 'input';
  if (filter === 'PRODUCT') return voice === 'product';
  return true;
}

export { matchesCanvasQuery } from './timeline-read.js';

export function renderScrollback(
  theme: Theme,
  width: number,
  entries: readonly TimelineEntry[],
  selected: number,
  locale: Locale,
  product: string,
  height?: number,
  tick = 0,
  readingOffset = 0,
  elapsed = '00:00',
): string[] {
  return layoutScrollback(theme, width, entries, selected, locale, product, height, tick, readingOffset, elapsed).lines;
}

export function layoutScrollback(
  theme: Theme,
  width: number,
  entries: readonly TimelineEntry[],
  selected: number,
  locale: Locale,
  product: string,
  height?: number,
  tick = 0,
  readingOffset = 0,
  elapsed = '00:00',
): { lines: string[]; hits: CanvasHit[] } {
  const lines: string[] = [];
  const hits: CanvasHit[] = [];
  let selectedAt = 0;
  const seenInput = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!voiceOf(entry)) continue;
    if (voiceOf(entry) === 'input') {
      const key = inputText(entry).replace(/\s+/g, ' ').trim();
      if (key && seenInput.has(key)) continue;
      if (key) seenInput.add(key);
    }
    const painted = paintEntry(theme, entry, index === selected, width, locale, product, tick, elapsed);
    if (index === selected) selectedAt = lines.length;
    hits.push({
      y: lines.length,
      index,
      fold: entry.kind === 'fold' || entry.title.startsWith('▸'),
      ...(entry.itemId ? { itemId: entry.itemId } : {}),
    });
    lines.push(...painted);
  }
  const live = visibleNow(entries);
  if (live || entries.length) {
    lines.push(fillCanvas(theme, liveStatusLine(theme, live, locale, elapsed, tick, product), width));
  }
  if (!lines.length) {
    const empty = [fillCanvas(theme, liveStatusLine(theme, undefined, locale, elapsed, tick, product), width)];
    return { lines: empty, hits };
  }
  if (height === undefined || lines.length <= height) return { lines, hits };
  const start = Math.max(0, Math.min(selectedAt + readingOffset, lines.length - height));
  return {
    lines: lines.slice(start, start + height),
    hits: hits.map((hit) => ({ ...hit, y: hit.y - start })).filter((hit) => hit.y >= 0 && hit.y < height),
  };
}

export function hitAtBodyRow(hits: readonly CanvasHit[], bodyRow: number): CanvasHit | undefined {
  let hit = hits[0];
  for (const candidate of hits) {
    if (candidate.y <= bodyRow) hit = candidate;
    else break;
  }
  return hit;
}

function paintEntry(
  theme: Theme,
  entry: TimelineEntry,
  selected: boolean,
  width: number,
  locale: Locale,
  product: string,
  tick: number,
  elapsed: string,
): string[] {
  const inner = Math.max(8, width - 4);
  const candidate = isCandidate(entry);
  const paint = entry.level === 'error'
    ? theme.style.danger
    : candidate
      ? theme.style.target
      : theme.style.harness;
  if (voiceOf(entry) === 'input') {
    return wrapBodyLine(inputText(entry), inner).map((line, index) => {
      const prefix = index === 0 ? (theme.framed ? '▎ ' : '| ') : '  ';
      const row = `${prefix}${line}`;
      return selected ? theme.style.fillInputSelected(pad(row, width, theme.glyphs.ellipsis)) : theme.style.fillInput(pad(row, width, theme.glyphs.ellipsis));
    });
  }
  if (entry.title.startsWith('⎿ ')) {
    const row = `   ${theme.style.muted(compact(entry.title, inner, theme.glyphs.ellipsis))}`;
    return [fillCanvas(theme, selected ? theme.style.strong(row) : row, width)];
  }
  if (entry.kind === 'fold' || entry.title.startsWith('▸')) {
    const title = entry.title.startsWith('▸') ? entry.title : `▸ ${entry.title}`;
    const row = ` ${paint(compact(title, inner, theme.glyphs.ellipsis))}`;
    return [fillCanvas(theme, selected ? theme.style.strong(row) : row, width)];
  }
  if (entry.kind === 'live' || entry.placeholder) {
    const pulse = Math.floor(tick / 400) % 2 === 0 ? paint(theme.glyphs.dot) : theme.style.muted(theme.glyphs.empty);
    const caption = liveCaption(entry, elapsed);
    const row = ` ${pulse} ${paint(compact(caption, inner - 4, theme.glyphs.ellipsis))}`;
    return [fillCanvas(theme, selected ? theme.style.strong(row) : row, width)];
  }
  if (entry.kind === 'narrate') {
    const text = (entry.detail ?? entry.title).trim();
    return wrapBodyLine(text, inner).map((line) => fillCanvas(theme, selected ? theme.style.strong(` ${line}`) : ` ${line}`, width));
  }
  if (entry.kind === 'deliver' && (entry.title.startsWith('DONE ·') || entry.title === '已恢复' || entry.title === '部分恢复' || entry.title === '无法恢复' || entry.title === '对照完成' || entry.title === '证据不足' || entry.title === '对照失败')) {
    const lines = wrapBodyLine(entry.title, inner).map((line) => fillCanvas(theme, ` ${theme.style.ok(line)}`, width));
    if (!entry.detail || !selected) return lines;
    return [...lines, ...wrapBodyLine(entry.detail, inner).map((line) => fillCanvas(theme, ` ${theme.style.muted(line)}`, width))];
  }
  if (isCommand(entry)) {
    const status = commandFailed(entry) ? ` ${theme.style.danger(t(locale, 'failed'))}` : '';
    return [fillCanvas(theme, ` ${paint(compact(commandLine(entry), inner - 8, theme.glyphs.ellipsis))}${status}`, width)];
  }
  if (isMessage(entry)) {
    const text = entry.detail?.trim() || (entry.title === 'Writing' ? t(locale, 'writing', { product }) : entry.title);
    return wrapBodyLine(text, inner).map((line) => fillCanvas(theme, ` ${paint(line)}`, width));
  }
  const fallback = entry.detail?.split(/\r?\n/)[0] || entry.title;
  const line = compact(fallback, inner, theme.glyphs.ellipsis);
  return [fillCanvas(theme, ` ${selected ? theme.style.strong(line) : paint(line)}`, width)];
}

function liveCaption(entry: TimelineEntry, elapsed?: string): string {
  const title = entry.title.replace(/^Candidate · /, '');
  if (title === 'working') return elapsed ? `working · ${elapsed}` : 'working';
  return entry.detail ? `${title} ${entry.detail}` : title;
}

function visibleNow(entries: readonly TimelineEntry[]): TimelineEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && !entry.hidden && (entry.kind === 'live' || entry.placeholder) && entry.itemId?.startsWith('now:')) {
      return entry;
    }
  }
  return undefined;
}

function liveStatusLine(theme: Theme, live: TimelineEntry | undefined, locale: Locale, elapsed: string, tick: number, product: string): string {
  const pulse = Math.floor(tick / 400) % 2 === 0 ? '*' : theme.glyphs.empty;
  const role = liveStatusRole(live, locale, product);
  const action = live ? liveCaption(live) : 'working';
  return ` ${pulse} ${role} · ${action} · ${elapsed}`;
}

function liveStatusRole(live: TimelineEntry | undefined, locale: Locale, product: string): string {
  if (live?.lane === 'recovery') return t(locale, 'recoveryRole');
  if (live?.lane === 'controller') return t(locale, 'controllerLegend');
  if (live?.lane === 'comparison') return t(locale, 'comparisonLegend');
  return product || t(locale, 'candidateRole');
}

function isCandidate(entry: TimelineEntry): boolean {
  return entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane);
}

function fillCanvas(theme: Theme, text: string, width: number): string {
  return theme.style.fillCanvas(pad(text, width, theme.glyphs.ellipsis));
}

function inputText(entry: TimelineEntry): string {
  if (entry.title.startsWith('Prompt ·')) return entry.title.slice('Prompt · '.length) || entry.detail || entry.title;
  return entry.detail?.trim() || entry.title;
}

function isCommand(entry: TimelineEntry): boolean {
  return entry.title.includes('pwsh') || entry.title.startsWith('Running ·') || Boolean(entry.detail?.startsWith('$ '));
}

function isMessage(entry: TimelineEntry): boolean {
  return entry.title === 'Visible response' || entry.title === 'Writing' || entry.title.startsWith('Visible response');
}

function isQuietMcpStatus(entry: TimelineEntry): boolean {
  if (entry.level === 'error' || entry.level === 'warning') return false;
  return /^MCP · \S+ (ready|ok|connected|started)$/i.test(entry.title);
}

function commandLine(entry: TimelineEntry): string {
  const fromDetail = entry.detail?.split(/\r?\n/).find((line) => line.startsWith('$ '));
  if (fromDetail) return fromDetail;
  return `$ ${entry.title.replace(/^Running · /, '')}`;
}

function commandFailed(entry: TimelineEntry): boolean {
  return entry.level === 'error' || Boolean(entry.detail && /exit [1-9]/.test(entry.detail));
}
