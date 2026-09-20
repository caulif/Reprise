import { record, text, type JsonRecord } from '../core/json.js';
import { publicLiveOf } from '../core/public-live.js';
import type { EventEnvelope } from '../core/schema.js';
import {
  applyActivityNodeToEntries,
  createActivityIndex,
  deliveryIdentityFromPayload,
  ingestActivityEvent,
  mergeEventRefs,
  presentedTextKey,
  roleFromLane,
  semanticsFromEvent,
  type ActivityEventRef,
  type ActivityIndexState,
  type ActivityRole,
  type ActivityStatus,
  type ActivityVerb,
  type TimelineActivitySemantics,
} from './activity-index.js';
import {
  captionPublicLive,
  collapseAgentRows,
  laneSource,
  projectAgentTool,
  projectAssistantVisible,
  projectWorkingNow,
  uniqueLeafNames,
  type AgentKind,
  type AgentLane,
  type TimelineVoice,
} from './agent-activity.js';
import { bumpTimelineRevision, type TimelineRevisionState } from './timeline-revision.js';

/** Full event text kept off the default column; the visible pane only shows a short structured preview. */
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
  /** Full event text omitted from the default column when it matches detail. */
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
  readonly voice?: TimelineVoice;
  /** Structured display role; titles are render output, not identity. */
  readonly role?: ActivityRole;
  readonly verb?: ActivityVerb;
  readonly object?: string;
  readonly activityStatus?: ActivityStatus;
  readonly eventType?: string;
  readonly correlationId?: string;
  readonly deliveryId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly eventRefs?: readonly ActivityEventRef[];
  /** Failed/native row without a trusted call identity. */
  readonly linkUnknown?: boolean;
  /** Controller send ↔ input.submitted pair sealed so identical text cannot collapse across turns. */
  readonly deliveryPaired?: boolean;
  readonly truncated?: boolean;
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
  voice?: TimelineVoice;
} & TimelineActivitySemantics;

type MakeEntry = (source: TimelineSource, title: string, detail?: string, extra?: EntryExtra) => TimelineEntry;

/** Projects persisted public facts into an operator timeline; unknown and noisy delta events stay in trace only. */
export function appendTimelineEntries(
  timeline: TimelineEntry[],
  incoming: readonly TimelineEntry[],
  revision?: TimelineRevisionState,
): void {
  const seen = new Set(timeline.filter((entry) => entry.title.startsWith('Prompt ·')).map((entry) => entry.title));
  for (const entry of incoming) {
    if (shouldFlushBefore(entry) || (entry.hidden && entry.itemId?.startsWith('now:'))) {
      flushLane(timeline, entry.lane ?? laneFromEntry(entry));
    }
    if (collapsePresentedInput(timeline, entry)) continue;
    if (entry.title.startsWith('Prompt ·')) {
      if (seen.has(entry.title)) continue;
      seen.add(entry.title);
    }
    if (entry.itemId?.startsWith('flush:') || entry.itemId?.startsWith('flush-write:')) {
      bumpFlush(timeline, entry);
      continue;
    }
    if (isNowRow(entry)) {
      upsertNowRow(timeline, entry);
      continue;
    }
    const index = entry.itemId ? lastIndexByItemId(timeline, entry.itemId) : -1;
    if (index >= 0) {
      const merged = settleLiveId(mergeEntry(timeline[index] ?? entry, entry));
      timeline.splice(index, 1);
      if (!collapseRepeatedRecoveryFailure(timeline, merged) && !collapseAgentRows(timeline, merged)) {
        timeline.splice(Math.min(index, timeline.length), 0, merged);
      }
      pinNowRows(timeline);
      continue;
    }
    const settled = settleLiveId(entry);
    const collapsed = collapseRepeatedRecoveryFailure(timeline, settled) || collapseAgentRows(timeline, settled);
    if (!collapsed) timeline.push(settled);
    pinNowRows(timeline);
  }
  if (incoming.length > 0 && revision) bumpTimelineRevision(revision);
}

