import { record, text, type JsonRecord } from '../core/json.js';
import type { EventEnvelope } from '../core/schema.js';
import type { FileChange, TargetActivity, TargetActivityEntry } from '../products/contract.js';
import { productPacks } from '../products/index.js';
import {
  collapseAgentRows,
  laneSource,
  projectAgentTool,
  projectContextCompacted,
  type AgentKind,
  type AgentLane,
} from './agent-activity.js';

/** Full event text kept for [o]; the visible pane only shows a short structured preview. */
const MAX_ORIGINAL_CHARS = 32_768;
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 1_200;
const OUTPUT_LINE_CHARS = 160;

export type TimelineSource = 'HARNESS' | 'CONTROLLER' | 'TARGET';

export interface TimelineEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly source: TimelineSource;
  readonly title: string;
  readonly detail?: string;
  /** Full event text for [o] Open full output; omitted when it matches detail. */
  readonly original?: string;
  readonly level?: 'warning' | 'error';
  /** Internal facts kept for counters and phase, omitted from the default operator list. */
  readonly hidden?: boolean;
  /** Stable item id used to merge streamed deltas into one operator row. */
  readonly itemId?: string;
  /** How a later event with the same itemId should combine with the existing row. */
  readonly patch?: 'replace' | 'append';
  /** Streaming placeholder; later real text replaces this row instead of appending. */
  readonly placeholder?: boolean;
  readonly lane?: AgentLane;
  readonly kind?: AgentKind;
  readonly count?: number;
}

type EntryExtra = {
  level?: TimelineEntry['level'];
  hidden?: boolean;
  itemId?: string;
  patch?: TimelineEntry['patch'];
  original?: string;
  placeholder?: boolean;
  lane?: AgentLane;
  kind?: AgentKind;
  count?: number;
};

type MakeEntry = (source: TimelineSource, title: string, detail?: string, extra?: EntryExtra) => TimelineEntry;

/** Projects persisted public facts into an operator timeline; unknown and noisy delta events stay in trace only. */
export function appendTimelineEntries(timeline: TimelineEntry[], incoming: readonly TimelineEntry[]): void {
  const seen = new Set(timeline.filter((entry) => entry.title.startsWith('Prompt ·')).map((entry) => entry.title));
  for (const entry of incoming) {
    if (entry.title.startsWith('Prompt ·')) {
      if (seen.has(entry.title)) continue;
      seen.add(entry.title);
    }
    const index = entry.itemId ? lastIndexByItemId(timeline, entry.itemId) : -1;
    if (index >= 0) {
      const merged = settleLiveId(mergeEntry(timeline[index] ?? entry, entry));
      timeline.splice(index, 1);
      if (!collapseRepeatedRecoveryFailure(timeline, merged) && !collapseAgentRows(timeline, merged)) {
        timeline.splice(Math.min(index, timeline.length), 0, merged);
      }
      continue;
    }
    const settled = settleLiveId(entry);
    const collapsed = collapseRepeatedRecoveryFailure(timeline, settled) || collapseAgentRows(timeline, settled);
    if (!collapsed) timeline.push(settled);
  }
}

function collapseRepeatedRecoveryFailure(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  if (entry.hidden || entry.level !== 'error' || !entry.title.includes('tool failed')) return false;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const previous = timeline[index];
    if (!previous || previous.hidden) continue;
    if (previous.title !== entry.title || previous.level !== 'error') return false;
    const previousKey = recoveryFailureText(previous.detail);
    const nextKey = recoveryFailureText(entry.detail);
    if (previousKey !== nextKey) return false;
    const count = recoveryFailureCount(previous.detail) + 1;
    timeline[index] = {
      ...previous,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      detail: `${previousKey} ×${count}`,
      ...(entry.original || previous.original
        ? { original: clampOriginal(`${previous.original ?? previous.detail ?? ''}\n${entry.original ?? entry.detail ?? ''}`) }
        : {}),
    };
    return true;
  }
  return false;
}

