import { deliverTitleTone, displayLiveCaption, displayOperatorDetail, displayOperatorTitle, isDeliverHeadlineTitle, severityLabel } from './display-copy.js';
import { compact, type TimelineFilter } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import { timelineIdentity } from './timeline-read.js';
import { timelineEntriesKey } from './timeline-revision.js';
import { isNowRow, type TimelineEntry } from './timeline.js';
import { pad, wrapBodyLine } from './widgets.js';

const MAX_ENTRY_PAINT_CACHE = 512;
const entryPaintCache = new Map<string, string[]>();
let scrollbackBodyCache: { key: string; body: ScrollbackBody } | undefined;

type ScrollbackBody = {
  readonly lines: string[];
  readonly hits: CanvasHit[];
  readonly selectedAt: number;
  readonly behind: number;
  readonly live?: TimelineEntry;
};

/** Test hook: reset memoized scrollback paint state between cases. */
export function resetScrollbackLayoutCache(): void {
  entryPaintCache.clear();
  scrollbackBodyCache = undefined;
}

export type Voice = 'input' | 'product' | 'summary' | 'controller';

export type CanvasHit = {
  readonly y: number;
  readonly index: number;
  readonly fold: boolean;
  readonly itemId?: string;
};

type GutterSlot = 'host' | 'candidate' | 'input' | 'fail' | 'fold-host' | 'fold-cand' | 'none';

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
  if (entry.kind === 'thinking') {
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    if (entry.voice === 'candidate' || entry.source === 'TARGET') return 'product';
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
  if (entry.title.startsWith('对照') || entry.title.startsWith('comparison.') || entry.lane === 'comparison' || entry.title.startsWith('Candidate stopped')
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
  following = true,
  timelineRevision = -1,
): string[] {
  return layoutScrollback(theme, width, entries, selected, locale, product, height, tick, readingOffset, elapsed, following, timelineRevision).lines;
}

/** Fold expand/collapse rewrites the painted entry list without bumping timelineRevision. */
function layoutScrollbackBody(
  theme: Theme,
  width: number,
  entries: readonly TimelineEntry[],
  selected: number,
  locale: Locale,
  product: string,
  tick: number,
  timelineRevision: number,
): ScrollbackBody {
  const key = timelineRevision >= 0
    ? `${timelineRevision}:${selected}:${width}:${locale}:${product}:${timelineEntriesKey(entries)}`
    : '';
  const cached = scrollbackBodyCache;
  if (key && cached?.key === key) return cached.body;
  const lines: string[] = [];
  const hits: CanvasHit[] = [];
  let selectedAt = 0;
  let behind = 0;
  const seenInput = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!voiceOf(entry)) continue;
    if (isNowRow(entry)) {
      if (index === selected) selectedAt = lines.length;
      continue;
    }
    if (voiceOf(entry) === 'input') {
      const inputKey = inputText(entry).replace(/\s+/g, ' ').trim();
      if (inputKey && seenInput.has(inputKey)) continue;
      if (inputKey) seenInput.add(inputKey);
    }
    const painted = paintEntryCached(theme, entry, index === selected, width, locale, product, tick, timelineRevision);
    if (index === selected) selectedAt = lines.length;
    if (index > selected) behind += 1;
    hits.push({
      y: lines.length,
      index,
      fold: entry.kind === 'fold' || entry.title.startsWith('▸'),
      ...(entry.itemId ? { itemId: entry.itemId } : {}),
    });
    lines.push(...painted);
  }
  const live = visibleNow(entries);
  const body: ScrollbackBody = live ? { lines, hits, selectedAt, behind, live } : { lines, hits, selectedAt, behind };
  if (key) scrollbackBodyCache = { key, body };
  return body;
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
  following = true,
  timelineRevision = -1,
): { lines: string[]; hits: CanvasHit[]; selectedAt: number; start: number; total: number; chrome: number } {
  const { lines, hits, selectedAt, behind, live } = layoutScrollbackBody(theme, width, entries, selected, locale, product, tick, timelineRevision);
  // Only paint the live now-row when one exists. A missing now-row must not fall back
  // to "<product> · working" — that falsely lingers on the result page after terminal outcome.
  const status = live
    ? fillCanvas(theme, liveStatusLine(theme, live, locale, elapsed, tick, product, width), width)
    : undefined;
  const showFollow = !following && behind > 0;
  const follow = showFollow
    ? fillCanvas(theme, theme.style.muted(pad(` ${theme.framed ? '▼' : '↓'} ${t(locale, 'followNew', { count: behind })}`, width, theme.glyphs.ellipsis)), width)
    : undefined;
  const chrome = (status ? 1 : 0) + (follow ? 1 : 0);
  const withChrome = (body: string[]): string[] => {
    if (status && follow) return [...body, status, follow];
    if (status) return [...body, status];
    if (follow) return [...body, follow];
    return [...body];
  };
  if (!lines.length) {
    const empty = withChrome([]);
    // Keep a blank canvas row when there is no body and no chrome so callers still get a frame.
    const linesOut = empty.length ? empty : [fillCanvas(theme, '', width)];
    return { lines: linesOut, hits, selectedAt: 0, start: 0, total: linesOut.length, chrome };
  }
  if (height === undefined || lines.length + chrome <= height) {
    const padded = padBodyToHeight(theme, lines, width, height, chrome);
    return {
      lines: withChrome(padded),
      hits, selectedAt, start: 0, total: lines.length, chrome,
    };
  }
  const window = Math.max(1, height - chrome);
  const start = Math.max(0, Math.min(selectedAt + readingOffset, lines.length - window));
  const sliced = lines.slice(start, start + window);
  return {
    lines: withChrome(sliced),
    hits: hits.map((hit) => ({ ...hit, y: hit.y - start })).filter((hit) => hit.y >= 0 && hit.y < window),
    selectedAt,
    start,
    total: lines.length,
    chrome,
  };
}