function collapsePresentedInput(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  const incoming = presentedInputMeta(entry);
  if (!incoming) return false;
  if (incoming.deliveryId) {
    const index = timeline.findIndex((row) => row.deliveryId === incoming.deliveryId && !row.hidden);
    if (index >= 0) {
      sealPresentedPair(timeline, index, entry);
      return true;
    }
  }
  // Same delivery often lacks a shared id: pair only an unpaired peer with the same text.
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const existing = timeline[index];
    if (!existing || existing.hidden || existing.deliveryPaired) continue;
    const prior = presentedInputMeta(existing);
    if (!prior || prior.textKey !== incoming.textKey) continue;
    if (prior.kind === incoming.kind) return false;
    sealPresentedPair(timeline, index, entry);
    return true;
  }
  return false;
}

function sealPresentedPair(timeline: TimelineEntry[], index: number, entry: TimelineEntry): void {
  const existing = timeline[index];
  if (!existing) return;
  const preferInput = entry.title.startsWith('Input to Target') && existing.title.startsWith('Prompt ·');
  const base = preferInput ? entry : existing;
  const other = preferInput ? existing : entry;
  const deliveryId = base.deliveryId ?? other.deliveryId ?? existing.deliveryId ?? entry.deliveryId;
  timeline[index] = {
    ...base,
    deliveryPaired: true,
    eventRefs: mergeEventRefs(existing.eventRefs, entry.eventRefs),
    ...(deliveryId ? { deliveryId } : {}),
    ...(other.detail && !base.detail ? { detail: other.detail } : {}),
    ...(other.original && !base.original ? { original: other.original } : {}),
  };
}

function presentedInputMeta(entry: TimelineEntry): { kind: 'input' | 'prompt'; textKey: string; deliveryId?: string } | undefined {
  const isInput = entry.title.startsWith('Input to Target');
  const isPrompt = entry.title.startsWith('Prompt ·');
  if (!isInput && !isPrompt) return undefined;
  const raw = isInput ? entry.detail : (entry.detail ?? entry.title.slice('Prompt · '.length));
  const textKey = presentedTextKey(raw);
  if (!textKey) return undefined;
  return {
    kind: isInput ? 'input' : 'prompt',
    textKey,
    ...(entry.deliveryId ? { deliveryId: entry.deliveryId } : {}),
  };
}

function collapseRepeatedRecoveryFailure(timeline: TimelineEntry[], entry: TimelineEntry): boolean {
  if (entry.hidden || entry.level !== 'error' || !/工具失败|写入失败|tool failed/.test(entry.title)) return false;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const previous = timeline[index];
    if (!previous || previous.hidden || previous.placeholder || previous.kind === 'live') continue;
    if (previous.title !== entry.title || previous.level !== 'error') return false;
    const previousKey = recoveryFailureText(previous.detail);
    const nextKey = recoveryFailureText(entry.detail);
    if (previousKey !== nextKey) return false;
    const count = recoveryFailureCount(previous.detail) + 1;
    timeline[index] = {
      ...previous,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      count,
      detail: `${previousKey} ×${count}`,
      eventRefs: mergeEventRefs(previous.eventRefs, entry.eventRefs),
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
  'agent.message_appended',
  'agent.session_started',
  'agent.model_output',
  'agent.model_request',
]);

export function projectPersistedTimeline(
  events: readonly EventEnvelope[],
  index: ActivityIndexState = createActivityIndex(),
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  for (const event of events) {
    const node = ingestActivityEvent(index, event);
    const projected = applyActivityNodeToEntries(projectTimelineEvent(event), node);
    appendTimelineEntries(timeline, projected);
  }
  return timeline;
}

/** Live append path shares the same fold/reducer as persisted replay. */
export function appendProjectedEvent(
  timeline: TimelineEntry[],
  event: EventEnvelope,
  index: ActivityIndexState,
  revision?: TimelineRevisionState,
): void {
  const node = ingestActivityEvent(index, event);
  const projected = applyActivityNodeToEntries(projectTimelineEvent(event), node);
  appendTimelineEntries(timeline, projected, revision);
}