function recoveryFailureText(detail: string | undefined): string {
  const raw = (detail ?? '').replace(/ ×\d+$/, '');
  if (/destructive change budget of 16|delete_file budget of 16/.test(raw)) return 'destructive change budget exhausted';
  if (/tool-call budget of /.test(raw)) return 'investigation budget exhausted';
  return raw;
}

function recoveryFailureCount(detail: string | undefined): number {
  const match = / ×(\d+)$/.exec(detail ?? '');
  return match ? Number(match[1]) : 1;
}

export function projectTimelineEvent(event: EventEnvelope): readonly TimelineEntry[] {
  const payload = record(event.payload);
  const entry = (
    source: TimelineSource,
    title: string,
    detail?: string,
    extra?: EntryExtra,
  ): TimelineEntry => ({
    sequence: event.sequence, occurredAt: event.occurredAt, source, title,
    ...(detail ? { detail } : {}),
    ...(extra?.original ? { original: extra.original } : {}),
    ...(extra?.level ? { level: extra.level } : {}),
    ...(extra?.hidden ? { hidden: true } : {}),
    ...(extra?.itemId ? { itemId: extra.itemId } : {}),
    ...(extra?.patch ? { patch: extra.patch } : {}),
    ...(extra?.placeholder ? { placeholder: true } : {}),
    ...(extra?.lane ? { lane: extra.lane } : {}),
    ...(extra?.kind ? { kind: extra.kind } : {}),
    ...(extra?.count !== undefined ? { count: extra.count } : {}),
  });

  switch (event.type) {
    case 'recovery.started':
      return [entry('HARNESS', 'Recovery started', undefined, { hidden: true })];
    case 'recovery.completed': {
      const status = text(payload.status) ?? text(record(payload.value).status) ?? 'unknown';
      const failed = status === 'failed';
      return [entry('HARNESS', `Recovery ${status}`, text(payload.message) ?? text(record(payload.failure).message), failed ? { level: 'error' } : undefined)];
    }
    case 'agent.tool_called':
    case 'agent.tool_completed':
    case 'agent.tool_failed': {
      const row = projectAgentTool(payload, event.type);
      return [entry(laneSource(row.extra.lane), row.title, row.detail, {
        ...row.extra,
        ...(row.original ? { original: row.original } : {}),
      })];
    }
    case 'agent.context_compacted': {
      const row = projectContextCompacted(payload);
      return [entry(laneSource(row.extra.lane), row.title, row.detail, row.extra)];
    }
    case 'agent.session_completed':
    case 'agent.message_appended':
    case 'agent.session_started':
      return [];
    case 'run.attempt_created':
      return [entry('HARNESS', 'Run created', requestedModel(payload), { hidden: true })];
    case 'run.state_changed':
      return [entry('HARNESS', `State: ${text(payload.from) ?? '?'} → ${text(payload.to) ?? '?'}`, undefined, { hidden: true })];
    case 'input.submitted': {
      const prompt = text(payload.text);
      return prompt ? emitPresented(entry, 'TARGET', promptTitle(prompt), prompt) : [];
    }
    case 'runtime.delivery_observed': {
      const delivery = text(record(payload.receipt).delivery) ?? 'unknown';
      if (delivery === 'accepted') return [entry('HARNESS', `Delivery: ${delivery}`, undefined, { hidden: true })];
      return [entry('HARNESS', `Delivery: ${delivery}`, undefined, { level: 'error' })];
    }
    case 'runtime.turn_settled':
      return [entry('HARNESS', `Turn settled: ${text(payload.status) ?? 'unknown'}`, undefined, { hidden: true })];
    case 'artifact.created':
      return [entry('HARNESS', `Artifact: ${text(payload.artifactId) ?? 'created'}`, undefined, { hidden: true })];
    case 'run.stop_requested': {
      const code = text(payload.code) ?? '';
      const reason = text(payload.reason) ?? 'unknown';
      if (code.startsWith('blocked.')) return [entry('HARNESS', 'Candidate stopped · blocked', code)];
      if (code.startsWith('completed.')) return [entry('HARNESS', 'Candidate completed', code, { hidden: true })];
      if (code.startsWith('stalled.')) return [entry('HARNESS', 'Candidate stalled', code)];
      return [entry('HARNESS', `Stop requested: ${reason}`, code, reason === 'failed' ? { level: 'error' } : undefined)];
    }
    case 'environment.release_completed':
      return [entry('HARNESS', 'Isolated workspace released', undefined, { hidden: true })];
    case 'run.outcome_created':
      return [entry('HARNESS', 'Outcome recorded', outcome(payload), { hidden: true })];
    case 'run.finished':
      return [entry('HARNESS', 'Candidate run finished', undefined, { hidden: true })];
    case 'report.created':
      return [entry('HARNESS', 'Report created', text(payload.path))];
    case 'controller.started':
      return [entry('CONTROLLER', 'Evaluation started', text(payload.model), { hidden: true })];
    case 'controller.decision':
      return controllerEntries(event, payload);
    case 'controller.done':
      return [entry('CONTROLLER', `Done: ${text(payload.reason) ?? 'unknown'}`, undefined, { hidden: true })];
    case 'controller.failed':
      return [entry('CONTROLLER', 'Controller failed', text(payload.message), { level: 'error' })];
    case 'comparison.started':
      return [entry('CONTROLLER', 'Comparison started', text(payload.model), { hidden: true, lane: 'comparison' })];
    case 'comparison.completed':
      return projectComparisonCompleted(entry, payload);
    default:
      return projectPackActivities(event, entry);
  }
}

