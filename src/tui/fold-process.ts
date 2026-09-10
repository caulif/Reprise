import { projectAssistantVisible, uniqueLeafNames } from './agent-activity.js';
import { timelineIdentity } from './timeline-read.js';
import type { TimelineEntry } from './timeline.js';

export { projectAssistantVisible };

export function paneOf(entry: TimelineEntry): 'left' | 'right' | 'both' | undefined {
  if (entry.hidden) return undefined;
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·')) return 'both';
  if (entry.source === 'TARGET' && !entry.lane) return 'right';
  if (entry.lane === 'controller' || entry.title.startsWith('Input to Target') || entry.title.startsWith('DONE ·') || entry.title.startsWith('控制Agent')) return 'left';
  if (entry.lane === 'recovery' || entry.lane === 'comparison') return 'left';
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

export function foldProcessEntries(
  entries: readonly TimelineEntry[],
  expandedIds: ReadonlySet<string>,
): TimelineEntry[] {
  const turns = groupTurns(entries);
  const out: TimelineEntry[] = [];
  const unfoldFrom = Math.max(0, turns.length - 2);
  for (const [index, turn] of turns.entries()) {
    const last = index === turns.length - 1;
    if (last || index >= unfoldFrom) {
      out.push(...(last ? foldCurrentTurn(turn, expandedIds) : [...turn]));
      continue;
    }
    const id = `fold:turn:${index + 1}`;
    if (expandedIds.has(id)) {
      out.push(...turn);
      continue;
    }
    const sent = turn.find((entry) => entry.title.startsWith('Input to Target'));
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
    });
  }
  return expandFoldLeaves(out, expandedIds);
}

export function coveringFoldIds(entries: readonly TimelineEntry[], target: TimelineEntry): string[] {
  const ids: string[] = [];
  const turns = groupTurns(entries);
  for (const [index, turn] of turns.entries()) {
    if (!turn.some((entry) => timelineIdentity(entry) === timelineIdentity(target) || entry.sequence === target.sequence)) {
      continue;
    }
    const last = index === turns.length - 1;
    if (!last) ids.push(`fold:turn:${index + 1}`);
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
    if (current.length && (entry.title.startsWith('Input to Target') || entry.title.startsWith('DONE ·'))) {
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
    if (tools.length < 2 || expandedIds.has(thinkFoldId(tools))) {
      out.push(...tools);
      tools = [];
      return;
    }
    const lane = tools[0]?.lane;
    const write = tools.find((item) => item.kind === 'deliver' || /写入/.test(item.title));
    const title = write && tools.every((item) => item.kind === 'deliver' || /写入/.test(item.title))
      ? `▸ 写入 ${write.detail ?? write.title}`
      : `▸ 阅读证据 · ${tools.length}`;
    out.push({
      sequence: tools.at(-1)?.sequence ?? 0,
      occurredAt: tools.at(-1)?.occurredAt ?? "",
      source: tools[0]?.source ?? "HARNESS",
      title,
      ...(lane ? { lane } : {}),
      kind: "fold",
      itemId: thinkFoldId(tools),
      count: tools.length,
    });
    tools = [];
  };
  for (const entry of turn) {
    if (entry.kind === "live" && entry.itemId?.startsWith("now:")) {
      flush();
      out.push(entry);
      continue;
    }
    if (entry.kind === "investigate") {
      tools.push(entry);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

function thinkFoldId(turn: readonly TimelineEntry[]): string {
  return `fold:think:${turn[0]?.sequence ?? 0}`;
}

function foldLeafNames(detail: string | undefined): string[] {
  return uniqueLeafNames((detail ?? '').split(/[·,]/));
}

function expandFoldLeaves(entries: readonly TimelineEntry[], expandedIds: ReadonlySet<string>): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (entry.kind !== 'fold' || !entry.itemId || !expandedIds.has(entry.itemId)) continue;
    for (const name of foldLeafNames(entry.detail)) {
      out.push({
        sequence: entry.sequence,
        occurredAt: entry.occurredAt,
        source: entry.source,
        title: `⎿ ${name}`,
        ...(entry.lane ? { lane: entry.lane } : {}),
        ...(entry.voice ? { voice: entry.voice } : {}),
      });
    }
  }
  return out;
}

function wouldHideInThinkFold(turn: readonly TimelineEntry[], target: TimelineEntry): boolean {
  let tools: TimelineEntry[] = [];
  for (const entry of turn) {
    if (entry.kind === "investigate" || entry.kind === "live") {
      tools.push(entry);
      continue;
    }
    if (tools.length >= 2 && tools.some((item) => item.sequence === target.sequence)) return true;
    tools = [];
  }
  return tools.length >= 2 && tools.some((item) => item.sequence === target.sequence);
}