function padBodyToHeight(theme: Theme, lines: readonly string[], width: number, height: number | undefined, chrome: number): string[] {
  if (height === undefined) return [...lines];
  const gap = height - lines.length - chrome;
  if (gap <= 0) return [...lines];
  return [...lines, ...Array.from({ length: gap }, () => fillCanvas(theme, '', width))];
}

/** Keep `selectedAt` inside the sliced window; return the offset consumed by `layoutScrollback`. */
export function keepSelectedVisible(selectedAt: number, offset: number, total: number, height: number): number {
  if (height <= 0 || total <= height) return 0;
  const maxStart = Math.max(0, total - height);
  let start = Math.max(0, Math.min(selectedAt + offset, maxStart));
  if (selectedAt < start) start = selectedAt;
  else if (selectedAt >= start + height) start = selectedAt - height + 1;
  start = Math.max(0, Math.min(start, maxStart));
  return start - selectedAt;
}

export function hitAtBodyRow(hits: readonly CanvasHit[], bodyRow: number): CanvasHit | undefined {
  let hit = hits[0];
  for (const candidate of hits) {
    if (candidate.y <= bodyRow) hit = candidate;
    else break;
  }
  return hit;
}

function paintEntryCached(
  theme: Theme,
  entry: TimelineEntry,
  selected: boolean,
  width: number,
  locale: Locale,
  product: string,
  tick: number,
  timelineRevision: number,
): string[] {
  const pulse = Math.floor(tick / 400);
  if (timelineRevision < 0) return paintEntry(theme, entry, selected, width, locale, product, tick);
  const cacheKey = `${timelineRevision}:${timelineIdentity(entry)}:${entry.sequence}:${selected}:${width}:${locale}:${product}:${pulse}:${entry.detail?.length ?? 0}:${entry.title.length}:${entry.kind ?? ''}`;
  const cached = entryPaintCache.get(cacheKey);
  if (cached) return cached;
  const painted = paintEntry(theme, entry, selected, width, locale, product, tick);
  if (entryPaintCache.size >= MAX_ENTRY_PAINT_CACHE) entryPaintCache.clear();
  entryPaintCache.set(cacheKey, painted);
  return painted;
}

