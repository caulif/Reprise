import {
  activityRoleLabel,
  entryRole,
  excerptId,
  isPresentedInput,
  toolCaption,
} from './agent-activity.js';
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
  if (isPresentedInput(entry)) return 'input';
  const role = entryRole(entry);
  if (role === 'candidate') return 'product';
  if (role === 'controller') return 'controller';
  if (role === 'recovery' || role === 'comparison') return 'summary';
  if (role === 'system') {
    if (entry.level === 'error') return 'product';
    if (entry.kind === 'deliver' || entry.kind === 'narrate') return 'summary';
    return undefined;
  }
  // Legacy title fallback when structured role is absent.
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·')) return 'input';
  if (entry.title.startsWith('⎿ ')) {
    if (entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane)) return 'product';
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    return 'controller';
  }
  if (entry.kind === 'narrate') {
    if (entry.lane === 'comparison' || entry.lane === 'recovery') return 'summary';
    return 'controller';
  }
  if (entry.kind === 'thinking' || entry.kind === 'fold') {
    if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'summary';
    if (entry.voice === 'candidate' || entry.source === 'TARGET') return 'product';
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
  following = true,
  timelineRevision = -1,
  expandedIds: ReadonlySet<string> = new Set(),
): string[] {
  return layoutScrollback(theme, width, entries, selected, locale, product, height, tick, readingOffset, elapsed, following, timelineRevision, expandedIds).lines;
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
  expandedIds: ReadonlySet<string>,
): ScrollbackBody {
  const key = timelineRevision >= 0
    ? `${timelineRevision}:${selected}:${width}:${locale}:${product}:${timelineEntriesKey(entries)}:${[...expandedIds].join(',')}`
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
    const painted = paintEntryCached(theme, entry, index === selected, width, locale, product, tick, timelineRevision, expandedIds);
    if (index === selected) selectedAt = lines.length;
    if (index > selected) behind += 1;
    hits.push({
      y: lines.length,
      index,
      fold: entry.kind === 'fold' || entry.title.startsWith('▸') || expandableExcerpt(entry, width, expandedIds),
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
  expandedIds: ReadonlySet<string> = new Set(),
): { lines: string[]; hits: CanvasHit[]; selectedAt: number; start: number; total: number; chrome: number } {
  const { lines, hits, selectedAt, behind, live } = layoutScrollbackBody(theme, width, entries, selected, locale, product, tick, timelineRevision, expandedIds);
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
  expandedIds: ReadonlySet<string>,
): string[] {
  const pulse = Math.floor(tick / 400);
  const excerptExpanded = expandedIds.has(excerptId(entry));
  if (timelineRevision < 0) return paintEntry(theme, entry, selected, width, locale, product, tick, excerptExpanded);
  const cacheKey = `${timelineRevision}:${timelineIdentity(entry)}:${entry.sequence}:${selected}:${width}:${locale}:${product}:${pulse}:${entry.detail?.length ?? 0}:${entry.title.length}:${entry.kind ?? ''}:${excerptExpanded ? 1 : 0}`;
  const cached = entryPaintCache.get(cacheKey);
  if (cached) return cached;
  const painted = paintEntry(theme, entry, selected, width, locale, product, tick, excerptExpanded);
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
  excerptExpanded = false,
): string[] {
  const inner = Math.max(8, width - 4);
  const failed = entry.level === 'error' || commandFailed(entry);
  const candidate = isCandidate(entry);
  const slot = gutterSlot(entry, failed, candidate);
  if (voiceOf(entry) === 'input') {
    return paintExcerptBody(theme, inputText(entry), inner, width, selected, 'input', locale, excerptExpanded);
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
  if (entry.kind === 'narrate' || isMessage(entry)) {
    const role = activityRoleLabel(entryRole(entry), product, locale);
    const text = (entry.detail ?? entry.title).trim()
      || (entry.title === 'Writing' ? t(locale, 'writing', { product }) : entry.title);
    const body = paintExcerptBody(theme, text, inner, width, selected, slot, locale, excerptExpanded);
    const header = paintPlain(theme, `${gutter(theme, slot)}${theme.style.muted(compact(role, inner, theme.glyphs.ellipsis))}`, width, selected);
    return [header, ...body];
  }
  if (entry.kind === 'deliver' && isDeliverHeadline(entry.title)) {
    const paint = failedTitle(entry.title) ? theme.style.danger : theme.style.ok;
    const role = activityRoleLabel(entryRole(entry), product, locale);
    const lines = [
      paintPlain(theme, `${gutter(theme, slot)}${theme.style.muted(compact(role, inner, theme.glyphs.ellipsis))}`, width, selected),
      ...wrapBodyLine(entry.title, inner).map((line, index) =>
        paintPlain(theme, `${index === 0 ? gutter(theme, slot) : '  '}${paint(line)}`, width, selected)),
    ];
    if (!entry.detail || !selected) return lines;
    return [...lines, ...paintExcerptBody(theme, entry.detail, inner, width, false, 'none', locale, excerptExpanded)];
  }
  if (entry.level === 'error') {
    const caption = toolCaption(entry, locale);
    const count = entry.count && entry.count > 1 ? ` ×${entry.count}` : '';
    const row = `${gutter(theme, 'fail')}${theme.style.danger(compact(`${caption}${count}`, inner, theme.glyphs.ellipsis))}`;
    return [paintPlain(theme, row, width, selected)];
  }
  if (isCommand(entry)) {
    const status = failed ? ` ${theme.style.danger(t(locale, 'failed'))}` : '';
    const row = `${gutter(theme, slot)}${compact(commandLine(entry), inner - 8, theme.glyphs.ellipsis)}${status}`;
    return [paintPlain(theme, row, width, selected)];
  }
  const fallback = entry.detail?.split(/\r?\n/)[0] || entry.title;
  const body = failed ? theme.style.danger(compact(fallback, inner, theme.glyphs.ellipsis)) : compact(fallback, inner, theme.glyphs.ellipsis);
  return [paintPlain(theme, `${gutter(theme, slot)}${selected ? theme.style.strong(body) : body}`, width, selected)];
}

const EXCERPT_LINES = 3;

function expandableExcerpt(entry: TimelineEntry, width: number, expandedIds: ReadonlySet<string>): boolean {
  if (expandedIds.has(excerptId(entry))) return true;
  if (!(entry.kind === 'narrate' || isMessage(entry) || voiceOf(entry) === 'input')) return false;
  const text = voiceOf(entry) === 'input' ? inputText(entry) : (entry.detail ?? entry.title);
  const inner = Math.max(8, width - 4);
  return wrapBodyLine(text.trim(), inner).length > EXCERPT_LINES;
}

function paintExcerptBody(
  theme: Theme,
  text: string,
  inner: number,
  width: number,
  selected: boolean,
  slot: GutterSlot | 'input' | 'none',
  locale: Locale,
  expanded: boolean,
): string[] {
  const wrapped = wrapBodyLine(text.trim(), inner);
  const visible = expanded || wrapped.length <= EXCERPT_LINES
    ? wrapped
    : wrapped.slice(0, EXCERPT_LINES);
  const lines = visible.map((line, index) => {
    const prefix = index === 0
      ? (slot === 'input' ? gutter(theme, 'input') : slot === 'none' ? '  ' : gutter(theme, slot))
      : '  ';
    const fill = slot === 'input'
      ? (selected ? theme.style.fillInputSelected : theme.style.fillInput)
      : undefined;
    const row = `${prefix}${line}`;
    if (fill) return fill(pad(row, width, theme.glyphs.ellipsis));
    return paintPlain(theme, row, width, selected);
  });
  if (!expanded && wrapped.length > EXCERPT_LINES) {
    const remaining = wrapped.length - EXCERPT_LINES;
    lines.push(paintPlain(
      theme,
      `  ${theme.style.muted(t(locale, 'expandRemainingLines', { n: remaining }))}`,
      width,
      selected,
    ));
  } else if (expanded && wrapped.length > EXCERPT_LINES) {
    lines.push(paintPlain(theme, `  ${theme.style.muted(t(locale, 'collapseExcerpt'))}`, width, selected));
  }
  return lines;
}

function isDeliverHeadline(title: string): boolean {
  return title.startsWith('DONE ·') || title === '已恢复' || title === '部分恢复' || title === '无法恢复'
    || title === '对照完成' || title === '证据不足' || title === '对照失败';
}

function failedTitle(title: string): boolean {
  return title === '无法恢复' || title === '对照失败' || title === '证据不足';
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

function liveCaption(entry: TimelineEntry, locale: Locale = 'zh'): string {
  return toolCaption(entry, locale);
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
  const action = live ? liveCaption(live, locale) : t(locale, 'waitingVisibleActivity');
  const left = ` ${pulse} ${role} · ${action}`;
  const clock = elapsed.trim() || '00:00';
  const clockWidth = Math.max(5, clock.length);
  const leftWidth = Math.max(8, width - clockWidth - 1);
  return `${pad(left, leftWidth, theme.glyphs.ellipsis)} ${clock}`;
}

function liveStatusRole(live: TimelineEntry | undefined, locale: Locale, product: string): string {
  return activityRoleLabel(live ? entryRole(live) : undefined, product, locale);
}

function isCandidate(entry: TimelineEntry): boolean {
  return entryRole(entry) === 'candidate' || entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane);
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