function projectComparisonCompleted(entry: MakeEntry, payload: JsonRecord): readonly TimelineEntry[] {
  const status = text(payload.status) ?? 'unknown';
  const failure = record(payload.failure);
  const value = record(payload.value);
  const codes = Array.isArray(value.limitationCodes) ? value.limitationCodes.filter((item): item is string => typeof item === 'string') : [];
  const detail = status === 'failed'
    ? text(failure.message)
    : ['report.html', ...codes].filter(Boolean).join(' · ');
  return [entry('CONTROLLER', status === 'completed' ? 'Comparison completed' : `Comparison ${status}`, detail, {
    lane: 'comparison',
    kind: 'deliver',
    ...(status === 'failed' ? { level: 'error' as const } : {}),
  })];
}

function projectPackActivities(event: EventEnvelope, entry: MakeEntry): readonly TimelineEntry[] {
  const pack = productPacks.find((item) => event.type.startsWith(`${item.manifest.productId}.`));
  if (!pack) return [];
  return pack.activity.translate(event).flatMap((item) => renderActivity(item, entry));
}

function renderActivity(item: TargetActivityEntry, entry: MakeEntry): readonly TimelineEntry[] {
  const extra: EntryExtra = {
    ...(item.correlationId ? { itemId: item.correlationId } : {}),
    ...(item.merge ? { patch: item.merge } : {}),
  };
  if (item.merge === 'append') {
    const detail = appendedDetail(item.activity);
    return detail ? [entry('TARGET', 'Streaming', detail, extra)] : [];
  }
  return renderTargetActivity(item.activity, entry, extra);
}

function appendedDetail(activity: TargetActivity): string | undefined {
  if (activity.kind === 'message') return activity.text;
  if (activity.kind === 'thinking') return activity.text;
  if (activity.kind === 'command') return activity.output;
  return undefined;
}

