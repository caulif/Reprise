import { record, text, type JsonRecord } from '../core/json.js';
import type { TimelineEntry, TimelineSource } from './timeline.js';

export type AgentLane = 'recovery' | 'controller' | 'comparison';
export type AgentKind = 'investigate' | 'mutate' | 'deliver' | 'compact' | 'live';

const INVESTIGATE = new Set(['ls', 'read', 'grep', 'find', 'read_observation']);
const MUTATE = new Set(['powershell', 'edit']);
const READ_PS = /^(Get-ChildItem|Get-Content|Get-[A-Za-z]+)\b/;
const WRITE_PS = /\b(Remove-Item|Set-Content|Copy-Item|New-Item|Move-Item|Out-File)\b/i;

function agentLane(payload: JsonRecord): AgentLane {
  const role = text(payload.role);
  if (role === 'controller' || role === 'comparison') return role;
  return 'recovery';
}

export function laneSource(lane: AgentLane): TimelineSource {
  return lane === 'controller' ? 'CONTROLLER' : 'HARNESS';
}

function laneTitle(lane: AgentLane, verb: string): string {
  const prefix = lane === 'recovery' ? 'Recovery' : lane === 'controller' ? 'Controller' : 'Comparison';
  return `${prefix} · ${verb}`;
}

export function projectAgentTool(
  payload: JsonRecord,
  type: string,
): { title: string; detail?: string; original?: string; extra: {
  hidden?: boolean;
  level?: 'warning' | 'error';
  itemId?: string;
  patch?: 'replace';
  placeholder?: boolean;
  lane: AgentLane;
  kind: AgentKind;
  count?: number;
} } {
  const lane = agentLane(payload);
  const tool = text(payload.tool) ?? 'unknown';
  const failed = type === 'agent.tool_failed';
  const completed = type === 'agent.tool_completed';
  const message = text(payload.message) ?? text(payload.error) ?? '';
  const noGain = failed && /repeated tool call with identical inputs/i.test(message);
  const object = toolObject(payload, tool);
  const kind = toolKind(lane, tool, object.command);
  const gitMissing = isGitMissing(tool, completed, payload);
  if (noGain) {
    return {
      title: `${laneLabel(lane)} tool failed · ${tool}`,
      detail: message,
      extra: { hidden: true, lane, kind, itemId: `live:${lane}`, patch: 'replace' },
    };
  }
  if (failed) {
    return {
      title: `${laneLabel(lane)} tool failed · ${tool}`,
      ...(message ? { detail: message } : {}),
      extra: { level: 'error', lane, kind, itemId: `live:${lane}`, patch: 'replace' },
    };
  }
  const verb = toolVerb(tool, object);
  const title = laneTitle(lane, verb);
  const live = !completed;
  const warnWrite = lane === 'comparison' && kind === 'mutate' && /[\\/]candidate[\\/]/i.test(object.command ?? object.short);
  const detail = gitMissing
    ? '不是 Git 仓库'
    : live
      ? object.short
      : completedDetail(kind, object, tool);
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(object.original && object.original !== detail ? { original: object.original } : {}),
    extra: {
      lane,
      kind: live ? 'live' : kind,
      count: 1,
      itemId: `live:${lane}`,
      patch: 'replace',
      ...(live ? { placeholder: true } : {}),
      ...(warnWrite ? { level: 'warning' as const } : {}),
    },
  };
}

export function projectContextCompacted(payload: JsonRecord): {
  title: string;
  detail: string;
  extra: { lane: AgentLane; kind: 'compact'; count: number; itemId: string; patch: 'replace' };
} {
  const lane = agentLane(payload);
  const replaced = Array.isArray(payload.replaced) ? payload.replaced.length : 1;
  return {
    title: laneTitle(lane, 'compact'),
    detail: `×${replaced}`,
    extra: { lane, kind: 'compact', count: replaced, itemId: `compact:${lane}`, patch: 'replace' },
  };
}

