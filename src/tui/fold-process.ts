import {
  entryRole,
  isPresentedInput,
  isTurnBoundary,
  projectAssistantVisible,
  uniqueLeafNames,
} from './agent-activity.js';
import { mergeEventRefs } from './activity-index.js';
import { timelineIdentity } from './timeline-read.js';
import { expandedFoldsKey, timelineEntriesKey } from './timeline-revision.js';
import { isNowRow, type TimelineEntry } from './timeline.js';

export { projectAssistantVisible };

export function paneOf(entry: TimelineEntry): 'left' | 'right' | 'both' | undefined {
  if (entry.hidden) return undefined;
  if (isPresentedInput(entry)) return 'both';
  const role = entryRole(entry);
  if (role === 'candidate') return 'right';
  if (role === 'controller' || role === 'recovery' || role === 'comparison') return 'left';
  // Legacy rows without structured role: keep prior source/lane fallback.
  if (entry.source === 'TARGET' && !entry.lane) return 'right';
  if (entry.lane === 'controller' || entry.lane === 'recovery' || entry.lane === 'comparison') return 'left';
  if (entry.source === 'CONTROLLER') return 'left';
  if (entry.level === 'error' && entry.source === 'TARGET') return 'right';
  return undefined;
}

export function splitRunEntries(entries: readonly TimelineEntry[]): { left: TimelineEntry[]; right: TimelineEntry[] } {
  const left: TimelineEntry[] = [];
  const right: TimelineEntry[] = [];
  for (const entry of entries) {
    const pane = paneOf(entry);
    if (pane === 'left' || pane === 'both') left.push(entry);
    if (pane === 'right' || pane === 'both') right.push(entry);
  }
  return { left, right };
}

let foldProcessCache: {
  timelineRevision: number;
  expanded: string;
  entriesKey: string;
  result: TimelineEntry[];
} | undefined;

/** Test hook: reset memoized fold output between cases. */
export function resetFoldProcessCache(): void {
  foldProcessCache = undefined;
}

export function foldProcessEntries(
  entries: readonly TimelineEntry[],
  expandedIds: ReadonlySet<string>,
  timelineRevision = -1,
): TimelineEntry[] {
  const expanded = expandedFoldsKey([...expandedIds]);
  const entriesKey = timelineEntriesKey(entries);
  const cached = foldProcessCache;
  if (
    timelineRevision >= 0
    && cached
    && cached.timelineRevision === timelineRevision
    && cached.expanded === expanded
    && cached.entriesKey === entriesKey
  ) {
    return cached.result;
  }
  const turns = groupTurns(entries);
  const out: TimelineEntry[] = [];
  const unfoldFrom = Math.max(0, turns.length - 2);
  for (const [index, turn] of turns.entries()) {
    const last = index === turns.length - 1;
    if (last || index >= unfoldFrom) {
      out.push(...(last ? foldCurrentTurn(turn, expandedIds) : [...turn]));
      continue;
    }
    const id = turnFoldId(turn);
    if (expandedIds.has(id)) {
      out.push(...turn);
      continue;
    }
    const sent = turn.find((entry) => isPresentedInput(entry) && !entry.title.startsWith('Prompt ·'));
    const preview = (sent?.detail ?? sent?.title ?? '').replace(/\s+/g, ' ').slice(0, 48);
    const probe = sent?.title.includes('verify') || sent?.title.includes('探测');
    out.push({
      sequence: turn.at(-1)?.sequence ?? index,
      occurredAt: turn.at(-1)?.occurredAt ?? '',
      source: 'CONTROLLER',
      title: `▸ 第 ${index + 1} 轮 · ${probe ? '探测' : '后续'} · ${preview}`,
      lane: 'controller',
      kind: 'fold',
      itemId: id,
      count: turn.length,
      role: 'controller',
      ...mergeRefs(turn),
    });
  }
  const result = expandFoldLeaves(out, expandedIds);
  if (timelineRevision >= 0) foldProcessCache = { timelineRevision, expanded, entriesKey, result };
  return result;
}

export function coveringFoldIds(entries: readonly TimelineEntry[], target: TimelineEntry): string[] {
  const ids: string[] = [];
  const turns = groupTurns(entries);
  for (const turn of turns) {
    if (!turn.some((entry) => timelineIdentity(entry) === timelineIdentity(target) || entry.sequence === target.sequence)) {
      continue;
    }
    const last = turns[turns.length - 1] === turn;
    if (!last) ids.push(turnFoldId(turn));
    const thinkId = thinkFoldId(turn);
    if (thinkId && turn[0] && wouldHideInThinkFold(turn, target)) ids.push(thinkId);
  }
  return ids;
}

export function selectedIndexAfterFold(
  unfolded: readonly TimelineEntry[],
  folded: readonly TimelineEntry[],
  selected: TimelineEntry | undefined,
): number {
  if (!selected || !folded.length) return 0;
  const id = timelineIdentity(selected);
  const direct = folded.findIndex((entry) => timelineIdentity(entry) === id);
  if (direct >= 0) return direct;
  const covering = new Set(coveringFoldIds(unfolded, selected));
  const foldRow = folded.findIndex((entry) => entry.itemId !== undefined && covering.has(entry.itemId));
  return foldRow >= 0 ? foldRow : 0;
}

function groupTurns(entries: readonly TimelineEntry[]): TimelineEntry[][] {
  const turns: TimelineEntry[][] = [[]];
  for (const entry of entries) {
    const current = turns.at(-1) ?? [];
    if (current.length && isTurnBoundary(entry)) {
      turns.push([entry]);
      continue;
    }
    current.push(entry);
    if (turns.at(-1) !== current) turns[turns.length - 1] = current;
  }
  return turns.filter((turn) => turn.length);
}