function renderTargetActivity(activity: TargetActivity, entry: MakeEntry, extra: EntryExtra): readonly TimelineEntry[] {
  switch (activity.kind) {
    case 'prompt':
      return emitPresented(entry, 'TARGET', promptTitle(activity.text), activity.text, extra);
    case 'thinking': {
      if (activity.streaming && !activity.text) {
        return [entry('TARGET', 'Thinking', 'The target is reasoning.', { ...extra, placeholder: true })];
      }
      if (activity.streaming) return [entry('TARGET', 'Thinking', activity.text, extra)];
      if (!activity.text) return [entry('TARGET', 'Thinking', undefined, { ...extra, hidden: true })];
      return emitPresented(entry, 'TARGET', 'Thought', activity.text, extra);
    }
    case 'message': {
      if (activity.streaming && !activity.text) {
        return [entry('TARGET', extra.itemId ? 'Writing' : 'Working', extra.itemId ? 'The target is writing a reply.' : 'The target is running this turn.', { ...extra, placeholder: true })];
      }
      if (activity.streaming) return emitPresented(entry, 'TARGET', extra.itemId ? 'Writing' : 'Working', activity.text ?? '', extra);
      return activity.text ? emitPresented(entry, 'TARGET', 'Visible response', activity.text, extra) : [];
    }
    case 'command':
      return renderCommand(activity, entry, extra);
    case 'file_change': {
      const body = fileChangeBody(activity.changes);
      return [entry('TARGET', activity.completed === false ? 'Changing files' : 'File change', body.detail, { ...extra, ...(body.original ? { original: body.original } : {}) })];
    }
    case 'web_search':
      return activity.query
        ? emitPresented(entry, 'TARGET', activity.completed ? 'Web search' : 'Searching', activity.query, extra)
        : [entry('TARGET', activity.completed ? 'Web search' : 'Searching', undefined, extra)];
    case 'tool_call': {
      const failed = activity.status === 'failed';
      return activity.body
        ? emitPresented(entry, 'TARGET', activity.name, activity.body, { ...extra, ...(failed ? { level: 'warning' as const } : {}) })
        : [entry('TARGET', activity.name, undefined, { ...extra, ...(failed ? { level: 'warning' as const } : {}) })];
    }
    case 'subtask':
      return [entry('TARGET', `Subtask · ${activity.name}`, activity.body, extra)];
    case 'schedule':
      return [entry('TARGET', `Schedule · ${activity.name}`, activity.body, extra)];
    case 'plan':
      return [entry('TARGET', 'Plan updated', activity.steps.map((step) => `${step.status} · ${step.step}`).join('\n'), extra)];
    case 'token_usage': {
      const lines = [
        `total ${formatCount(activity.total)}`,
        `input ${formatCount(activity.input ?? 0)}${activity.cached ? ` · cached ${formatCount(activity.cached)}` : ''}`,
        `output ${formatCount(activity.output ?? 0)}${activity.reasoning ? ` · reasoning ${formatCount(activity.reasoning)}` : ''}`,
      ];
      return [entry('TARGET', `Tokens · ${formatCount(activity.total)}`, lines.join('\n'), extra)];
    }
    case 'sandbox_notice':
      return renderSandbox(activity, entry, extra);
    case 'runtime_error':
      return [entry('TARGET', 'Protocol error', activity.message, { ...extra, level: 'error' })];
    case 'other':
      return activity.body
        ? emitPresented(entry, 'TARGET', activity.label, activity.body, extra)
        : [entry('TARGET', activity.label, undefined, extra)];
  }
}

function renderCommand(
  activity: Extract<TargetActivity, { kind: 'command' }>,
  entry: MakeEntry,
  extra: EntryExtra,
): readonly TimelineEntry[] {
  const completed = activity.status !== 'started';
  const title = completed ? commandIdentity(activity.command) : commandTitle(activity.command);
  const level = activity.status === 'failed' && activity.blockedBySandbox
    ? 'warning' as const
    : activity.status === 'failed'
      ? 'error' as const
      : undefined;
  const body = completed
    ? commandDetail(activity)
    : presentCommand(activity.command);
  return [entry('TARGET', title, body.detail, { ...extra, ...(body.original ? { original: body.original } : {}), ...(level ? { level } : {}) })];
}

