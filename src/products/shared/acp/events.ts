import { record, text } from '../../../core/json.js';
import { runtimeTargetEvent, type TargetEvent } from '../../../core/runtime.js';
import type { PublicLiveActivity } from '../../../core/schema.js';

const LIVE_VERBS: Readonly<Record<string, PublicLiveActivity['verb']>> = {
  read: 'read',
  edit: 'edit',
  delete: 'write',
  move: 'write',
  search: 'inspect',
  execute: 'run',
  think: 'working',
  fetch: 'inspect',
  other: 'working',
};

const FINISHED_TOOL_STATUSES = new Set(['completed', 'failed']);

/** Maps one `session/update` notification to journal events. Unknown updates stay inside the adapter. */
export function acpSessionUpdateEvents(sessionId: string, params: unknown): readonly TargetEvent[] {
  const update = record(record(params).update);
  const kind = text(update.sessionUpdate);
  if (kind === 'agent_message_chunk') return textEvent('visible_output', sessionId, update);
  if (kind === 'user_message_chunk') return textEvent('visible_prompt', sessionId, update);
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const payload = { sessionId, ...toolPayload(update) };
    const finished = FINISHED_TOOL_STATUSES.has(text(update.status) ?? '');
    // A terminal `tool_call` is the only record of that tool, so it is announced before it is settled.
    if (kind === 'tool_call') return finished
      ? [runtimeTargetEvent('tool_started', payload), runtimeTargetEvent('tool_finished', payload)]
      : [runtimeTargetEvent('tool_started', payload)];
    return finished ? [runtimeTargetEvent('tool_finished', payload)] : [];
  }
  if (kind === 'plan') return [runtimeTargetEvent('visible_output', { sessionId, kind: 'plan', entries: update.entries })];
  return [];
}

/**
 * Only text reaches the Journal. A chunk may also carry an image or resource blob, and the adapter must not let a
 * Candidate decide which binary payload gets persisted. The chunk's own `messageId` stays out too: the Journal only
 * accepts an id that a `message_submitted`/`delivery_observed` opener registered, and ACP issues no such id.
 */
function textEvent(type: 'visible_output' | 'visible_prompt', sessionId: string, update: Record<string, unknown>): readonly TargetEvent[] {
  const value = text(record(update.content).text);
  return value ? [runtimeTargetEvent(type, { sessionId, text: value })] : [];
}

function toolPayload(update: Record<string, unknown>): Record<string, unknown> {
  const callId = text(update.toolCallId);
  const kind = text(update.kind);
  const title = text(update.title);
  const verb = kind ? LIVE_VERBS[kind] : undefined;
  return {
    ...(callId ? { callId } : {}),
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    ...(text(update.status) ? { status: text(update.status) } : {}),
    ...(verb ? { live: { schemaVersion: 1, verb, ...(title ? { leaf: title.slice(0, 80) } : {}) } } : {}),
  };
}