function foldCurrentTurn(turn: readonly TimelineEntry[], expandedIds: ReadonlySet<string>): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let tools: TimelineEntry[] = [];
  const flush = () => {
    if (!tools.length) return;
    // Active live/now rows stay outside historical folds.
    const historical = tools.filter((item) => !isNowRow(item) && item.activityStatus !== 'started');
    const active = tools.filter((item) => isNowRow(item) || item.activityStatus === 'started');
    if (historical.length < 2 || expandedIds.has(thinkFoldId(historical))) {
      out.push(...tools);
      tools = [];
      return;
    }
    const lane = historical[0]?.lane;
    const role = entryRole(historical[0]!);
    const write = historical.find((item) => item.kind === 'deliver' || item.verb === 'write' || /写入/.test(item.title));
    const callCount = historical.reduce((sum, item) => sum + (item.count ?? 1), 0);
    const objects = uniqueLeafNames(historical.flatMap((item) => [
      ...(item.object ? [item.object] : []),
      ...(item.detail ? item.detail.split(/[·,]/) : []),
    ]));
    const title = write && historical.every((item) => item.kind === 'deliver' || item.verb === 'write' || /写入/.test(item.title))
      ? `▸ 写入 ${write.detail ?? write.object ?? write.title}`
      : objects.length > 0
        ? `▸ 阅读证据 · ${callCount}次 · ${objects.length}项`
        : `▸ 阅读证据 · ${callCount}`;
    out.push({
      sequence: historical.at(-1)?.sequence ?? 0,
      occurredAt: historical.at(-1)?.occurredAt ?? '',
      source: historical[0]?.source ?? 'HARNESS',
      title,
      ...(lane ? { lane } : {}),
      ...(role ? { role } : {}),
      kind: 'fold',
      itemId: thinkFoldId(historical),
      count: callCount,
      ...mergeRefs(historical),
      ...(objects.length ? { detail: objects.join(' · '), object: objects.join(' · ') } : {}),
    });
    out.push(...active);
    tools = [];
  };
  for (const entry of turn) {
    if (entry.kind === 'live' && entry.itemId?.startsWith('now:')) {
      flush();
      out.push(entry);
      continue;
    }
    const previous = tools.at(-1);
    if (entry.kind === 'investigate' && entry.level !== 'error' && sameActivityScope(previous, entry)) {
      tools.push(entry);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

function mergeRefs(entries: readonly TimelineEntry[]): { readonly eventRefs?: readonly import('./activity-index.js').ActivityEventRef[] } {
  const refs = entries.reduce<readonly import('./activity-index.js').ActivityEventRef[]>(
    (all, entry) => mergeEventRefs(all, entry.eventRefs),
    [],
  );
  return refs.length ? { eventRefs: refs } : {};
}

function sameActivityScope(previous: TimelineEntry | undefined, next: TimelineEntry): boolean {
  if (!previous) return true;
  const previousRole = entryRole(previous);
  const nextRole = entryRole(next);
  if (previousRole !== nextRole) return false;
  if (previous.sessionId && next.sessionId && previous.sessionId !== next.sessionId) return false;
  if (previous.turnId && next.turnId && previous.turnId !== next.turnId) return false;
  if (previous.lane && next.lane && previous.lane !== next.lane) return false;
  return true;
}

export function collapseEndedThinkFolds(entries: readonly TimelineEntry[], expandedIds: readonly string[]): string[] {
  const turns = groupTurns(entries);
  if (turns.length <= 1) return [...expandedIds];
  const stale = new Set<string>();
  for (const turn of turns.slice(0, -1)) {
    if (turn.some((entry) => entry.kind === 'investigate')) stale.add(thinkFoldId(turn));
  }
  return expandedIds.filter((id) => !stale.has(id) && !id.startsWith('excerpt:'));
}

function turnFoldId(turn: readonly TimelineEntry[]): string {
  const head = turn[0];
  return head ? `fold:turn:${timelineIdentity(head)}` : 'fold:turn:empty';
}

function thinkFoldId(turn: readonly TimelineEntry[]): string {
  const head = turn[0];
  return head ? `fold:think:${timelineIdentity(head)}` : 'fold:think:empty';
}

function foldLeafNames(detail: string | undefined): string[] {
  return uniqueLeafNames((detail ?? '').split(/[·,]/));
}

export function expandFoldLeaves(entries: readonly TimelineEntry[], expandedIds: ReadonlySet<string>): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (entry.kind !== 'fold' || !entry.itemId || !expandedIds.has(entry.itemId)) continue;
    for (const name of foldLeafNames(entry.detail ?? entry.object)) {
      out.push({
        sequence: entry.sequence,
        occurredAt: entry.occurredAt,
        source: entry.source,
        title: `⎿ ${name}`,
        ...(entry.lane ? { lane: entry.lane } : {}),
        ...(entry.voice ? { voice: entry.voice } : {}),
        ...(entry.role ? { role: entry.role } : {}),
      });
    }
  }
  return out;
}

function wouldHideInThinkFold(turn: readonly TimelineEntry[], target: TimelineEntry): boolean {
  let tools: TimelineEntry[] = [];
  for (const entry of turn) {
    if (entry.kind === 'investigate' || entry.kind === 'live') {
      tools.push(entry);
      continue;
    }
    if (tools.length >= 2 && tools.some((item) => item.sequence === target.sequence)) return true;
    tools = [];
  }
  return tools.length >= 2 && tools.some((item) => item.sequence === target.sequence);
}
