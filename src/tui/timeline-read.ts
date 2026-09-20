import type { TimelineEntry } from './timeline.js';

/** Stable identity for reading position across append, fold, and filter. */
export function timelineIdentity(entry: TimelineEntry): string {
  if (entry.itemId) return `id:${entry.itemId}`;
  // Prefer composite activity identity from the index (not raw toolCallId).
  if (entry.correlationId) return `corr:${entry.correlationId}`;
  const ref = entry.eventRefs?.[0];
  if (ref) return `ev:${ref.eventId}`;
  return `seq:${entry.sequence}`;
}

/**
 * Restore selection from a stable anchor.
 * Missing anchors (filtered/folded away) resolve to the nearest still-visible predecessor —
 * never jump straight to the live bottom.
 */
export function restoreTimelineSelection(
  visible: readonly TimelineEntry[],
  anchor: string | undefined,
  previousSelected = 0,
): { selected: number; following: boolean } {
  if (!visible.length) return { selected: 0, following: true };
  const last = visible.length - 1;
  if (!anchor) return { selected: last, following: true };
  const index = visible.findIndex((entry) => timelineIdentity(entry) === anchor);
  if (index >= 0) return { selected: index, following: index === last };
  const selected = nearestVisiblePredecessor(visible, anchor, previousSelected);
  return { selected, following: selected === last };
}

function nearestVisiblePredecessor(
  visible: readonly TimelineEntry[],
  anchor: string,
  previousSelected: number,
): number {
  const last = visible.length - 1;
  const seq = sequenceFromAnchor(anchor);
  if (seq !== undefined) {
    let best = -1;
    for (let index = 0; index < visible.length; index += 1) {
      if (visible[index]!.sequence <= seq) best = index;
    }
    // Nothing at-or-before the missing seq: hold the earliest visible row, not live end.
    return best >= 0 ? best : 0;
  }
  // Identity-only anchors without a sequence: stay near the prior selection, never snap to live end.
  return Math.max(0, Math.min(previousSelected, last));
}

function sequenceFromAnchor(anchor: string): number | undefined {
  const seq = /^seq:(\d+)$/.exec(anchor);
  if (seq) return Number(seq[1]);
  return undefined;
}

export type TimelineReadState = {
  timelineFollowing: boolean;
  timelineSelected: number;
  timelineAnchor: string | undefined;
  timelineReadOffset?: number;
  visibleTimeline(): readonly TimelineEntry[];
};

export type FindRestoreSnapshot = {
  readonly anchor: string | undefined;
  readonly following: boolean;
  readonly offset: number;
  readonly selected: number;
};

export function captureFindRestore(c: TimelineReadState): FindRestoreSnapshot {
  return {
    anchor: c.timelineAnchor,
    following: c.timelineFollowing,
    offset: c.timelineReadOffset ?? 0,
    selected: c.timelineSelected,
  };
}

export function applyFindRestore(c: TimelineReadState, snapshot: FindRestoreSnapshot): void {
  c.timelineAnchor = snapshot.anchor;
  c.timelineFollowing = snapshot.following;
  c.timelineReadOffset = snapshot.offset;
  c.timelineSelected = snapshot.selected;
  syncTimelineSelection(c);
}

export function syncTimelineSelection(c: TimelineReadState): void {
  const previous = c.timelineAnchor;
  const previousOffset = c.timelineReadOffset ?? 0;
  const visible = c.visibleTimeline();
  if (c.timelineFollowing) {
    c.timelineSelected = Math.max(0, visible.length - 1);
    const current = visible[c.timelineSelected];
    if (current) c.timelineAnchor = timelineIdentity(current);
    c.timelineReadOffset = 0;
    return;
  }
  const restored = restoreTimelineSelection(visible, previous, c.timelineSelected);
  c.timelineSelected = restored.selected;
  c.timelineFollowing = restored.following;
  const current = visible[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  // Keep wrapped-line offset when the same entry stays selected; reset only on identity change.
  c.timelineReadOffset = c.timelineAnchor === previous ? previousOffset : 0;
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

/**
 * Public search corpus for one entry: title + full on-screen public text.
 * Omits private original dumps. Fold leaf names in detail remain searchable.
 */
export function publicSearchCorpus(entry: TimelineEntry): readonly string[] {
  const parts = [entry.title];
  if (isVisibleMessage(entry)) {
    if (entry.detail) parts.push(entry.detail);
  } else if (entry.detail) {
    // Public detail (command preview, fold summary, tool tip) — never original dump.
    parts.push(entry.detail);
  }
  return parts;
}

/** Visible title and full public text. Omits original dumps and long tool bodies. */
function canvasHaystack(entry: TimelineEntry): string {
  return publicSearchCorpus(entry).join('\n');
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

/**
 * Cache key for a public search corpus: rebuild only when public content revision changes,
 * never on clock ticks alone.
 */
export function publicSearchCorpusKey(
  entries: readonly TimelineEntry[],
  timelineRevision: number,
): string {
  return `${timelineRevision}:${entries.length}:${entries.map((entry) => timelineIdentity(entry)).join(',')}`;
}

function isVisibleMessage(entry: TimelineEntry): boolean {
  return entry.kind === 'narrate'
    || entry.title.startsWith('Input to Target')
    || entry.title.startsWith('Prompt ·')
    || entry.title === 'Writing'
    || entry.title.startsWith('Visible response');
}