export function projectTimelineEvent(event: EventEnvelope): readonly TimelineEntry[] {
  if (SILENT_TIMELINE_TYPES.has(event.type)) return [];
  const payload = record(event.payload);
  const entry = timelineEntryFactory(event);

  switch (event.type) {
    case 'recovery.started':
      return [
        entry('HARNESS', 'Recovery started', undefined, { hidden: true }),
        entry('HARNESS', 'working', undefined, {
          kind: 'live', placeholder: true, itemId: 'now:recovery', patch: 'replace', lane: 'recovery',
        }),
      ];
    case 'recovery.completed': {
      const value = record(payload.value);
      const finalStatus = text(payload.finalStatus) ?? text(value.finalStatus) ?? recoveryUserWord(payload, value);
      const unresolved = Array.isArray(value.unresolved)
        ? value.unresolved.filter((item): item is string => typeof item === 'string')
        : [];
      const excerpt = text(value.summary) ?? text(payload.summary) ?? text(payload.reportText) ?? text(value.reportText);
      const failed = finalStatus === '无法恢复' || text(payload.status) === 'failed';
      const blocked = finalStatus === '缺关键输入，补上后可重跑' || finalStatus === '恢复受阻' || text(value.status) === 'blocked';
      return [
        entry('HARNESS', finalStatus, excerpt, {
          lane: 'recovery',
          kind: 'deliver',
          ...(excerpt ? { original: excerpt } : {}),
          ...(failed && !blocked ? { level: 'error' as const } : {}),
        }),
        ...unresolved.map((item) => entry('HARNESS', item, undefined, { lane: 'recovery', kind: 'narrate' })),
        clearNow(entry, 'recovery'),
      ];
    }
    case 'agent.invocation_started':
    case 'agent.invocation_completed':
    case 'agent.invocation_failed':
    case 'agent.invocation_cancelled':
    case 'agent.tool_called':
    case 'agent.tool_completed':
    case 'agent.tool_failed':
    case 'agent.assistant_visible':
    case 'agent.context_compacted':
      return projectInternalNow(event.type, payload, entry);
    case 'runtime.tool_started':
    case 'runtime.tool_finished':
      return projectCandidateNow(event.type, payload, entry);
    default:
      return projectRunEvent(event, payload, entry);
  }
}

function projectRunEvent(event: EventEnvelope, payload: JsonRecord, entry: MakeEntry): readonly TimelineEntry[] {
  switch (event.type) {
    case 'run.attempt_created':
      return [entry('HARNESS', 'Run created', requestedModel(payload), { hidden: true })];
    case 'run.state_changed':
      return [entry('HARNESS', `State: ${text(payload.from) ?? '?'} → ${text(payload.to) ?? '?'}`, undefined, { hidden: true })];
    case 'input.submitted': {
      const prompt = text(payload.text);
      if (!prompt) return [];
      const deliveryId = deliveryIdentityFromPayload(payload);
      return [
        ...emitPresented(entry, 'TARGET', promptTitle(prompt), prompt, {
          role: 'candidate',
          verb: 'send',
          activityStatus: 'completed',
          ...(deliveryId ? { deliveryId } : {}),
        }),
        entry('TARGET', 'working', undefined, {
          kind: 'live', placeholder: true, itemId: 'now:target', patch: 'replace', voice: 'candidate',
          role: 'candidate', verb: 'working', activityStatus: 'started',
        }),
      ];
    }
    case 'candidate.session_bound': {
      const sessionId = text(payload.sessionId);
      return [entry('HARNESS', `Candidate session · ${sessionId ?? '?'}`, text(payload.productId), {
        hidden: true,
        role: 'system',
        ...(sessionId ? { sessionId } : {}),
      })];
    }
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
      return [
        ...projectOutcome(entry, payload),
        entry('TARGET', 'working', undefined, {
          hidden: true, kind: 'live', itemId: 'now:target', patch: 'replace', voice: 'candidate',
        }),
      ];
    case 'run.finished':
      return [entry('HARNESS', 'Candidate run finished', undefined, { hidden: true })];
    case 'runtime.runtime_failed':
      return [entry('TARGET', 'Runtime failed', text(payload.message), { level: 'error' })];
    case 'runtime.session_failed':
      return [entry('TARGET', 'Session failed', text(payload.message), { level: 'error' })];
    case 'report.created':
      return [entry('HARNESS', 'Report created', text(payload.path))];
    case 'controller.started':
      return [
        entry('CONTROLLER', 'Evaluation started', text(payload.model), { hidden: true }),
        entry('CONTROLLER', 'working', undefined, {
          kind: 'live', placeholder: true, itemId: 'now:controller', patch: 'replace', lane: 'controller',
        }),
      ];
    case 'controller.decision':
      return controllerEntries(event, payload);
    case 'controller.done':
      return [entry('CONTROLLER', `Done: ${text(payload.reason) ?? 'unknown'}`, undefined, { hidden: true })];
    case 'controller.failed':
      return [entry('CONTROLLER', 'Controller failed', text(payload.message), { level: 'error' })];
    case 'comparison.started':
      return [
        entry('CONTROLLER', 'Comparison started', text(payload.model), { hidden: true, lane: 'comparison' }),
        entry('CONTROLLER', 'working', undefined, {
          kind: 'live', placeholder: true, itemId: 'now:comparison', patch: 'replace', lane: 'comparison',
        }),
      ];
    case 'comparison.completed':
      return [
        ...projectComparisonCompleted(entry, payload),
        clearNow(entry, 'comparison'),
      ];
    default:
      return [];
  }
}

