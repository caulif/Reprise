import { text, type JsonRecord } from '../core/json.js';
import type { AgentLane } from './agent-activity.js';
import { timelineIdentity } from './timeline-read.js';
import type { TimelineEntry } from './timeline.js';

export function projectAssistantVisible(payload: JsonRecord): {
  title: string;
  detail: string;
  extra: { lane: AgentLane; kind: 'narrate'; count: number };
} {
  const textBody = text(payload.text) ?? '';
  const role = payload.role === 'controller' || payload.role === 'comparison' ? payload.role : 'recovery';
  const first = textBody.split(/\n/)[0]?.trim() ?? '';
  return {
    title: first || '…',
    detail: textBody,
    extra: { lane: role, kind: 'narrate', count: 1 },
  };
}

export function paneOf(entry: TimelineEntry): 'left' | 'right' | 'both' | undefined {
  if (entry.hidden) return undefined;
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·')) return 'both';
  if (entry.source === 'TARGET' && !entry.lane) return 'right';
  if (entry.lane === 'controller' || entry.title.startsWith('Decision:') || entry.title.startsWith('Controller')) return 'left';
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
  for (const [index, turn] of turns.entries()) {
    const last = index === turns.length - 1;
    if (last) {
      out.push(...foldCurrentTurn(turn, expandedIds));
      continue;
    }
    const id = `fold:turn:${index + 1}`;
    if (expandedIds.has(id)) {
      out.push(...turn);
      continue;
    }
    const sent = turn.find((entry) => entry.title.startsWith('Input to Target'));
    const preview = (sent?.detail ?? sent?.title ?? '').replace(/\s+/g, ' ').slice(0, 48);
    out.push({
      sequence: turn.at(-1)?.sequence ?? index,
      occurredAt: turn.at(-1)?.occurredAt ?? '',
      source: 'CONTROLLER',
      title: `▸ 第 ${index + 1} 轮 · SEND · ${preview}`,
      lane: 'controller',
      kind: 'fold',
      itemId: id,
      count: turn.length,
    });
  }
  return out;
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
    if (current.length && entry.title.startsWith('Decision:')) {
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
    const preview = (tools[0]?.detail ?? tools[0]?.title ?? "").replace(/\s+/g, " ").slice(0, 40);
    out.push({
      sequence: tools.at(-1)?.sequence ?? 0,
      occurredAt: tools.at(-1)?.occurredAt ?? "",
      source: tools[0]?.source ?? "HARNESS",
      title: `▸ 工具  ${preview} · ×${tools.length}`,
      ...(lane ? { lane } : {}),
      kind: "fold",
      itemId: thinkFoldId(tools),
      count: tools.length,
    });
    tools = [];
  };
  for (const entry of turn) {
    if (entry.kind === "investigate" || entry.kind === "live") {
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
