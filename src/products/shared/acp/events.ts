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
  if (kind === 'agent_message_chunk') return [runtimeTargetEvent('visible_output', { sessionId, ...textChunk(update) })];
  if (kind === 'user_message_chunk') return [runtimeTargetEvent('visible_prompt', { sessionId, ...textChunk(update) })];
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const finished = kind === 'tool_call_update' && FINISHED_TOOL_STATUSES.has(text(update.status) ?? '');
    return [runtimeTargetEvent(finished ? 'tool_finished' : 'tool_started', { sessionId, ...toolPayload(update) })];
  }
  if (kind === 'plan') return [runtimeTargetEvent('visible_output', { sessionId, kind: 'plan', entries: update.entries })];
  return [];
}

function textChunk(update: Record<string, unknown>): Record<string, unknown> {
  const content = record(update.content);
  return {
    ...(text(update.messageId) ? { messageId: text(update.messageId) } : {}),
    ...(text(content.text) ? { text: text(content.text) } : {}),
    content,
  };
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
