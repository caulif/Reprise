import { uniqueLeafNames } from './agent-activity.js';
import { foldProcessEntries } from './fold-process.js';
import { isNowRow, type TimelineEntry } from './timeline.js';

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
  return injectActiveThinkingRows(folded, full);
}

function injectActiveThinkingRows(folded: readonly TimelineEntry[], full: readonly TimelineEntry[]): TimelineEntry[] {
  const activeNow = new Set(
    full
      .filter((entry) => !entry.hidden && isNowRow(entry) && entry.itemId)
      .map((entry) => entry.itemId!),
  );
  const thinking: TimelineEntry[] = [];
  for (const entry of full) {
    if (!entry.hidden || !entry.itemId?.startsWith('flush')) continue;
    const nowId = FLUSH_NOW[entry.itemId];
    if (!nowId || !activeNow.has(nowId)) continue;
    thinking.push(...thinkingRowsFromFlush(entry));
  }
  if (!thinking.length) return [...folded];
  const nowIndex = folded.findIndex((entry) => isNowRow(entry));
  if (nowIndex < 0) return [...folded, ...thinking];
  return [...folded.slice(0, nowIndex), ...thinking, ...folded.slice(nowIndex)];
}

function thinkingRowsFromFlush(flush: TimelineEntry): TimelineEntry[] {
  const write = flush.itemId?.startsWith('flush-write:');
  const names = uniqueLeafNames((flush.detail ?? '').split(/[·,]/));
  if (!names.length) return [];
  const lane = flush.lane;
  const voice = flush.voice ?? (flush.source === 'TARGET' ? 'candidate' : undefined);
  return names.map((name, index) => ({
    sequence: flush.sequence,
    occurredAt: flush.occurredAt,
    source: flush.source,
    title: write ? '写入' : '阅读',
    detail: name,
    kind: 'thinking',
    itemId: `thinking:${flush.itemId}:${index}`,
    ...(lane ? { lane } : {}),
    ...(voice ? { voice } : {}),
  }));
}