function paintEntry(
  theme: Theme,
  entry: TimelineEntry,
  selected: boolean,
  width: number,
  locale: Locale,
  product: string,
  tick: number,
): string[] {
  const inner = Math.max(8, width - 4);
  const failed = entry.level === 'error' || commandFailed(entry);
  const candidate = isCandidate(entry);
  const slot = gutterSlot(entry, failed, candidate);
  if (voiceOf(entry) === 'input') {
    return wrapBodyLine(inputText(entry), inner).map((line, index) => {
      const prefix = index === 0 ? gutter(theme, 'input') : '  ';
      const row = `${prefix}${line}`;
      const fill = selected ? theme.style.fillInputSelected : theme.style.fillInput;
      return fill(pad(row, width, theme.glyphs.ellipsis));
    });
  }
  if (entry.title.startsWith('⎿ ')) {
    const row = `${gutter(theme, 'none')}${theme.style.muted(compact(entry.title, inner, theme.glyphs.ellipsis))}`;
    return [paintPlain(theme, row, width, selected)];
  }
  if (entry.kind === 'fold' || entry.title.startsWith('▸')) {
    const title = entry.title.startsWith('▸') ? entry.title : `▸ ${entry.title}`;
    const row = `${gutter(theme, slot)}${theme.style.muted(compact(title, inner, theme.glyphs.ellipsis))}`;
    return [paintPlain(theme, row, width, selected)];
  }
  if (entry.kind === 'thinking') {
    const caption = entry.detail ? `${entry.title} ${entry.detail}` : entry.title;
    const row = `${gutter(theme, slot)}${compact(caption, inner, theme.glyphs.ellipsis)}`;
    return [paintPlain(theme, row, width, selected)];
  }
  if (entry.kind === 'live' || entry.placeholder) {
    const color = candidate ? theme.style.gutterTarget : theme.style.gutterHost;
    const pulse = Math.floor(tick / 400) % 2 === 0 ? color(theme.glyphs.dot) : theme.style.muted(theme.glyphs.empty);
    const caption = liveCaption(entry, locale);
    const row = `${gutter(theme, slot)}${pulse} ${compact(caption, inner - 4, theme.glyphs.ellipsis)}`;
    return [theme.style.fillLive(pad(row, width, theme.glyphs.ellipsis))];
  }
  if (entry.kind === 'narrate') {
    const text = (entry.detail ?? entry.title).trim();
    return wrapBodyLine(text, inner).map((line, index) =>
      paintPlain(theme, `${index === 0 ? gutter(theme, slot) : '  '}${line}`, width, selected));
  }
  if (entry.kind === 'deliver' && isDeliverHeadlineTitle(entry.title)) {
    const paintedTitle = displayOperatorTitle(entry.title, locale);
    const tone = deliverTitleTone(entry.title);
    const paint = tone === 'danger' ? theme.style.danger
      : tone === 'warn' ? theme.style.warn
        : theme.style.ok;
    const lines = wrapBodyLine(paintedTitle, inner).map((line, index) =>
      paintPlain(theme, `${index === 0 ? gutter(theme, slot) : '  '}${paint(line)}`, width, selected));
    if (!entry.detail || !selected) return lines;
    const detail = displayOperatorDetail(entry.detail, locale) ?? entry.detail;
    return [...lines, ...wrapBodyLine(detail, inner).map((line) =>
      paintPlain(theme, `  ${theme.style.muted(line)}`, width, false))];
  }
  if (isCommand(entry)) {
    const status = failed ? ` ${theme.style.danger(t(locale, 'failed'))}` : '';
    const row = `${gutter(theme, slot)}${compact(commandLine(entry), inner - 8, theme.glyphs.ellipsis)}${status}`;
    return [paintPlain(theme, row, width, selected)];
  }
  if (isMessage(entry)) {
    const text = entry.detail?.trim() || (entry.title === 'Writing' ? t(locale, 'writing', { product }) : entry.title);
    return wrapBodyLine(text, inner).map((line, index) =>
      paintPlain(theme, `${index === 0 ? gutter(theme, slot) : '  '}${line}`, width, selected));
  }
  const severity = severityLabel(entry.level === 'warning' || entry.level === 'error' ? entry.level : undefined, locale, theme);
  const rawTitle = displayOperatorTitle(entry.title, locale);
  const rawDetail = displayOperatorDetail(entry.detail?.split(/\r?\n/)[0], locale);
  const fallback = rawDetail || rawTitle;
  const marked = severity ? `[${severity}] ${fallback}` : fallback;
  const body = failed ? theme.style.danger(compact(marked, inner, theme.glyphs.ellipsis))
    : entry.level === 'warning' ? theme.style.warn(compact(marked, inner, theme.glyphs.ellipsis))
      : compact(marked, inner, theme.glyphs.ellipsis);
  return [paintPlain(theme, `${gutter(theme, slot)}${selected ? theme.style.strong(body) : body}`, width, selected)];
}

