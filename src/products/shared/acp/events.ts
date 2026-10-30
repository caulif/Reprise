import { record, text } from '../../../core/json.js';
import { runtimeTargetEvent, type TargetEvent } from '../../../core/runtime.js';
import type { PublicLiveActivity } from '../../../core/schema.js';
import { toolFacts } from '../tool-facts.js';

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
  if (kind === 'plan') {
    const value = planText(update.entries);
    return value ? [runtimeTargetEvent('visible_output', { sessionId, kind: 'plan', text: value })] : [];
  }
  return [];
}

/**
 * A `plan` update carries `entries[]` with priority and status per entry. Only each entry's `content` is text the
 * agent meant to be read, so the adapter joins those and drops the structure rather than persisting the agent's
 * own JSON shape into the Journal.
 */
function planText(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  const lines = entries.flatMap((entry) => {
    const value = text(record(entry).content)?.trim();
    return value ? [value] : [];
  });
  return lines.length ? lines.join('\n') : undefined;
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
  const output = record(update.rawOutput);
  return {
    ...(callId ? { callId } : {}),
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    ...(text(update.status) ? { status: text(update.status) } : {}),
    ...(verb ? { live: { schemaVersion: 1, verb, ...(title ? { leaf: title.slice(0, 80) } : {}) } } : {}),
    ...toolFacts({ name: toolName(title), input: update.rawInput, exitCode: output.exitCode ?? output.exit_code }),
  };
}

/**
 * ACP defines `title` as human-readable text for a person, and an agent may write a sentence there. Only a bare
 * identifier can be the agent's own tool name, so a sentence stays a title and never becomes a name.
 */
const TOOL_IDENTIFIER = /^[A-Za-z][\w.:-]{0,39}$/;

/**
 * An agent often titles a read call with the object it touched (`README.md`, `main.ts`) or a version (`v1.2.3`).
 * Such a title is that object, not a tool the agent called, so it stays a title. A dotted tool name whose last
 * segment is not a file extension (`mcp.filesystem.read`) is still a name.
 */
const OBJECT_SUFFIX = /\.(\d+|md|markdown|txt|text|ts|tsx|js|jsx|mjs|cjs|json|jsonl|ya?ml|toml|ini|cfg|conf|lock|log|csv|tsv|xml|html?|css|scss|less|svg|png|jpe?g|gif|webp|ico|pdf|py|rb|go|rs|java|kt|kts|cs|c|h|cc|cpp|hpp|sh|bash|zsh|ps1|bat|cmd|sql|env)$/i;

function toolName(title: string | undefined): string | undefined {
  return title && TOOL_IDENTIFIER.test(title) && !OBJECT_SUFFIX.test(title) ? title : undefined;
}