function renderSandbox(
  activity: Extract<TargetActivity, { kind: 'sandbox_notice' }>,
  entry: MakeEntry,
  extra: EntryExtra,
): readonly TimelineEntry[] {
  const title = activity.label === 'danger-full-access'
    ? 'Sandbox · full access'
    : activity.label === 'workspace-write'
      ? 'Sandbox · workspace-write'
      : `Sandbox · ${activity.label}`;
  const detail = [activity.identity, activity.caveat].filter(Boolean).join('\n') || undefined;
  return [entry('HARNESS', title, detail, extra)];
}

function controllerEntries(event: EventEnvelope, payload: JsonRecord): readonly TimelineEntry[] {
  if (text(payload.status) === 'failed') return [];
  const decision = record(payload.value);
  const kind = text(decision.type);
  if (!kind) return [];
  const rationale = text(decision.rationale);
  const reason = text(decision.reason);
  const title = kind === 'done' && reason ? `Decision: DONE · ${reason}` : `Decision: ${kind.toUpperCase()}`;
  const base: TimelineEntry = {
    sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER',
    title,
    ...(rationale ? { detail: rationale } : {}),
  };
  if (kind !== 'send') return [base];
  const message = text(decision.message);
  return [base, {
    sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER', title: 'Input to Target',
    ...(message ? { detail: message } : {}),
  }];
}

function promptTitle(prompt: string): string {
  const first = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? prompt.trim();
  return first ? `Prompt · ${first}` : 'Prompt';
}

function commandIdentity(command: string): string {
  const exe = executableName(command);
  const verb = powershellVerb(command);
  const label = verb && /^pwsh$/i.test(exe) ? `${exe} · ${verb}` : exe;
  const short = label.length > 48 ? `${label.slice(0, 47)}...` : label;
  return short || 'command';
}

function commandTitle(command: string): string {
  return `Running · ${commandIdentity(command)}`;
}

function executableName(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (!/[\\/]/.test(compact) && compact.length <= 48) return compact;
  const quoted = compact.match(/^"([^"]+)"/)?.[1] ?? compact.match(/^'([^']+)'/)?.[1];
  const path = quoted ?? compact.split(' ')[0] ?? compact;
  const base = path.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return base || compact;
}

function powershellVerb(command: string): string | undefined {
  const body = unwrapCommand(command);
  return body.match(/\b(Get-ChildItem|Get-Content|Copy-Item|Remove-Item|Set-Content|Get-[A-Za-z]+)\b/)?.[1]
    ?? body.match(/\b([A-Z][A-Za-z]+-[A-Za-z]+)\b/)?.[1];
}

function oneLineCommand(command: string): string {
  return unwrapCommand(command).replace(/\s+/g, ' ').trim();
}

/** Operator line: the verb, not the quoting wrapper or pwsh.exe path. */
function displayCommand(command: string): string {
  const body = oneLineCommand(command);
  const verb = powershellVerb(command);
  if (verb && body.length > 72) {
    const at = body.indexOf(verb);
    if (at > 0) return body.slice(at);
  }
  return body;
}