export function collapseAgentRows(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  if (entry.hidden || entry.placeholder || entry.kind === 'live' || entry.kind === 'deliver') return false;
  if (entry.level === 'error') return false;
  if (entry.kind !== 'investigate' && entry.kind !== 'mutate' && entry.kind !== 'compact') return false;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const previous = timeline[index];
    if (!previous || previous.hidden) continue;
    if (previous.placeholder || previous.kind === 'live' || previous.level === 'error') return false;
    if (previous.lane !== entry.lane || previous.kind !== entry.kind) return false;
    if (entry.kind === 'mutate' && mutateKey(previous) !== mutateKey(entry)) return false;
    const count = (previous.count ?? 1) + (entry.count ?? 1);
    const mergedDetail = mergeDetail(previous, entry, count);
    timeline[index] = {
      ...previous,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      detail: mergedDetail,
      count,
      ...(entry.original || previous.original
        ? { original: joinOriginal(previous.original ?? previous.detail, entry.original ?? entry.detail) }
        : {}),
    };
    return true;
  }
  return false;
}

export function lastLiveVerb(entries: readonly TimelineEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.hidden) continue;
    if (entry.placeholder || entry.kind === 'live') return verbFromTitle(entry.title);
    if (entry.lane) return verbFromTitle(entry.title);
    return undefined;
  }
  return undefined;
}

export function phaseIndex(
  lane: AgentLane,
  entries: readonly TimelineEntry[],
): { current: number; labels: readonly ['inspect', 'mutate', 'deliver'] | readonly ['inspect', 'decide', 'deliver'] } {
  const labels = lane === 'controller'
    ? ['inspect', 'decide', 'deliver'] as const
    : ['inspect', 'mutate', 'deliver'] as const;
  let current = 0;
  for (const entry of entries) {
    if (entry.hidden) continue;
    current = Math.max(current, stepFor(lane, entry));
  }
  return { current, labels };
}

function stepFor(lane: AgentLane, entry: TimelineEntry): number {
  if (lane === 'controller') {
    if (entry.title.startsWith('Input to Target')) return 2;
    if (entry.title.startsWith('Decision:')) return 1;
    if (entry.lane === 'controller') return 0;
    return 0;
  }
  if (lane === 'comparison') {
    if (entry.title.startsWith('Comparison completed') || entry.kind === 'deliver') return 2;
    if (entry.lane === 'comparison' && observationSource(entry) === 'transcript') return 1;
    if (entry.lane === 'comparison') return 0;
    return 0;
  }
  if (entry.lane !== 'recovery') return 0;
  if (entry.kind === 'deliver') return 2;
  if (entry.kind === 'mutate' || (entry.kind === 'live' && /powershell|edit/i.test(entry.title))) return 1;
  return 0;
}

export function activeLane(entries: readonly TimelineEntry[], runPhase?: string, preparePhase?: string): AgentLane | undefined {
  if (runPhase === 'recovery') return 'recovery';
  if (preparePhase === 'compare') return 'comparison';
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.hidden) continue;
    if (entry.source === 'TARGET' && !entry.lane) return undefined;
    if (entry.lane) return entry.lane;
    if (isDecision(entry) || entry.title.startsWith('Input to Target')) return 'controller';
    if (entry.title.startsWith('Comparison')) return 'comparison';
    return undefined;
  }
  return undefined;
}

export function actorVerb(entries: readonly TimelineEntry[], lane: AgentLane): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.hidden) continue;
    if (lane === 'controller' && (isDecision(entry) || entry.title.startsWith('Input to Target'))) {
      return isDecision(entry) ? verbFromTitle(entry.title) : 'send';
    }
    if (entry.lane === lane) return verbFromTitle(entry.title);
  }
  return undefined;
}

function laneLabel(lane: AgentLane): string {
  return lane === 'recovery' ? 'Recovery' : lane === 'controller' ? 'Controller' : 'Comparison';
}