function timelineEntryFactory(event: EventEnvelope): MakeEntry {
  return (source, title, detail, extra) => {
    const semantics = semanticsFromEvent(event, {
      role: extra?.role ?? roleFromLane(extra?.lane, source),
      ...(extra?.verb ? { verb: extra.verb } : {}),
      ...(extra?.object ? { object: extra.object } : {}),
      ...(extra?.activityStatus ? { activityStatus: extra.activityStatus } : {}),
      ...(extra?.eventType ? { eventType: extra.eventType } : {}),
      ...(extra?.correlationId ? { correlationId: extra.correlationId } : {}),
      ...(extra?.deliveryId ? { deliveryId: extra.deliveryId } : {}),
      ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(extra?.turnId ? { turnId: extra.turnId } : {}),
      ...(extra?.eventRefs ? { eventRefs: extra.eventRefs } : {}),
      ...(extra?.linkUnknown ? { linkUnknown: true } : {}),
      ...(extra?.deliveryPaired ? { deliveryPaired: true } : {}),
      ...(extra?.truncated ? { truncated: true } : {}),
    });
    return {
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
      ...(extra?.voice ? { voice: extra.voice } : extra?.lane ? { voice: extra.lane } : {}),
      ...(semantics.role ? { role: semantics.role } : {}),
      ...(semantics.verb ? { verb: semantics.verb } : {}),
      ...(semantics.object ? { object: semantics.object } : {}),
      ...(semantics.activityStatus ? { activityStatus: semantics.activityStatus } : {}),
      ...(semantics.eventType ? { eventType: semantics.eventType } : {}),
      ...(semantics.correlationId ? { correlationId: semantics.correlationId } : {}),
      ...(semantics.deliveryId ? { deliveryId: semantics.deliveryId } : {}),
      ...(semantics.sessionId ? { sessionId: semantics.sessionId } : {}),
      ...(semantics.turnId ? { turnId: semantics.turnId } : {}),
      ...(semantics.eventRefs?.length ? { eventRefs: semantics.eventRefs } : {}),
      ...(semantics.linkUnknown ? { linkUnknown: true } : {}),
      ...(semantics.deliveryPaired ? { deliveryPaired: true } : {}),
      ...(semantics.truncated ? { truncated: true } : {}),
    };
  };
}

function agentLaneOf(payload: JsonRecord): AgentLane {
  return payload.role === 'controller' || payload.role === 'comparison' ? payload.role : 'recovery';
}

