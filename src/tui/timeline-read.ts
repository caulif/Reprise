import type { TimelineEntry } from './timeline.js';

/** Stable identity for reading position across append, fold, and filter. */
export function timelineIdentity(entry: TimelineEntry): string {
  return entry.itemId ? `id:${entry.itemId}` : `seq:${entry.sequence}`;
}

export function restoreTimelineSelection(
  visible: readonly TimelineEntry[],
  anchor: string | undefined,
): { selected: number; following: boolean } {
  if (!visible.length) return { selected: 0, following: true };
  const last = visible.length - 1;
  if (!anchor) return { selected: last, following: true };
  const index = visible.findIndex((entry) => timelineIdentity(entry) === anchor);
  if (index < 0) return { selected: last, following: false };
  return { selected: index, following: index === last };
}

export type TimelineReadState = {
  timelineFollowing: boolean;
  timelineSelected: number;
  timelineAnchor: string | undefined;
  timelineReadOffset?: number;
  visibleTimeline(): readonly TimelineEntry[];
};

export function syncTimelineSelection(c: TimelineReadState): void {
  const previous = c.timelineAnchor;
  const visible = c.visibleTimeline();
  if (c.timelineFollowing) {
    c.timelineSelected = Math.max(0, visible.length - 1);
    const current = visible[c.timelineSelected];
    if (current) c.timelineAnchor = timelineIdentity(current);
    c.timelineReadOffset = 0;
    return;
  }
  const restored = restoreTimelineSelection(visible, previous);
  c.timelineSelected = restored.selected;
  c.timelineFollowing = restored.following;
  const current = visible[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  if (c.timelineAnchor !== previous) c.timelineReadOffset = 0;
}

export function canvasHitIndices(entries: readonly TimelineEntry[], query: string): number[] {
  if (!query.trim()) return [];
  return entries.flatMap((entry, index) => (matchesCanvasQuery(entry, query) ? [index] : []));
}

export function nextHitIndex(hits: readonly number[], current: number, direction: 1 | -1): number {
  if (!hits.length) return current;
  if (direction > 0) return hits.find((index) => index > current) ?? hits[0]!;
  return [...hits].reverse().find((index) => index < current) ?? hits.at(-1)!;
}

/** Visible title and short on-screen text. Omits original dumps and long tool bodies. */
function canvasHaystack(entry: TimelineEntry): string {
  const parts = [entry.title];
  const first = entry.detail?.split(/\r?\n/)[0] ?? '';
  if (isVisibleMessage(entry)) {
    if (entry.detail) parts.push(entry.detail);
  } else if (first.startsWith('$ ')) {
    parts.push(first);
  } else if (entry.detail && !entry.original) {
    parts.push(first);
  }
  return parts.join('\n');
}

export function matchesCanvasQuery(entry: TimelineEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return canvasHaystack(entry).toLowerCase().includes(needle);
}

export function corpusMatchesQuery(corpus: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return corpus.some((part) => part.toLowerCase().includes(needle));
}

function isVisibleMessage(entry: TimelineEntry): boolean {
  return entry.kind === 'narrate'
    || entry.title.startsWith('Input to Target')
    || entry.title.startsWith('Prompt ·')
    || entry.title === 'Writing'
    || entry.title.startsWith('Visible response');
}
