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

/** Expand hidden probe counters into thinking rows while the matching now-row is live. */
export function materializeThinkingChain(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const activeNow = new Set(
    entries
      .filter((entry) => !entry.hidden && isNowRow(entry) && entry.itemId)
      .map((entry) => entry.itemId!),
  );
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.hidden && entry.itemId?.startsWith('flush')) {
      const nowId = FLUSH_NOW[entry.itemId];
      if (nowId && activeNow.has(nowId)) out.push(...thinkingRowsFromFlush(entry));
      continue;
    }
    if (entry.hidden) continue;
    out.push(entry);
  }
  return out;
}

export function projectTimelineView(
  entries: readonly TimelineEntry[],
  expandedIds: ReadonlySet<string>,
): TimelineEntry[] {
  return foldProcessEntries(materializeThinkingChain(entries), expandedIds);
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
    kind: 'investigate',
    itemId: `thinking:${flush.itemId}:${index}`,
    ...(lane ? { lane } : {}),
    ...(voice ? { voice } : {}),
  }));
}