function projectInternalNow(type: string, payload: JsonRecord, entry: MakeEntry): readonly TimelineEntry[] {
  if (type === 'agent.context_compacted') return [];
  const lane = agentLaneOf(payload);
  if (type === 'agent.invocation_completed' || type === 'agent.invocation_failed' || type === 'agent.invocation_cancelled') {
    return [clearNow(entry, lane)];
  }
  if (type === 'agent.invocation_started') {
    const row = projectWorkingNow(lane);
    return [entry(laneSource(lane), row.title, undefined, row.extra)];
  }
  if (type === 'agent.assistant_visible') {
    const vis = projectAssistantVisible(payload);
    const idle = projectWorkingNow(lane);
    if (!vis.detail && vis.title === '…') {
      return [entry(laneSource(lane), idle.title, undefined, idle.extra)];
    }
    return [
      entry(laneSource(lane), vis.title, vis.detail, vis.extra),
      entry(laneSource(lane), idle.title, undefined, idle.extra),
    ];
  }
  const row = projectAgentTool(payload, type);
  const projected = entry(laneSource(row.extra.lane), row.title, row.detail, {
    ...row.extra,
    ...(row.original ? { original: row.original } : {}),
  });
  if (type !== 'agent.tool_completed' && type !== 'agent.tool_failed') return [projected];
  if (type === 'agent.tool_failed' || row.extra.level === 'error') {
    const idle = projectWorkingNow(row.extra.lane);
    return [projected, entry(laneSource(row.extra.lane), idle.title, undefined, idle.extra)];
  }
  if (row.detail === '不是 Git 仓库') {
    const idle = projectWorkingNow(row.extra.lane);
    return [projected, entry(laneSource(row.extra.lane), idle.title, undefined, idle.extra)];
  }
  const writeFlush = /写入/.test(row.title);
  const flushId = writeFlush ? `flush-write:${lane}` : `flush:${lane}`;
  return [
    entry(laneSource(lane), 'flush', row.detail, {
      hidden: true,
      itemId: flushId,
      patch: 'replace',
      lane,
      kind: writeFlush ? 'deliver' : 'investigate',
      count: 1,
    }),
    projected,
  ];
}

function projectCandidateNow(type: string, payload: JsonRecord, entry: MakeEntry): readonly TimelineEntry[] {
  if (type === 'runtime.tool_finished') return [];
  const live = publicLiveOf(payload);
  if (!live) return [];
  const caption = captionPublicLive(live.verb, live.leaf);
  const write = live.verb === 'write' || live.verb === 'edit';
  const now = entry('TARGET', caption.title, caption.detail, {
    kind: 'live', placeholder: true, itemId: 'now:target', patch: 'replace', voice: 'candidate',
  });
  if (live.verb === 'working') return [now];
  return [
    now,
    entry('TARGET', 'flush', caption.detail, {
      hidden: true,
      itemId: write ? 'flush-write:candidate' : 'flush:candidate',
      patch: 'replace',
      kind: write ? 'deliver' : 'investigate',
      count: 1,
      voice: 'candidate',
    }),
  ];
}

