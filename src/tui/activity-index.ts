import { record, text, type JsonRecord } from '../core/json.js';
import type { EventEnvelope } from '../core/schema.js';

/** Display role for public activity. Memory-only; not an on-disk schema. */
export type ActivityRole = 'recovery' | 'candidate' | 'controller' | 'comparison' | 'system';

/** Coarse verb for public activity. */
export type ActivityVerb =
  | 'read'
  | 'inspect'
  | 'write'
  | 'edit'
  | 'run'
  | 'send'
  | 'wait'
  | 'decide'
  | 'publish'
  | 'error'
  | 'working';

export type ActivityStatus = 'started' | 'updated' | 'completed' | 'failed' | 'cancelled';

/** Locates a journal row. Does not grant permission to show private payloads. */
export type ActivityEventRef = {
  readonly eventId: string;
  readonly sequence: number;
};

export type ActivityScope = {
  readonly experimentId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
};

export type ActivityNode = {
  readonly identity: string;
  role: ActivityRole;
  verb?: ActivityVerb;
  object?: string;
  status: ActivityStatus;
  eventType: string;
  occurredAt: string;
  correlationKey?: string;
  /** Failed/native row without a trusted call identity. */
  linkUnknown?: boolean;
  eventRefs: ActivityEventRef[];
  summaryTitle?: string;
  summaryDetail?: string;
  truncated?: boolean;
};

export type ActivityIndexState = {
  scope: ActivityScope;
  seenEventIds: Set<string>;
  nodes: Map<string, ActivityNode>;
  /** Trusted correlation key → active node identity. */
  activeByCorrelation: Map<string, string>;
  /** Insertion order of node identities. */
  order: string[];
  revision: number;
};

export type TimelineActivitySemantics = {
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
  readonly linkUnknown?: boolean;
  readonly deliveryPaired?: boolean;
  readonly truncated?: boolean;
};

export function createActivityIndex(scope: ActivityScope = {}): ActivityIndexState {
  return {
    scope: { ...scope },
    seenEventIds: new Set(),
    nodes: new Map(),
    activeByCorrelation: new Map(),
    order: [],
    revision: 0,
  };
}

export function resetActivityIndex(index: ActivityIndexState, scope: ActivityScope = {}): void {
  index.scope = { ...scope };
  index.seenEventIds.clear();
  index.nodes.clear();
  index.activeByCorrelation.clear();
  index.order.length = 0;
  index.revision = 0;
}

export function eventRefOf(event: EventEnvelope): ActivityEventRef {
  return { eventId: event.eventId, sequence: event.sequence };
}

