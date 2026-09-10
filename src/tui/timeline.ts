import { record, text, type JsonRecord } from '../core/json.js';
import type { EventEnvelope } from '../core/schema.js';
import {
  collapseAgentRows,
  laneSource,
  projectAgentTool,
  projectContextCompacted,
  type AgentKind,
  type AgentLane,
} from './agent-activity.js';
import { projectAssistantVisible } from './fold-process.js';

/** Full event text kept for [o]; the visible pane only shows a short structured preview. */
const MAX_ORIGINAL_CHARS = 32_768;
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 1_200;

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
    if (collapsePresentedInput(timeline, entry)) continue;
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

function collapsePresentedInput(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  const key = presentedInputKey(entry);
  if (!key) return false;
  const index = timeline.findIndex((row) => presentedInputKey(row) === key);
  if (index < 0) return false;
  const existing = timeline[index];
  if (entry.title.startsWith('Input to Target') && existing?.title.startsWith('Prompt ·')) {
    timeline[index] = entry;
  }
  return true;
}

function presentedInputKey(entry: TimelineEntry): string | undefined {
  const raw = entry.title.startsWith('Input to Target')
    ? entry.detail
    : entry.title.startsWith('Prompt ·')
      ? (entry.detail ?? entry.title.slice('Prompt · '.length))
      : undefined;
  const key = raw?.replace(/\s+/g, ' ').trim();
  return key || undefined;
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

const SILENT_TIMELINE_TYPES = new Set([
  'agent.session_completed',
  'agent.session_failed',
  'agent.session_cancelled',
  'agent.invocation_started',
  'agent.invocation_completed',
  'agent.invocation_failed',
  'agent.invocation_cancelled',
  'agent.message_appended',
  'agent.session_started',
  'agent.model_output',
  'agent.model_request',
]);

export function projectPersistedTimeline(events: readonly EventEnvelope[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  for (const event of events) appendTimelineEntries(timeline, projectTimelineEvent(event));
  return timeline;
}

export function projectTimelineEvent(event: EventEnvelope): readonly TimelineEntry[] {
  if (SILENT_TIMELINE_TYPES.has(event.type)) return [];
  const payload = record(event.payload);
  const entry = timelineEntryFactory(event);

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
    case 'agent.assistant_visible': {
      const row = projectAssistantVisible(payload);
      return [entry(laneSource(row.extra.lane), row.title, row.detail, row.extra)];
    }
    case 'run.attempt_created':
      return [entry('HARNESS', 'Run created', requestedModel(payload), { hidden: true })];
    case 'run.state_changed':
      return [entry('HARNESS', `State: ${text(payload.from) ?? '?'} → ${text(payload.to) ?? '?'}`, undefined, { hidden: true })];
    case 'input.submitted': {
      const prompt = text(payload.text);
      return prompt ? emitPresented(entry, 'TARGET', promptTitle(prompt), prompt) : [];
    }
    case 'candidate.session_bound': return [entry('HARNESS', `Candidate session · ${text(payload.sessionId) ?? '?'}`, text(payload.productId), { hidden: true })];
    case 'candidate.user_view_persisted':
      return projectUserView(entry, payload);
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
      return [entry('HARNESS', 'Cleanup · workspace released', undefined)];
    case 'run.outcome_created':
      return projectOutcome(entry, payload);
    case 'run.finished':
      return [entry('HARNESS', 'Candidate run finished', undefined, { hidden: true })];
    case 'runtime.runtime_failed':
      return [entry('TARGET', 'Runtime failed', text(payload.message), { level: 'error' })];
    case 'runtime.session_failed':
      return [entry('TARGET', 'Session failed', text(payload.message), { level: 'error' })];
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
      return [];
  }
}

function timelineEntryFactory(event: EventEnvelope): MakeEntry {
  return (source, title, detail, extra) => ({
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
}

function projectUserView(entry: MakeEntry, payload: JsonRecord): readonly TimelineEntry[] {
  const status = text(payload.status) ?? 'unknown';
  const assistant = text(payload.assistantText);
  const prompt = text(payload.prompt);
  if (status === 'unavailable') {
    return [entry('TARGET', 'User view unavailable', undefined, { level: 'error' })];
  }
  const rows: TimelineEntry[] = [];
  if (prompt) rows.push(...emitPresented(entry, 'TARGET', promptTitle(prompt), prompt));
  if (assistant) rows.push(...emitPresented(entry, 'TARGET', 'Visible response', assistant));
  else if (status === 'empty') rows.push(entry('TARGET', 'User view empty'));
  else if (status === 'failed' || status === 'aborted') {
    rows.push(entry('TARGET', `User view · ${status}`, undefined, { level: 'error' }));
  } else if (!prompt) {
    rows.push(entry('TARGET', `User view · ${status}`));
  }
  return rows;
}

function projectOutcome(entry: MakeEntry, payload: JsonRecord): readonly TimelineEntry[] {
  const task = text(record(payload.task).status) ?? 'unknown';
  const termination = record(payload.termination);
  const cleanup = text(record(payload.cleanup).status) ?? 'unknown';
  const kind = text(termination.kind) ?? 'unknown';
  const code = text(termination.code);
  return [
    entry('HARNESS', `Task · ${task}`),
    entry('HARNESS', `Termination · ${kind}`, code),
    entry('HARNESS', `Cleanup · ${cleanup}`, undefined, cleanup === 'failed' ? { level: 'error' } : undefined),
  ];
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

function requestedModel(payload: JsonRecord): string | undefined {
  return text(record(payload.candidate).requestedModel);
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

export function eventOriginalText(entry: TimelineEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.original ?? entry.detail;
}


