import { peelStructuredEnvelope } from '../infrastructure/agent/assistant-visible.js';
import { record, text, type JsonRecord } from '../core/json.js';
import { mergeEventRefs, type ActivityRole, type ActivityStatus, type ActivityVerb } from './activity-index.js';
import type { Locale } from './i18n.js';
import { t } from './i18n.js';
import type { TimelineEntry, TimelineSource } from './timeline.js';

export type AgentLane = 'recovery' | 'controller' | 'comparison';
export type AgentKind = 'investigate' | 'mutate' | 'deliver' | 'compact' | 'live' | 'narrate' | 'fold' | 'thinking';
export type TimelineVoice = AgentLane | 'candidate';

/** Operator-facing role label; color/gutter stay secondary. */
export function activityRoleLabel(role: ActivityRole | undefined, product: string, locale: Locale = 'zh'): string {
  if (role === 'recovery') return t(locale, 'recoveryAgent');
  if (role === 'controller') return t(locale, 'controllerLegend');
  if (role === 'comparison') return t(locale, 'comparisonLegend');
  if (role === 'candidate') return product.trim() || t(locale, 'candidateRole');
  if (role === 'system') return t(locale, 'systemRole');
  return product.trim() || t(locale, 'candidateRole');
}

export function entryRole(entry: TimelineEntry): ActivityRole | undefined {
  if (entry.role) return entry.role;
  if (entry.voice === 'candidate' || (entry.source === 'TARGET' && !entry.lane)) return 'candidate';
  if (entry.lane === 'recovery' || entry.lane === 'controller' || entry.lane === 'comparison') return entry.lane;
  if (entry.source === 'CONTROLLER') return 'controller';
  if (entry.source === 'HARNESS') return 'system';
  return undefined;
}

export function isPresentedInput(entry: TimelineEntry): boolean {
  if (entry.verb === 'send' || entry.deliveryId) {
    return entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·') || entry.verb === 'send';
  }
  return entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·');
}

export function isTurnBoundary(entry: TimelineEntry): boolean {
  if (isPresentedInput(entry) && (entry.verb === 'send' || entry.title.startsWith('Input to Target'))) return true;
  if (entry.verb === 'decide' || entry.kind === 'deliver' && entry.title.startsWith('DONE ·')) return true;
  if (entry.title.startsWith('DONE ·')) return true;
  return false;
}

/** Stable fingerprint for error grouping: prefer structured code, keep path/digits. */
export function errorFingerprint(entry: TimelineEntry): string {
  const role = entryRole(entry) ?? 'system';
  const attempt = entry.sessionId ?? entry.turnId ?? '-';
  const tool = entry.correlationId ?? entry.verb ?? entry.title;
  const object = entry.object ?? '';
  const code = entry.eventType ?? '';
  const textKey = (entry.detail ?? entry.title).replace(/ ×\d+$/, '').trim();
  return [role, attempt, tool, object, code, textKey].join('\0');
}

export function activityStatusLabel(status: ActivityStatus | undefined, locale: Locale = 'zh'): string {
  if (status === 'started') return t(locale, 'activityStatusStarted');
  if (status === 'updated') return t(locale, 'activityStatusUpdated');
  if (status === 'completed') return t(locale, 'activityStatusCompleted');
  if (status === 'failed') return t(locale, 'activityStatusFailed');
  if (status === 'cancelled') return t(locale, 'activityStatusCancelled');
  return '';
}

export function toolCaption(entry: TimelineEntry, locale: Locale = 'zh'): string {
  const verb = entry.verb;
  if (verb === 'working' || entry.title === 'working') return t(locale, 'waitingVisibleActivity');
  const action = verbLabel(verb, entry.title);
  const object = entry.object ?? entry.detail ?? '';
  const status = activityStatusLabel(entry.activityStatus, locale);
  const parts = [action, object, status].filter(Boolean);
  return parts.join(' · ') || entry.title;
}

function verbLabel(verb: ActivityVerb | undefined, fallback: string): string {
  if (verb === 'read') return '阅读';
  if (verb === 'inspect') return '检查';
  if (verb === 'write' || verb === 'edit') return '写入';
  if (verb === 'run') return '运行';
  if (verb === 'send') return '投递';
  if (verb === 'wait') return '等待';
  if (verb === 'decide') return '判断';
  if (verb === 'publish') return '发布';
  if (verb === 'error') return '失败';
  if (verb === 'working') return '等待';
  return fallback.replace(/^Candidate · /, '');
}

export function excerptId(entry: TimelineEntry): string {
  const ref = entry.eventRefs?.[0];
  if (ref) return `excerpt:ev:${ref.eventId}`;
  if (entry.itemId) return `excerpt:id:${entry.itemId}`;
  if (entry.correlationId) return `excerpt:corr:${entry.correlationId}`;
  return `excerpt:seq:${entry.sequence}`;
}