function commandDetail(activity: Extract<TargetActivity, { kind: 'command' }>): { detail: string; original?: string } {
  const output = activity.output;
  const sandbox = activity.blockedBySandbox === true;
  const outputPreview = output && !sandbox ? previewLines(output, PREVIEW_LINES) : undefined;
  const status = [
    typeof activity.exitCode === 'number' ? `exit ${activity.exitCode}` : undefined,
    typeof activity.durationMs === 'number' ? `${activity.durationMs}ms` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' · ');
  const lines = [`$ ${displayCommand(activity.command)}`];
  if (sandbox) {
    lines.push('| Sandbox blocked a path outside the isolated workspace.');
    if (/apply deny-read ACLs/i.test(output ?? '')) lines.push('| Windows could not apply deny-read ACLs.');
  } else if (outputPreview) {
    for (const row of outputPreview.preview.split('\n')) {
      const clipped = row.length > OUTPUT_LINE_CHARS ? `${row.slice(0, OUTPUT_LINE_CHARS - 1)}...` : row;
      lines.push(`| ${clipped}`);
    }
    if (outputPreview.omitted > 0) lines.push(`... +${outputPreview.omitted} lines`);
  }
  if (status) lines.push(status);
  const original = [
    activity.command,
    activity.cwd ? `cwd  ${activity.cwd}` : undefined,
    typeof activity.exitCode === 'number' ? `exit ${activity.exitCode}` : undefined,
    typeof activity.durationMs === 'number' ? `time ${activity.durationMs}ms` : undefined,
    activity.actions?.join('\n'),
    output,
  ].filter((part): part is string => Boolean(part)).join('\n');
  const detail = lines.join('\n');
  return original && original !== detail ? { detail, original: clampOriginal(original) } : { detail };
}

function fileChangeBody(changes: readonly FileChange[]): { detail: string; original?: string } {
  const full = fileChangeDetail(changes);
  const headings = full.split(/\n\n/).map((block) => block.split(/\r?\n/).find((line) => line.trim()) ?? '').filter(Boolean);
  const preview = headings.slice(0, PREVIEW_LINES).join('\n');
  if (full.split(/\r?\n/).length <= PREVIEW_LINES && full.length <= PREVIEW_CHARS) return { detail: full };
  return { detail: withOpenHint(preview || previewLines(full, PREVIEW_LINES).preview, omittedLines(full, preview)), original: clampOriginal(full) };
}

function fileChangeDetail(changes: readonly FileChange[]): string {
  const lines = changes.map((change) => (
    change.diff ? `${change.kind ?? 'changed'}  ${change.path}\n${change.diff}` : `${change.kind ?? 'changed'}  ${change.path}`
  ));
  return lines.join('\n\n') || 'File change';
}

function clampOriginal(detail: string): string {
  if (detail.length <= MAX_ORIGINAL_CHARS) return detail;
  return `${detail.slice(0, MAX_ORIGINAL_CHARS)}\n... truncated ${detail.length - MAX_ORIGINAL_CHARS} characters; remainder is in the run trace.`;
}

function emitPresented(
  entry: MakeEntry,
  source: TimelineSource,
  title: string,
  body: string,
  extra?: EntryExtra,
): readonly TimelineEntry[] {
  const presented = presentText(body);
  return [entry(source, title, presented.detail, { ...extra, ...(presented.original ? { original: presented.original } : {}) })];
}

function presentText(body: string): { detail: string; original?: string } {
  const { preview, omitted } = previewLines(body, PREVIEW_LINES);
  if (omitted === 0 && body.length <= PREVIEW_CHARS) return { detail: body };
  return { detail: withOpenHint(preview, omitted), original: clampOriginal(body) };
}

function presentCommand(command: string): { detail: string; original?: string } {
  const detail = `$ ${displayCommand(command)}`;
  return command !== detail ? { detail, original: clampOriginal(command) } : { detail };
}

function previewLines(text: string, limit: number, maxChars = PREVIEW_CHARS): { preview: string; omitted: number } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= limit && text.length <= maxChars) return { preview: text, omitted: 0 };
  const head = [];
  let used = 0;
  for (const line of lines) {
    if (head.length >= limit || used + line.length > maxChars) break;
    head.push(line);
    used += line.length + 1;
  }
  const preview = head.join('\n') || text.slice(0, maxChars);
  if (preview === text) return { preview, omitted: 0 };
  const omitted = Math.max(1, lines.length - preview.split(/\r?\n/).length);
  return { preview, omitted };
}

