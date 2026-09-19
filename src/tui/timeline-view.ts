import { uniqueLeafNames } from './agent-activity.js';
import { expandFoldLeaves, foldProcessEntries } from './fold-process.js';
import { flushFoldTitle, isNowRow, type TimelineEntry } from './timeline.js';

const FLUSH_NOW: Record<string, string> = {
  'flush:candidate': 'now:target',
  'flush-write:candidate': 'now:target',
  'flush:recovery': 'now:recovery',
  'flush-write:recovery': 'now:recovery',
  'flush:controller': 'now:controller',
  'flush-write:controller': 'now:controller',
  'flush:comparison': 'now:comparison',
  'flush-write:comparison': 'now:comparison',
};

/** Fold the visible spine, then inject live probe rows from hidden flush counters. */
export function projectTimelineView(
  full: readonly TimelineEntry[],
  visible: readonly TimelineEntry[],
  expandedIds: ReadonlySet<string>,
  timelineRevision = -1,
): TimelineEntry[] {
  const folded = foldProcessEntries(visible, expandedIds, timelineRevision);
  return injectActiveThinkingRows(folded, full, expandedIds);
}

function injectActiveThinkingRows(
  folded: readonly TimelineEntry[],
  full: readonly TimelineEntry[],
  expandedIds: ReadonlySet<string>,
): TimelineEntry[] {
  const activeNow = new Set(
    full
      .filter((entry) => !entry.hidden && isNowRow(entry) && entry.itemId)
      .map((entry) => entry.itemId!),
  );
  const injected: TimelineEntry[] = [];
  for (const entry of full) {
    if (!entry.hidden || !entry.itemId?.startsWith('flush')) continue;
    const nowId = FLUSH_NOW[entry.itemId];
    if (!nowId || !activeNow.has(nowId)) continue;
    injected.push(...thinkingRowsFromFlush(entry));
  }
  if (!injected.length) return [...folded];
  // Expand only the newly injected flush-fold preview (spine folds already expanded).
  const live = omitTipLeafWhenExpanded(expandFoldLeaves(injected, expandedIds));
  const nowIndex = folded.findIndex((entry) => isNowRow(entry));
  if (nowIndex < 0) return [...folded, ...live];
  return [...folded.slice(0, nowIndex), ...live, ...folded.slice(nowIndex)];
}

/** Tip-only: one live tool tip (latest leaf); completed peers use the canonical flush fold preview. */
function thinkingRowsFromFlush(flush: TimelineEntry): TimelineEntry[] {
  const write = flush.itemId?.startsWith('flush-write:');
  const names = uniqueLeafNames((flush.detail ?? '').split(/[·,]/));
  if (!names.length) return [];
  const lane = flush.lane;
  const voice = flush.voice ?? (flush.source === 'TARGET' ? 'candidate' : undefined);
  const latest = names[names.length - 1]!;
  const base = {
    sequence: flush.sequence,
    occurredAt: flush.occurredAt,
    source: flush.source,
    ...(lane ? { lane } : {}),
    ...(voice ? { voice } : {}),
  };
  const rows: TimelineEntry[] = [];
  if (names.length > 1 && flush.itemId) {
    const count = flush.count ?? names.length;
    rows.push({
      ...base,
      title: flushFoldTitle({ ...flush, count }),
      kind: 'fold',
      itemId: flush.itemId,
      count,
      ...(flush.detail ? { detail: flush.detail } : {}),
    });
  }
  rows.push({
    ...base,
    title: write ? '写入' : '阅读',
    detail: latest,
    kind: 'thinking',
    itemId: `thinking:${flush.itemId}:tip`,
  });
  return rows;
}

/** When the tip row already shows the latest leaf, drop that leaf from expanded ⎿ children. */
function omitTipLeafWhenExpanded(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const tipLeaves = new Set(
    entries.filter((entry) => entry.kind === 'thinking' && entry.detail).map((entry) => entry.detail!),
  );
  if (!tipLeaves.size) return [...entries];
  return entries.filter((entry) => {
    if (!entry.title.startsWith('⎿ ')) return true;
    return !tipLeaves.has(entry.title.slice(2).trim());
  });
}