const INVESTIGATE = new Set(['ls', 'read', 'grep', 'find']);
const MUTATE = new Set(['shell_exec', 'edit']);
const READ_PS = /^(Get-ChildItem|Get-Content|Get-[A-Za-z]+)\b/;
const WRITE_PS = /\b(Remove-Item|Set-Content|Copy-Item|New-Item|Move-Item|Out-File)\b/i;

function agentLane(payload: JsonRecord): AgentLane {
  const role = text(payload.role);
  if (role === 'controller' || role === 'comparison') return role;
  return 'recovery';
}

export function projectAssistantVisible(payload: JsonRecord): {
  title: string;
  detail: string;
  extra: { lane: AgentLane; kind: 'narrate'; count: number; role: ActivityRole };
} {
  const textBody = peelStructuredEnvelope(text(payload.text) ?? '');
  const role = payload.role === 'controller' || payload.role === 'comparison' ? payload.role : 'recovery';
  const first = textBody.split(/\n/)[0]?.trim() ?? '';
  return {
    title: first || '…',
    detail: textBody,
    extra: { lane: role, kind: 'narrate', count: 1, role },
  };
}

export function laneSource(lane: AgentLane): TimelineSource {
  return lane === 'controller' ? 'CONTROLLER' : 'HARNESS';
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
  correlationId?: string;
  linkUnknown?: boolean;
  role?: AgentLane;
  verb?: 'read' | 'inspect' | 'write' | 'edit' | 'error';
  object?: string;
  activityStatus?: 'started' | 'completed' | 'failed';
} } {
  const lane = agentLane(payload);
  const tool = text(payload.tool) ?? 'unknown';
  const failed = type === 'agent.tool_failed';
  const completed = type === 'agent.tool_completed';
  const message = text(payload.message) ?? text(payload.error) ?? '';
  const object = toolObject(payload, tool);
  const kind = toolKind(lane, tool, object.command);
  const gitMissing = isGitMissing(tool, completed, payload);
  const toolCallId = text(payload.toolCallId);
  if (failed) {
    const failure = humanToolFailure(message);
    return {
      title: failure.title,
      ...(failure.detail ? { detail: failure.detail } : {}),
      extra: {
        level: 'error',
        lane,
        kind,
        // Index owns composite correlationId; only mark unlinked failures here.
        ...(toolCallId ? {} : { linkUnknown: true }),
        role: lane,
        verb: 'error' as const,
        activityStatus: 'failed' as const,
        ...(object.short ? { object: object.short } : {}),
      },
    };
  }
  const verb = toolVerb(tool, object);
  const title = liveTitle(verb);
  const live = !completed;
  const warnWrite = lane === 'comparison' && kind === 'mutate' && /[\\/]candidate[\\/]/i.test(object.command ?? object.short);
  const keepNow = live || (completed && !gitMissing);
  const detail = gitMissing
    ? '不是 Git 仓库'
    : object.short;
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(object.original && object.original !== detail ? { original: object.original } : {}),
    extra: {
      lane,
      kind: keepNow ? 'live' : kind,
      count: 1,
      role: lane,
      activityStatus: completed ? 'completed' : 'started',
      ...(object.short ? { object: object.short } : {}),
      ...(keepNow ? { itemId: `now:${lane}`, patch: 'replace' as const, placeholder: true as const } : {}),
      ...(warnWrite ? { level: 'warning' as const } : {}),
    },
  };
}

export function collapseAgentRows(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  if (entry.hidden || entry.placeholder || entry.kind === 'live' || entry.kind === 'deliver') return false;
  if (entry.level === 'error') return false;
  if (entry.kind !== 'investigate' && entry.kind !== 'mutate' && entry.kind !== 'compact') return false;
  const role = entryRole(entry);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const previous = timeline[index];
    if (!previous || previous.hidden || previous.placeholder || previous.kind === 'live') continue;
    if (previous.level === 'error') return false;
    if (entryRole(previous) !== role || previous.kind !== entry.kind) return false;
    if (entry.kind === 'mutate' && mutateKey(previous) !== mutateKey(entry)) return false;
    // Only aggregate consecutive completed reads within the same role/phase; never swallow failures.
    if (entry.activityStatus && entry.activityStatus !== 'completed') return false;
    if (previous.activityStatus && previous.activityStatus !== 'completed') return false;
    const count = (previous.count ?? 1) + (entry.count ?? 1);
    const objects = uniqueLeafNames([
      ...(previous.object ? [previous.object] : []),
      ...(entry.object ? [entry.object] : []),
      ...(previous.detail ?? '').split(/[·×,]/),
      ...(entry.detail ?? '').split(/[·×,]/),
    ]);
    const mergedDetail = mergeDetail(previous, entry, count, objects);
    timeline[index] = {
      ...previous,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      detail: mergedDetail,
      count,
      eventRefs: mergeEventRefs(previous.eventRefs, entry.eventRefs),
      ...(entry.correlationId ? { correlationId: entry.correlationId } : previous.correlationId
        ? { correlationId: previous.correlationId }
        : {}),
      ...(entry.linkUnknown || previous.linkUnknown ? { linkUnknown: true } : {}),
      ...(objects.length ? { object: objects.join(' · ') } : {}),
      ...(entry.original || previous.original
        ? { original: joinOriginal(previous.original ?? previous.detail, entry.original ?? entry.detail) }
        : {}),
    };
    return true;
  }
  return false;
}