function omittedLines(full: string, preview: string): number {
  return Math.max(0, full.split(/\r?\n/).length - preview.split(/\r?\n/).length);
}

function withOpenHint(preview: string, omitted: number): string {
  if (omitted <= 0) return preview;
  return `${preview}\n... +${omitted} lines`;
}

function livePreview(text: string): string {
  const lines = text.split(/\r?\n/);
  if (text.length <= PREVIEW_CHARS && lines.length <= PREVIEW_LINES) return text;
  const tail = lines.slice(-PREVIEW_LINES).join('\n');
  return `... live\n${tail}`;
}

function unwrapCommand(command: string): string {
  const match = /(?:^|\s)-Command\s+(?:\/[a-z]\s+)?([\s\S]+)$/i.exec(command);
  const body = match?.[1]?.trim() ?? command.replace(/\s+/g, ' ').trim();
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) return body.slice(1, -1);
  return body;
}

function requestedModel(payload: JsonRecord): string | undefined {
  return text(record(payload.candidate).requestedModel);
}

function outcome(payload: JsonRecord): string {
  const task = record(payload.task);
  const termination = record(payload.termination);
  const cleanup = record(payload.cleanup);
  return `task=${text(task.status) ?? 'unknown'} · termination=${text(termination.kind) ?? 'unknown'} · cleanup=${text(cleanup.status) ?? 'unknown'}`;
}

function settleLiveId(entry: TimelineEntry): TimelineEntry {
  if (entry.placeholder) return entry;
  const id = entry.itemId ?? '';
  if (!id.startsWith('live:') && !id.startsWith('compact:')) return entry;
  const { itemId: _itemId, patch: _patch, ...rest } = entry;
  return rest;
}

function lastIndexByItemId(timeline: readonly TimelineEntry[], itemId: string): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.itemId === itemId) return index;
  }
  return -1;
}

function mergeEntry(previous: TimelineEntry, next: TimelineEntry): TimelineEntry {
  if (next.patch === 'append') {
    const previousOriginal = previous.original ?? (previous.detail && !previous.placeholder ? previous.detail : '');
    const original = clampOriginal(`${previousOriginal}${next.detail ?? ''}`);
    const previousDetail = previous.detail;
    const keepCommandPreview = /^Running /.test(previous.title) && previousDetail !== undefined && !previousDetail.startsWith('... live');
    const detail = keepCommandPreview ? previousDetail : livePreview(original);
    return {
      sequence: next.sequence,
      occurredAt: next.occurredAt,
      source: previous.source,
      title: previous.title,
      detail,
      ...(original ? { original } : {}),
      ...(previous.itemId ? { itemId: previous.itemId } : {}),
      ...(next.hidden || previous.hidden ? { hidden: true } : {}),
      ...(next.level ? { level: next.level } : previous.level ? { level: previous.level } : {}),
    };
  }
  const keepStream = Boolean(next.placeholder && previous.detail && !previous.placeholder);
  const detail = keepStream ? previous.detail : (next.detail ?? previous.detail);
  const original = next.original ?? (keepStream ? previous.original : next.original) ?? previous.original;
  const { placeholder: _placeholder, ...rest } = { ...previous, ...next };
  return {
    ...rest,
    ...(detail ? { detail } : {}),
    ...(original ? { original } : {}),
    ...(next.hidden ? { hidden: true } : {}),
    ...(next.level ? { level: next.level } : previous.level ? { level: previous.level } : {}),
    ...(keepStream || next.placeholder ? { placeholder: true as const } : {}),
    ...(next.lane ? { lane: next.lane } : previous.lane ? { lane: previous.lane } : {}),
    ...(next.kind ? { kind: next.kind } : previous.kind ? { kind: previous.kind } : {}),
    ...(next.count !== undefined ? { count: next.count } : previous.count !== undefined ? { count: previous.count } : {}),
  };
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function eventOriginalText(entry: TimelineEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.original ?? entry.detail;
}