function toolKind(lane: AgentLane, tool: string, command: string | undefined): AgentKind {
  if (tool === 'write') return 'deliver';
  if (INVESTIGATE.has(tool)) return 'investigate';
  if (tool === 'powershell' && lane === 'comparison' && command && READ_PS.test(command.trim()) && !WRITE_PS.test(command)) {
    return 'investigate';
  }
  if (MUTATE.has(tool)) return 'mutate';
  return 'investigate';
}

function toolVerb(tool: string, object: { verb?: string }): string {
  if (tool === 'write' || tool === 'edit' || tool === 'powershell' || tool === 'read_observation') return object.verb ?? tool;
  if (INVESTIGATE.has(tool)) return 'inspect';
  return tool;
}

function toolObject(payload: JsonRecord, tool: string): { short: string; original?: string; command?: string; verb?: string } {
  const params = record(payload.params);
  const details = record(payload.details);
  const source = text(params.source) ?? text(details.source);
  if (tool === 'read_observation') {
    return { short: source ?? 'observation', verb: 'read_observation', ...(source ? { original: source } : {}) };
  }
  const path = text(params.path) ?? text(details.path);
  if (path) return { short: leaf(path), original: path, verb: tool === 'write' || tool === 'edit' ? tool : 'inspect' };
  const command = text(params.command);
  if (command) {
    const verb = powershellVerb(command);
    const quoted = command.match(/['"]([^'"]+)['"]/)?.[1];
    const short = [verb, quoted ? leaf(quoted) : undefined].filter(Boolean).join('  ');
    return { short: short || verb || 'powershell', original: command, command, verb: verb ?? 'powershell' };
  }
  return { short: tool, verb: tool };
}

function completedDetail(kind: AgentKind, object: { short: string }, tool: string): string {
  if (kind === 'deliver') return object.short || (tool === 'write' ? 'report' : object.short);
  return object.short;
}

function isGitMissing(tool: string, completed: boolean, payload: JsonRecord): boolean {
  const details = record(payload.details);
  return (tool === 'powershell' && completed && /not a git repository/i.test(text(payload.content) ?? ''))
    || (completed && details.isRepo === false);
}

function leaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base || path;
}

function powershellVerb(command: string): string | undefined {
  const body = unwrapCommand(command);
  return body.match(/\b(Get-ChildItem|Get-Content|Copy-Item|Remove-Item|Set-Content|Get-[A-Za-z]+)\b/)?.[1]
    ?? body.match(/\b([A-Z][A-Za-z]+-[A-Za-z]+)\b/)?.[1];
}

function unwrapCommand(command: string): string {
  const match = /(?:^|\s)-Command\s+(?:\/[a-z]\s+)?([\s\S]+)$/i.exec(command);
  const body = match?.[1]?.trim() ?? command.replace(/\s+/g, ' ').trim();
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) return body.slice(1, -1);
  return body;
}

function mutateKey(entry: TimelineEntry): string {
  return (entry.detail ?? '').split(/\s+/)[0] ?? entry.title;
}

function mergeDetail(previous: TimelineEntry, next: TimelineEntry, count: number): string {
  if (previous.kind === 'compact' || next.kind === 'compact') return `×${count}`;
  const names = uniqueNames([...(previous.detail ?? '').split(/[·×]/), ...(next.detail ?? '').split(/[·×]/)]);
  const shown = names.slice(0, 3).join(' · ');
  return `${shown}  ×${count}`;
}

function uniqueNames(parts: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of parts) {
    const name = part.replace(/^\s*×?\d+\s*$/, '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function joinOriginal(left: string | undefined, right: string | undefined): string {
  return [left, right].filter(Boolean).join('\n');
}

function verbFromTitle(title: string): string {
  const at = title.indexOf(' · ');
  return at >= 0 ? title.slice(at + 3) : title.replace(/^Decision:\s*/, '');
}

function isDecision(entry: TimelineEntry | undefined): boolean {
  return Boolean(entry?.title.startsWith('Decision:'));
}

function observationSource(entry: TimelineEntry): string | undefined {
  if (!entry.title.includes('read_observation')) return undefined;
  return entry.detail?.split(/\s+/)[0];
}