export function projectWorkingNow(lane: AgentLane): {
  title: string;
  extra: {
    lane: AgentLane;
    kind: 'live';
    placeholder: true;
    itemId: string;
    patch: 'replace';
    role: ActivityRole;
    verb: 'working';
    activityStatus: 'started';
  };
} {
  return {
    title: 'working',
    extra: {
      lane,
      kind: 'live',
      placeholder: true,
      itemId: `now:${lane}`,
      patch: 'replace',
      role: lane,
      verb: 'working',
      activityStatus: 'started',
    },
  };
}

export function captionPublicLive(verb: string, leaf?: string): { title: string; detail?: string } {
  if (verb === 'working') return { title: 'working' };
  const title = verb === 'read' || verb === 'inspect'
    ? '阅读'
    : verb === 'run'
      ? '运行'
      : verb === 'write' || verb === 'edit'
        ? '写入'
        : verb;
  if (!leaf) return { title };
  return { title, detail: leaf };
}

export function lastLiveVerb(entries: readonly TimelineEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.hidden) continue;
    if (entry.kind === 'narrate') continue;
    if (entry.placeholder || entry.kind === 'live') return verbFromTitle(entry.title);
    if (entry.lane) return verbFromTitle(entry.title);
    return undefined;
  }
  return undefined;
}

function liveTitle(verb: string): string {
  return verb === 'shell_exec' ? '检查' : verb;
}

function humanToolFailure(message: string): { title: string; detail?: string } {
  if (/write_denied|outside the Host write policy/i.test(message)) {
    return { title: '写入失败', detail: '路径不在可写范围' };
  }
  if (/destructive change budget of 16|delete_file budget of 16/.test(message)) {
    return { title: '工具失败', detail: 'destructive change budget exhausted' };
  }
  if (/tool-call budget of /.test(message)) {
    return { title: '工具失败', detail: 'investigation budget exhausted' };
  }
  if (/not a git repository/i.test(message)) {
    return { title: '工具失败', detail: '不是 Git 仓库' };
  }
  const trimmed = message.replace(/^[a-z0-9_]+:\s*/i, '').trim();
  return { title: '工具失败', ...(trimmed ? { detail: trimmed } : {}) };
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
  if (tool === 'write' || tool === 'edit') return '写入';
  if (INVESTIGATE.has(tool)) return '阅读';
  if (tool === 'shell_exec') return object.verb === 'shell_exec' || !object.verb ? '检查' : object.verb;
  return object.verb ?? tool;
}

function toolObject(payload: JsonRecord, tool: string): { short: string; original?: string; command?: string; verb?: string } {
  const params = record(payload.params);
  const details = record(payload.details);
  const path = text(params.path) ?? text(details.path);
  if (path) return { short: leaf(path), original: path, verb: tool === 'write' || tool === 'edit' ? '写入' : '阅读' };
  const command = text(params.command);
  if (command) {
    const verb = powershellVerb(command);
    const quoted = command.match(/['"]([^'"]+)['"]/)?.[1];
    const short = [verb, quoted ? leaf(quoted) : undefined].filter(Boolean).join('  ');
    return { short: short || verb || 'shell_exec', original: command, command, verb: verb ?? 'shell_exec' };
  }
  return { short: tool, verb: tool };
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

function mergeDetail(
  previous: TimelineEntry,
  next: TimelineEntry,
  count: number,
  objects: readonly string[] = [],
): string {
  if (previous.kind === 'compact' || next.kind === 'compact') return `tail ×${count}`;
  const names = objects.length
    ? objects
    : uniqueLeafNames([...(previous.detail ?? '').split(/[·×]/), ...(next.detail ?? '').split(/[·×]/)]);
  const shown = names.slice(0, 3).join(' · ');
  // Call count and unique object count stay distinct in the title when both are known.
  if (names.length > 0 && names.length !== count) {
    return `${shown} · ${count}次 · ${names.length}项`;
  }
  return `${shown}  ×${count}`;
}

export function uniqueLeafNames(parts: readonly string[]): string[] {
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
  return at >= 0 ? title.slice(at + 3) : title.replace(/^Decision:\s*/, '').replace(/^DONE · /, '');
}



