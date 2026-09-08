import { record, text, type JsonRecord } from '../core/json.js';
import type { TimelineEntry, TimelineSource } from './timeline.js';

export type AgentLane = 'recovery' | 'controller' | 'comparison';
export type AgentKind = 'investigate' | 'mutate' | 'deliver' | 'compact' | 'live' | 'narrate' | 'fold';

const INVESTIGATE = new Set(['ls', 'read', 'grep', 'find']);
const MUTATE = new Set(['shell_exec', 'edit']);
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
  const object = toolObject(payload, tool);
  const kind = toolKind(lane, tool, object.command);
  const gitMissing = isGitMissing(tool, completed, payload);
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
  const retained = typeof payload.retainedCount === 'number' ? payload.retainedCount : 1;
  return {
    title: laneTitle(lane, 'compact'),
    detail: `tail ${retained}`,
    extra: { lane, kind: 'compact', count: 1, itemId: `compact:${lane}`, patch: 'replace' },
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
    if (entry.kind === 'narrate') return (entry.detail ?? entry.title).split(/\n/)[0]?.slice(0, 24);
    if (entry.placeholder || entry.kind === 'live') return verbFromTitle(entry.title);
    if (entry.lane) return verbFromTitle(entry.title);
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
  if (tool === 'shell_exec' && lane === 'comparison' && command && READ_PS.test(command.trim()) && !WRITE_PS.test(command)) {
    return 'investigate';
  }
  if (MUTATE.has(tool)) return 'mutate';
  return 'investigate';
}

function toolVerb(tool: string, object: { verb?: string }): string {
  if (tool === 'write' || tool === 'edit' || tool === 'shell_exec' || tool === 'read_observation') return object.verb ?? tool;
  if (INVESTIGATE.has(tool)) return 'inspect';
  return tool;
}

function toolObject(payload: JsonRecord, tool: string): { short: string; original?: string; command?: string; verb?: string } {
  const params = record(payload.params);
  const details = record(payload.details);
  const source = text(params.source) ?? text(details.source);
  if (tool === 'read_observation') {
    return { short: source ?? 'observation', verb: 'inspect', ...(source ? { original: source } : {}) };
  }
  const path = text(params.path) ?? text(details.path);
  if (path) return { short: leaf(path), original: path, verb: tool === 'write' || tool === 'edit' ? tool : 'inspect' };
  const command = text(params.command);
  if (command) {
    const verb = powershellVerb(command);
    const quoted = command.match(/['"]([^'"]+)['"]/)?.[1];
    const short = [verb, quoted ? leaf(quoted) : undefined].filter(Boolean).join('  ');
    return { short: short || verb || 'shell_exec', original: command, command, verb: verb ?? 'shell_exec' };
  }
  return { short: tool, verb: tool };
}

function completedDetail(kind: AgentKind, object: { short: string }, tool: string): string {
  if (kind === 'deliver') return object.short || (tool === 'write' ? 'report' : object.short);
  return object.short;
}

function isGitMissing(tool: string, completed: boolean, payload: JsonRecord): boolean {
  const details = record(payload.details);
  return (tool === 'shell_exec' && completed && /not a git repository/i.test(text(payload.content) ?? ''))
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
  if (previous.kind === 'compact' || next.kind === 'compact') return `tail ×${count}`;
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