function projectUserView(entry: MakeEntry, payload: JsonRecord): readonly TimelineEntry[] {
  const status = text(payload.status) ?? 'unknown';
  const assistant = text(payload.assistantText);
  const prompt = text(payload.prompt);
  const clearNow = entry('TARGET', 'working', undefined, {
    hidden: true, kind: 'live', itemId: 'now:target', patch: 'replace', voice: 'candidate',
  });
  if (status === 'unavailable') {
    return [entry('TARGET', 'User view unavailable', undefined, { level: 'error' }), clearNow];
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
  rows.push(clearNow);
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
  const invocation = text(payload.status) ?? 'unknown';
  const failure = record(payload.failure);
  const value = record(payload.value);
  const valueStatus = text(value.status);
  const headline = text(value.headline);
  const failed = invocation === 'failed';
  const title = failed ? '对照失败' : valueStatus === 'insufficient_evidence' ? '证据不足' : '对照完成';
  return [entry('CONTROLLER', title, headline ?? (failed ? text(failure.message) : undefined), {
    lane: 'comparison',
    kind: 'deliver',
    ...(headline ? { original: headline } : {}),
    ...(failed ? { level: 'error' as const } : {}),
  })];
}

function controllerEntries(event: EventEnvelope, payload: JsonRecord): readonly TimelineEntry[] {
  if (text(payload.status) === 'failed') return [];
  const decision = record(payload.value);
  const kind = text(decision.type);
  if (!kind) return [];
  const make = timelineEntryFactory(event);
  const rationale = text(decision.rationale);
  if (kind === 'send') {
    const intent = text(decision.intent);
    const message = text(decision.message);
    const sessionId = text(payload.sessionId);
    const invocationId = text(payload.invocationId);
    return [{
      sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER',
      title: intent ? `Input to Target · ${intent}` : 'Input to Target',
      ...(message ? { detail: message } : {}),
      lane: 'controller',
      kind: 'deliver',
      role: 'controller',
      verb: 'send',
      activityStatus: 'completed',
      eventType: event.type,
      eventRefs: [{ eventId: event.eventId, sequence: event.sequence }],
      ...(sessionId ? { sessionId } : {}),
      ...(invocationId ? { correlationId: invocationId } : {}),
    }, clearNow(make, 'controller')];
  }
  const reason = text(decision.reason);
  return [{
    sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER',
    title: `DONE · ${doneReason(reason)}`,
    ...(rationale ? { detail: rationale } : {}),
    lane: 'controller',
    kind: 'deliver',
  }, clearNow(make, 'controller')];
}

function doneReason(reason: string | undefined): string {
  if (reason === 'no_further_value') return '没有继续的价值';
  if (reason === 'satisfied') return '任务已完成';
  if (reason === 'requires_real_user_decision') return '需要真人决定';
  if (reason === 'blocked') return '受阻';
  return reason ?? '结束';
}

function recoveryUserWord(payload: JsonRecord, value: JsonRecord): string {
  const envelope = text(value.status) ?? text(payload.status);
  if (envelope === 'partial' || envelope === 'recovered_partial') return '部分恢复';
  if (envelope === 'blocked') return '缺关键输入，补上后可重跑';
  if (envelope === 'failed' || envelope === 'insufficient_evidence') return '无法恢复';
  if (envelope === 'recovered' || envelope === 'ready' || envelope === 'completed') return '已恢复';
  return '无法恢复';
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

export function isNowRow(entry: TimelineEntry): boolean {
  return Boolean(entry.itemId?.startsWith('now:') && (entry.kind === 'live' || entry.placeholder));
}

function upsertNowRow(timeline: TimelineEntry[], entry: TimelineEntry): void {
  const itemId = entry.itemId;
  if (!itemId) return;
  const index = lastIndexByItemId(timeline, itemId);
  if (index >= 0) timeline.splice(index, 1);
  if (!entry.hidden) timeline.push(settleLiveId(entry));
  pinNowRows(timeline);
}

function pinNowRows(timeline: TimelineEntry[]): void {
  const nowEntries: TimelineEntry[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const row = timeline[i];
    if (row && !row.hidden && isNowRow(row)) {
      nowEntries.unshift(timeline.splice(i, 1)[0]!);
    }
  }
  timeline.push(...nowEntries);
}

function clearNow(entry: MakeEntry, lane: AgentLane): TimelineEntry {
  const row = projectWorkingNow(lane);
  return entry(laneSource(lane), row.title, undefined, { ...row.extra, hidden: true });
}

function shouldFlushBefore(entry: TimelineEntry): boolean {
  if (entry.hidden) return false;
  if (entry.kind === 'narrate') return true;
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('DONE ·')) return true;
  if (entry.title === 'Visible response') return true;
  if (entry.title === '已恢复' || entry.title === '部分恢复' || entry.title === '无法恢复') return true;
  if (entry.title === '对照完成' || entry.title === '证据不足' || entry.title === '对照失败') return true;
  return false;
}

function laneFromEntry(entry: TimelineEntry): AgentLane | 'candidate' {
  if (entry.lane) return entry.lane;
  if (entry.voice === 'candidate' || entry.source === 'TARGET') return 'candidate';
  if (entry.source === 'CONTROLLER') return 'controller';
  return 'recovery';
}

function bumpFlush(timeline: TimelineEntry[], entry: TimelineEntry): void {
  const itemId = entry.itemId;
  if (!itemId) return;
  const index = lastIndexByItemId(timeline, itemId);
  if (index < 0) {
    timeline.push(entry);
    return;
  }
  const previous = timeline[index]!;
  const detail = mergeFlushDetail(previous.detail, entry.detail);
  timeline[index] = {
    ...previous,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    count: (previous.count ?? 1) + (entry.count ?? 1),
    ...(detail ? { detail } : {}),
  };
}

function mergeFlushDetail(previous: string | undefined, next: string | undefined): string | undefined {
  const names = uniqueLeafNames([...(previous ?? '').split(/[·,]/), ...(next ?? '').split(/[·,]/)]);
  return names.length ? names.join(' · ') : undefined;
}

function flushLane(timeline: TimelineEntry[], lane: AgentLane | 'candidate'): void {
  emitFlush(timeline, `flush:${lane}`, flushFoldTitle);
  emitFlush(timeline, `flush-write:${lane}`, flushFoldTitle);
}

/** Canonical fold title for a flush counter / settled flush fold (read count or write first leaf). */
export function flushFoldTitle(row: TimelineEntry): string {
  if (row.itemId?.startsWith('flush-write:')) {
    return `▸ 写入 ${row.detail?.split(' · ')[0] ?? ''}`.trim();
  }
  return `▸ 阅读证据 · ${row.count ?? 1}`;
}

function emitFlush(timeline: TimelineEntry[], itemId: string, titleOf: (row: TimelineEntry) => string): void {
  const index = lastIndexByItemId(timeline, itemId);
  if (index < 0) return;
  const pending = timeline.splice(index, 1)[0];
  if (!pending) return;
  timeline.push({
    sequence: pending.sequence,
    occurredAt: pending.occurredAt,
    source: pending.source,
    title: titleOf(pending),
    kind: 'fold',
    itemId,
    ...(pending.lane ? { lane: pending.lane } : {}),
    ...(pending.voice ? { voice: pending.voice } : pending.source === 'TARGET' ? { voice: 'candidate' as const } : {}),
    ...(pending.count !== undefined ? { count: pending.count } : {}),
    ...(pending.detail ? { detail: pending.detail } : {}),
  });
}

export function filterTraceForSurface(
  entries: readonly TimelineEntry[],
  surface: 'recovery' | 'picker' | 'candidate' | 'compare' | 'result',
): readonly TimelineEntry[] {
  if (surface === 'compare') {
    return entries.filter((entry) => entry.lane === 'comparison' || entry.itemId === 'now:comparison');
  }
  if (surface === 'candidate' || surface === 'result') {
    return entries.filter((entry) => {
      if (entry.lane === 'recovery' || entry.itemId === 'now:recovery') return false;
      if (entry.title === '已恢复' || entry.title === '部分恢复' || entry.title === '无法恢复') return false;
      if (surface === 'result' && entry.lane === 'comparison') return false;
      // Result page is terminal: suppress live now-rows (incl. now:comparison) so product "working" chrome cannot linger.
      if (surface === 'result' && entry.itemId?.startsWith('now:')) return false;
      return true;
    });
  }
  return entries;
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
    ...(next.voice ? { voice: next.voice } : previous.voice ? { voice: previous.voice } : {}),
    eventRefs: mergeEventRefs(previous.eventRefs, next.eventRefs),
    ...(next.correlationId ? { correlationId: next.correlationId } : previous.correlationId
      ? { correlationId: previous.correlationId }
      : {}),
    ...(next.linkUnknown || previous.linkUnknown ? { linkUnknown: true } : {}),
    ...(next.deliveryId ? { deliveryId: next.deliveryId } : previous.deliveryId
      ? { deliveryId: previous.deliveryId }
      : {}),
    ...(next.sessionId ? { sessionId: next.sessionId } : previous.sessionId ? { sessionId: previous.sessionId } : {}),
  };
}