export function mergeEventRefs(
  previous: readonly ActivityEventRef[] | undefined,
  next: readonly ActivityEventRef[] | undefined,
): ActivityEventRef[] {
  const out: ActivityEventRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(previous ?? []), ...(next ?? [])]) {
    const key = `${ref.eventId}:${ref.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Returns false when the same eventId was already ingested (idempotent replay). */
export function noteEventSeen(index: ActivityIndexState, eventId: string): boolean {
  if (index.seenEventIds.has(eventId)) return false;
  index.seenEventIds.add(eventId);
  return true;
}

export function roleFromLane(
  lane: string | undefined,
  source?: string,
): ActivityRole {
  if (lane === 'recovery' || lane === 'controller' || lane === 'comparison') return lane;
  if (source === 'TARGET') return 'candidate';
  if (source === 'CONTROLLER') return 'controller';
  if (source === 'HARNESS') return 'system';
  return 'system';
}

export function activityRoleFromPayload(payload: JsonRecord, fallback: ActivityRole = 'recovery'): ActivityRole {
  const role = text(payload.role);
  if (role === 'controller' || role === 'comparison' || role === 'recovery') return role;
  return fallback;
}

export function toolCorrelationKey(input: {
  role: ActivityRole;
  sessionId?: string;
  invocationId?: string;
  toolCallId?: string;
}): string | undefined {
  if (!input.toolCallId) return undefined;
  return [
    'tool',
    input.role,
    input.sessionId ?? '-',
    input.invocationId ?? '-',
    input.toolCallId,
  ].join(':');
}

export function candidateCallCorrelationKey(input: {
  sessionId?: string;
  turnId?: string;
  callId?: string;
}): string | undefined {
  if (!input.callId) return undefined;
  return ['call', input.sessionId ?? '-', input.turnId ?? '-', input.callId].join(':');
}

export function messageCorrelationKey(input: {
  role: ActivityRole;
  messageId?: string;
  itemId?: string;
}): string | undefined {
  if (input.messageId) return ['msg', input.role, input.messageId].join(':');
  if (input.itemId) return ['item', input.role, input.itemId].join(':');
  return undefined;
}

export function deliveryIdentityFromPayload(payload: JsonRecord): string | undefined {
  const clientMessageId = text(payload.clientMessageId);
  if (clientMessageId) return `client:${clientMessageId}`;
  const messageId = text(payload.messageId);
  if (messageId) return `message:${messageId}`;
  const turnIndex = payload.turnIndex;
  if (typeof turnIndex === 'number' && Number.isInteger(turnIndex) && turnIndex >= 0) {
    return `turn:${turnIndex}`;
  }
  return undefined;
}

export function presentedTextKey(raw: string | undefined): string | undefined {
  const key = raw?.replace(/\s+/g, ' ').trim();
  return key || undefined;
}

export function upsertActiveNode(
  index: ActivityIndexState,
  input: {
    identity: string;
    role: ActivityRole;
    verb?: ActivityVerb;
    object?: string;
    status: ActivityStatus;
    eventType: string;
    occurredAt: string;
    correlationKey?: string;
    linkUnknown?: boolean;
    eventRef: ActivityEventRef;
    summaryTitle?: string;
    summaryDetail?: string;
    truncated?: boolean;
  },
): ActivityNode {
  const existing = index.nodes.get(input.identity);
  const eventRefs = mergeEventRefs(existing?.eventRefs, [input.eventRef]);
  const node: ActivityNode = {
    identity: input.identity,
    role: input.role,
    ...(input.verb ? { verb: input.verb } : existing?.verb ? { verb: existing.verb } : {}),
    ...(input.object ? { object: input.object } : existing?.object ? { object: existing.object } : {}),
    status: input.status,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    ...(input.correlationKey ? { correlationKey: input.correlationKey } : existing?.correlationKey
      ? { correlationKey: existing.correlationKey }
      : {}),
    ...(input.linkUnknown || existing?.linkUnknown ? { linkUnknown: true } : {}),
    eventRefs,
    ...(input.summaryTitle ? { summaryTitle: input.summaryTitle } : existing?.summaryTitle
      ? { summaryTitle: existing.summaryTitle }
      : {}),
    ...(input.summaryDetail ? { summaryDetail: input.summaryDetail } : existing?.summaryDetail
      ? { summaryDetail: existing.summaryDetail }
      : {}),
    ...(input.truncated || existing?.truncated ? { truncated: true } : {}),
  };
  if (!existing) index.order.push(input.identity);
  index.nodes.set(input.identity, node);
  if (input.correlationKey && (input.status === 'started' || input.status === 'updated')) {
    index.activeByCorrelation.set(input.correlationKey, input.identity);
  }
  if (
    input.correlationKey
    && (input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled')
  ) {
    index.activeByCorrelation.delete(input.correlationKey);
  }
  index.revision += 1;
  return node;
}

export function clearActiveForRole(index: ActivityIndexState, role: ActivityRole, eventRef: ActivityEventRef, occurredAt: string): void {
  for (const [key, identity] of [...index.activeByCorrelation.entries()]) {
    const node = index.nodes.get(identity);
    if (!node || node.role !== role) continue;
    index.activeByCorrelation.delete(key);
    const { summaryDetail: priorDetail, ...rest } = node;
    index.nodes.set(identity, {
      ...rest,
      status: node.linkUnknown ? 'failed' : 'completed',
      occurredAt,
      eventRefs: mergeEventRefs(node.eventRefs, [eventRef]),
      ...(node.linkUnknown
        ? { summaryDetail: '调用结果未关联' }
        : priorDetail
          ? { summaryDetail: priorDetail }
          : {}),
    });
    index.revision += 1;
  }
}

export function activeNodes(index: ActivityIndexState): ActivityNode[] {
  const out: ActivityNode[] = [];
  for (const identity of index.activeByCorrelation.values()) {
    const node = index.nodes.get(identity);
    if (node) out.push(node);
  }
  return out;
}

export function historyNodes(index: ActivityIndexState): ActivityNode[] {
  const active = new Set(index.activeByCorrelation.values());
  const out: ActivityNode[] = [];
  for (const identity of index.order) {
    const node = index.nodes.get(identity);
    if (!node || active.has(node.identity)) continue;
    out.push(node);
  }
  return out;
}

export function nodeByCorrelation(index: ActivityIndexState, correlationKey: string): ActivityNode | undefined {
  const identity = index.activeByCorrelation.get(correlationKey) ?? [...index.nodes.values()]
    .find((node) => node.correlationKey === correlationKey)?.identity;
  return identity ? index.nodes.get(identity) : undefined;
}

/** Ingest one envelope into the index. Duplicate eventId is a no-op. */
export function ingestActivityEvent(index: ActivityIndexState, event: EventEnvelope): ActivityNode | undefined {
  if (!noteEventSeen(index, event.eventId)) return undefined;
  const payload = record(event.payload);
  const ref = eventRefOf(event);
  if (event.runId && !index.scope.runId) {
    index.scope = { ...index.scope, runId: event.runId };
  }
  switch (event.type) {
    case 'agent.tool_called':
      return ingestToolStart(index, event, payload, ref, 'started');
    case 'agent.tool_completed':
      return ingestToolEnd(index, event, payload, ref, 'completed');
    case 'agent.tool_failed':
      return ingestToolFailed(index, event, payload, ref);
    case 'runtime.tool_started':
      return ingestCandidateTool(index, event, payload, ref, 'started');
    case 'runtime.tool_finished':
      return ingestCandidateTool(index, event, payload, ref, 'completed');
    case 'agent.invocation_completed':
    case 'agent.invocation_failed':
    case 'agent.invocation_cancelled':
      clearActiveForRole(index, activityRoleFromPayload(payload), ref, event.occurredAt);
      return undefined;
    case 'candidate.session_bound': {
      const sessionId = text(payload.sessionId);
      if (sessionId) index.scope = { ...index.scope, sessionId };
      return undefined;
    }
    default:
      return undefined;
  }
}

function ingestToolStart(
  index: ActivityIndexState,
  event: EventEnvelope,
  payload: JsonRecord,
  ref: ActivityEventRef,
  status: ActivityStatus,
): ActivityNode {
  const role = activityRoleFromPayload(payload);
  const toolCallId = text(payload.toolCallId);
  const sessionId = text(payload.sessionId);
  const invocationId = text(payload.invocationId);
  const correlationKey = toolCorrelationKey({
    role,
    ...(sessionId ? { sessionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  });
  const identity = correlationKey ?? `orphan-start:${ref.eventId}`;
  const verb = toolVerbOf(text(payload.tool));
  const object = toolObjectOf(payload);
  const summaryTitle = text(payload.tool);
  return upsertActiveNode(index, {
    identity,
    role,
    status,
    eventType: event.type,
    occurredAt: event.occurredAt,
    eventRef: ref,
    ...(verb ? { verb } : {}),
    ...(object ? { object } : {}),
    ...(correlationKey ? { correlationKey } : { linkUnknown: true }),
    ...(summaryTitle ? { summaryTitle } : {}),
    ...(object ? { summaryDetail: object } : {}),
  });
}

function ingestToolEnd(
  index: ActivityIndexState,
  event: EventEnvelope,
  payload: JsonRecord,
  ref: ActivityEventRef,
  status: ActivityStatus,
): ActivityNode {
  const role = activityRoleFromPayload(payload);
  const toolCallId = text(payload.toolCallId);
  const sessionId = text(payload.sessionId);
  const invocationId = text(payload.invocationId);
  const correlationKey = toolCorrelationKey({
    role,
    ...(sessionId ? { sessionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  });
  const verb = toolVerbOf(text(payload.tool));
  const object = toolObjectOf(payload);
  const summaryTitle = text(payload.tool);
  if (!correlationKey) {
    return upsertActiveNode(index, {
      identity: `orphan-end:${ref.eventId}`,
      role,
      status,
      eventType: event.type,
      occurredAt: event.occurredAt,
      linkUnknown: true,
      eventRef: ref,
      ...(verb ? { verb } : {}),
      ...(object ? { object } : {}),
      ...(summaryTitle ? { summaryTitle } : {}),
      ...(object ? { summaryDetail: object } : {}),
    });
  }
  const prior = nodeByCorrelation(index, correlationKey);
  const resolvedVerb = verb ?? prior?.verb;
  const resolvedObject = object ?? prior?.object;
  const resolvedTitle = summaryTitle ?? prior?.summaryTitle;
  const resolvedDetail = object ?? prior?.summaryDetail;
  return upsertActiveNode(index, {
    identity: prior?.identity ?? correlationKey,
    role,
    status,
    eventType: event.type,
    occurredAt: event.occurredAt,
    correlationKey,
    eventRef: ref,
    ...(resolvedVerb ? { verb: resolvedVerb } : {}),
    ...(resolvedObject ? { object: resolvedObject } : {}),
    ...(resolvedTitle ? { summaryTitle: resolvedTitle } : {}),
    ...(resolvedDetail ? { summaryDetail: resolvedDetail } : {}),
  });
}

function ingestToolFailed(
  index: ActivityIndexState,
  event: EventEnvelope,
  payload: JsonRecord,
  ref: ActivityEventRef,
): ActivityNode {
  const role = activityRoleFromPayload(payload);
  const toolCallId = text(payload.toolCallId);
  const sessionId = text(payload.sessionId);
  const invocationId = text(payload.invocationId);
  const correlationKey = toolCorrelationKey({
    role,
    ...(sessionId ? { sessionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  });
  const object = toolObjectOf(payload);
  const summaryTitle = text(payload.tool) ?? 'tool';
  const summaryDetail = text(payload.message) ?? text(payload.error);
  if (!correlationKey) {
    // Confirmed gap: failed payload often omits toolCallId. Keep an independent error node.
    return upsertActiveNode(index, {
      identity: `orphan-fail:${ref.eventId}`,
      role,
      verb: 'error',
      status: 'failed',
      eventType: event.type,
      occurredAt: event.occurredAt,
      linkUnknown: true,
      eventRef: ref,
      summaryTitle,
      ...(object ? { object } : {}),
      ...(summaryDetail ? { summaryDetail } : {}),
    });
  }
  const prior = nodeByCorrelation(index, correlationKey);
  const resolvedObject = object ?? prior?.object;
  const resolvedTitle = text(payload.tool) ?? prior?.summaryTitle;
  const resolvedDetail = summaryDetail ?? prior?.summaryDetail;
  return upsertActiveNode(index, {
    identity: prior?.identity ?? correlationKey,
    role,
    verb: 'error',
    status: 'failed',
    eventType: event.type,
    occurredAt: event.occurredAt,
    correlationKey,
    eventRef: ref,
    ...(resolvedObject ? { object: resolvedObject } : {}),
    ...(resolvedTitle ? { summaryTitle: resolvedTitle } : {}),
    ...(resolvedDetail ? { summaryDetail: resolvedDetail } : {}),
  });
}

function ingestCandidateTool(
  index: ActivityIndexState,
  event: EventEnvelope,
  payload: JsonRecord,
  ref: ActivityEventRef,
  status: ActivityStatus,
): ActivityNode | undefined {
  const sessionId = text(payload.sessionId);
  const turnId = text(payload.turnId);
  const callId = text(payload.callId);
  const correlationKey = candidateCallCorrelationKey({
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(callId ? { callId } : {}),
  });
  const live = record(payload.live);
  const verb = liveVerbOf(text(live.verb));
  const object = text(live.leaf);
  if (!correlationKey && status === 'completed') {
    return upsertActiveNode(index, {
      identity: `orphan-call-end:${ref.eventId}`,
      role: 'candidate',
      ...(verb ? { verb } : {}),
      ...(object ? { object } : {}),
      status,
      eventType: event.type,
      occurredAt: event.occurredAt,
      linkUnknown: true,
      eventRef: ref,
      ...(object ? { summaryDetail: object } : {}),
    });
  }
  if (!correlationKey) {
    return upsertActiveNode(index, {
      identity: `orphan-call-start:${ref.eventId}`,
      role: 'candidate',
      ...(verb ? { verb } : {}),
      ...(object ? { object } : {}),
      status,
      eventType: event.type,
      occurredAt: event.occurredAt,
      linkUnknown: true,
      eventRef: ref,
      ...(object ? { summaryDetail: object } : {}),
    });
  }
  const prior = nodeByCorrelation(index, correlationKey);
  return upsertActiveNode(index, {
    identity: prior?.identity ?? correlationKey,
    role: 'candidate',
    ...(verb ? { verb } : prior?.verb ? { verb: prior.verb } : {}),
    ...(object ? { object } : prior?.object ? { object: prior.object } : {}),
    status,
    eventType: event.type,
    occurredAt: event.occurredAt,
    correlationKey,
    eventRef: ref,
    ...(object ? { summaryDetail: object } : prior?.summaryDetail ? { summaryDetail: prior.summaryDetail } : {}),
  });
}

function toolVerbOf(tool: string | undefined): ActivityVerb | undefined {
  if (!tool) return undefined;
  if (tool === 'read' || tool === 'ls' || tool === 'grep' || tool === 'find') return 'read';
  if (tool === 'shell_exec') return 'inspect';
  if (tool === 'write') return 'write';
  if (tool === 'edit') return 'edit';
  return 'inspect';
}

function liveVerbOf(verb: string | undefined): ActivityVerb | undefined {
  if (!verb) return undefined;
  if (
    verb === 'read' || verb === 'inspect' || verb === 'write' || verb === 'edit'
    || verb === 'run' || verb === 'working'
  ) return verb;
  return 'inspect';
}

function toolObjectOf(payload: JsonRecord): string | undefined {
  const params = record(payload.params);
  const details = record(payload.details);
  return text(params.path) ?? text(details.path) ?? text(params.command);
}

export function semanticsFromEvent(
  event: EventEnvelope,
  partial: TimelineActivitySemantics = {},
): TimelineActivitySemantics {
  const payload = record(event.payload);
  const ref = eventRefOf(event);
  const sessionId = partial.sessionId ?? text(payload.sessionId);
  const turnId = partial.turnId ?? text(payload.turnId);
  const deliveryId = partial.deliveryId ?? deliveryIdentityFromPayload(payload);
  const correlationId = partial.correlationId
    ?? text(payload.toolCallId)
    ?? text(payload.callId)
    ?? text(payload.messageId);
  return {
    ...partial,
    eventType: partial.eventType ?? event.type,
    eventRefs: mergeEventRefs(partial.eventRefs, [ref]),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
}
