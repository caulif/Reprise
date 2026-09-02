import { text, type JsonRecord } from '../core/json.js';
import type { TimelineEntry } from './timeline.js';
import type { AgentLane } from './agent-activity.js';

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
  const lastNarrate = [...turn].reverse().find((entry) => entry.kind === 'narrate');
  const lastIndex = lastNarrate ? turn.lastIndexOf(lastNarrate) : -1;
  const earlier = lastIndex > 0 ? turn.slice(0, lastIndex) : [];
  const rest = lastIndex >= 0 ? turn.slice(lastIndex) : [...turn];
  const inspectCount = earlier.filter((entry) => entry.kind === 'investigate' || entry.kind === 'live').reduce((sum, entry) => sum + (entry.count ?? 1), 0);
  const firstLine = earlier.find((entry) => entry.kind === 'narrate')?.title
    ?? earlier.find((entry) => entry.kind === 'investigate')?.detail
    ?? '';
  if (!earlier.length || inspectCount + earlier.filter((entry) => entry.kind === 'narrate').length < 2) return [...turn];
  const id = `fold:think:${turn[0]?.sequence ?? 0}`;
  if (expandedIds.has(id)) return [...turn];
  const preview = firstLine.replace(/\s+/g, ' ').slice(0, 40);
  return [
    {
      sequence: earlier.at(-1)?.sequence ?? 0,
      occurredAt: earlier.at(-1)?.occurredAt ?? '',
      source: 'CONTROLLER',
      title: `▸ 思考  ${preview}${inspectCount ? ` · 调查 ×${inspectCount}` : ''}`,
      ...(turn[0]?.lane ? { lane: turn[0].lane } : {}),
      kind: 'fold',
      itemId: id,
      count: earlier.length,
    },
    ...rest,
  ];
}