function gutterSlot(entry: TimelineEntry, failed: boolean, candidate: boolean): GutterSlot {
  if (failed) return 'fail';
  if (entry.kind === 'thinking') return candidate ? 'candidate' : 'host';
  if (entry.title.startsWith('⎿ ')) return 'none';
  if (entry.kind === 'fold' || entry.title.startsWith('▸')) return candidate ? 'fold-cand' : 'fold-host';
  if (voiceOf(entry) === 'input') return 'input';
  return candidate ? 'candidate' : 'host';
}

function gutter(theme: Theme, slot: GutterSlot): string {
  if (slot === 'none') return '  ';
  const compactMark = slot === 'candidate' || slot === 'fold-cand' ? ':' : '|';
  const mark = theme.framed ? '▎' : compactMark;
  if (slot === 'input') return `${theme.style.muted(mark)} `;
  if (slot === 'fail') return `${theme.style.danger(mark)} `;
  if (slot === 'fold-host') return `${theme.style.gutterFoldHost(mark)} `;
  if (slot === 'fold-cand') return `${theme.style.gutterFoldTarget(mark)} `;
  if (slot === 'candidate') return `${theme.style.gutterTarget(mark)} `;
  return `${theme.style.gutterHost(mark)} `;
}

function paintPlain(theme: Theme, row: string, width: number, selected: boolean): string {
  const padded = pad(row, width, theme.glyphs.ellipsis);
  return selected ? theme.style.fillLive(padded) : fillCanvas(theme, padded, width);
}

function liveCaption(entry: TimelineEntry, locale: Locale): string {
  return displayLiveCaption(entry.title, entry.detail, locale);
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

function liveStatusLine(
  theme: Theme,
  live: TimelineEntry | undefined,
  locale: Locale,
  elapsed: string,
  tick: number,
  product: string,
  width: number,
): string {
  const pulse = Math.floor(tick / 400) % 2 === 0 ? '*' : theme.glyphs.empty;
  const role = liveStatusRole(live, locale, product);
  const action = live ? liveCaption(live, locale) : t(locale, 'activityWorking');
  const left = ` ${pulse} ${role} · ${action}`;
  const clock = elapsed.trim() || '00:00';
  const clockWidth = Math.max(5, clock.length);
  const leftWidth = Math.max(8, width - clockWidth - 1);
  return `${pad(left, leftWidth, theme.glyphs.ellipsis)} ${clock}`;
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
