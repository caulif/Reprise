import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import type { EventEnvelope } from '../../core/schema.js';
import type {
  FileChange,
  TargetActivity,
  TargetActivityEntry,
  TargetActivityTranslator,
  TargetRunFacts,
} from '../contract.js';

const PREFIX = 'codex.';

export const codexActivityTranslator: TargetActivityTranslator = {
  translate(event) {
    if (!event.type.startsWith(PREFIX)) return [];
    const payload = record(event.payload);
    switch (event.type) {
      case 'codex.thread_started':
        return sandboxNotice(payload);
      case 'codex.turn_started':
        return [{ activity: { kind: 'message', streaming: true } }];
      case 'codex.turn_plan_updated':
        return plan(payload);
      case 'codex.item_started':
        return targetItem(payload, false);
      case 'codex.item_completed':
        return targetItem(payload, true);
      case 'codex.item_agentMessage_delta':
        return streamDelta(payload, 'message');
      case 'codex.item_commandExecution_outputDelta':
        return streamDelta(payload, 'command');
      case 'codex.mcpServer_startupStatus_updated':
        return mcpStatus(payload);
      case 'codex.thread_tokenUsage_updated':
        return tokenUsage(payload);
      case 'codex.model_rerouted':
        return [{
          activity: {
            kind: 'other',
            label: 'Model rerouted',
            body: `${text(payload.fromModel) ?? '?'} → ${text(payload.toModel) ?? '?'}`,
          },
        }];
      case 'codex.protocol_error':
        return [{ activity: { kind: 'runtime_error', message: text(payload.message) ?? 'unknown protocol error' } }];
      case 'codex.stderr':
        return [];
      default:
        return [];
    }
  },
  inspectRunFacts(events) {
    return inspectCodexRunFacts(events);
  },
};

export function inspectCodexRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
  const completed = events.filter((event) => event.type === 'codex.item_completed');
  const targetItems = completed.map((event) => record(event.payload).item).filter(isRecord);
  const finalMessage = targetItems
    .filter((item) => item.type === 'agentMessage')
    .map((item) => (typeof item.text === 'string' ? item.text : undefined))
    .filter((value): value is string => Boolean(value))
    .at(-1);
  const commands = [...new Set(
    targetItems
      .filter((item) => item.type === 'commandExecution')
      .map((item) => (typeof item.command === 'string' ? item.command : undefined))
      .filter((value): value is string => Boolean(value)),
  )];
  const rejected = events.filter((event) => event.type === 'codex.server_request_rejected');
  const evidenceEvents = events.filter((event) => (
    event.type === 'runtime.turn_settled'
    || event.type === 'codex.item_completed'
    || event.type === 'codex.server_request_rejected'
  ));
  return {
    ...(finalMessage ? { finalMessage } : {}),
    commands,
    rejectedApprovals: rejected.length,
    evidenceEvents,
  };
}

function sandboxNotice(payload: JsonRecord): readonly TargetActivityEntry[] {
  const sandbox = text(payload.sandbox);
  if (!sandbox) return [];
  const model = text(payload.model) ?? text(payload.requestedModel);
  const effort = text(payload.effort);
  const identity = [model, effort].filter(Boolean).join(' · ') || undefined;
  const caveat = sandbox === 'danger-full-access'
    ? 'Windows workspace-write cannot apply deny-read ACLs. Isolation is the frozen workspace copy.'
    : sandbox === 'workspace-write'
      ? 'Commands that read host paths outside the isolated workspace will fail.'
      : undefined;
  return [{
    activity: {
      kind: 'sandbox_notice',
      label: sandbox,
      ...(identity ? { identity } : {}),
      ...(caveat ? { caveat } : {}),
    },
  }];
}

function plan(payload: JsonRecord): readonly TargetActivityEntry[] {
  if (!Array.isArray(payload.plan)) return [];
  return [{
    activity: {
      kind: 'plan',
      steps: payload.plan.map((value) => {
        const step = record(value);
        return { status: text(step.status) ?? 'unknown', step: text(step.step) ?? 'unnamed step' };
      }),
    },
  }];
}

function targetItem(payload: JsonRecord, completed: boolean): readonly TargetActivityEntry[] {
  const item = record(payload.item);
  const type = text(item.type);
  const itemId = text(item.id);
  const extra = itemId ? { correlationId: itemId } : {};
  if (type === 'reasoning') return reasoningItem(item, completed, extra);
  if (type === 'userMessage') {
    if (!completed) return [];
    const prompt = itemText(item);
    return prompt ? [{ activity: { kind: 'prompt', text: prompt }, ...extra }] : [];
  }
  if (type === 'commandExecution') {
    const command = text(item.command) ?? 'command';
    const status = commandStatus(text(item.status), completed);
    const output = completed ? text(item.aggregatedOutput) : undefined;
    const blocked = completed && status === 'failed' && isSandboxFailure(output);
    const actions = commandActions(item);
    return [{
      activity: {
        kind: 'command',
        command,
        status,
        ...(output ? { output } : {}),
        ...(text(item.cwd) ? { cwd: text(item.cwd)! } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
        ...(blocked ? { blockedBySandbox: true } : {}),
        ...(actions ? { actions } : {}),
      },
      ...extra,
    }];
  }
  if (type === 'agentMessage') {
    const message = itemText(item);
    return [{
      activity: {
        kind: 'message',
        ...(message ? { text: message } : {}),
        ...(!completed ? { streaming: true } : {}),
      },
      ...extra,
    }];
  }
  if (type === 'fileChange' || type === 'file_change' || type === 'proposedFileChange') {
    return [{ activity: { kind: 'file_change', changes: fileChanges(item), completed }, ...extra }];
  }
  if (type === 'webSearch' || type === 'web_search') {
    const query = text(item.query) ?? text(item.searchTerm) ?? itemText(item);
    return [{
      activity: { kind: 'web_search', ...(query ? { query } : {}), completed },
      ...extra,
    }];
  }
  if (type === 'mcpToolCall' || type === 'mcp_tool_call') {
    const name = text(item.server) ?? text(item.name) ?? 'MCP tool';
    const body = itemText(item) ?? readableFields(item, ['arguments', 'output', 'result', 'error']);
    return [{
      activity: { kind: 'tool_call', name: `MCP · ${name}`, status: completed ? 'completed' : 'started', ...(body ? { body } : {}) },
      ...extra,
    }];
  }
  if (!type) return [];
  const label = type.replace(/([a-z])([A-Z])/g, '$1 $2');
  const body = itemText(item) ?? readableFields(item);
  return [{
    activity: { kind: 'other', label: completed ? label : `${label}…`, ...(body ? { body } : {}) },
    ...extra,
  }];
}

function reasoningItem(item: JsonRecord, completed: boolean, extra: { correlationId?: string }): readonly TargetActivityEntry[] {
  const summary = reasoningText(item);
  if (!completed) {
    return [{ activity: { kind: 'thinking', ...(summary ? { text: summary } : {}), streaming: true }, ...extra }];
  }
  return [{ activity: { kind: 'thinking', ...(summary ? { text: summary } : {}) }, ...extra }];
}

function streamDelta(payload: JsonRecord, kind: 'message' | 'command'): readonly TargetActivityEntry[] {
  const delta = text(payload.delta);
  if (!delta) return [];
  const itemId = text(payload.itemId);
  const activity: TargetActivity = kind === 'message'
    ? { kind: 'message', text: delta, streaming: true }
    : { kind: 'command', command: '', status: 'started', output: delta };
  return [{ activity, merge: 'append', ...(itemId ? { correlationId: itemId } : {}) }];
}

function mcpStatus(payload: JsonRecord): readonly TargetActivityEntry[] {
  const name = text(payload.name) ?? 'MCP';
  const statusText = text(payload.status) ?? 'unknown';
  const error = text(payload.error) ?? text(payload.failureReason);
  const failed = /fail/i.test(statusText) || Boolean(error);
  return [{
    activity: {
      kind: 'tool_call',
      name: `MCP · ${name} ${statusText}`,
      status: failed ? 'failed' : statusText === 'ready' || statusText === 'running' ? 'completed' : 'started',
      ...(error ? { body: error } : {}),
    },
    correlationId: `mcp:${name}`,
  }];
}

function tokenUsage(payload: JsonRecord): readonly TargetActivityEntry[] {
  const usage = record(record(payload.tokenUsage).total);
  return [{
    activity: {
      kind: 'token_usage',
      total: number(usage.totalTokens),
      input: number(usage.inputTokens),
      output: number(usage.outputTokens),
      reasoning: number(usage.reasoningOutputTokens),
      cached: number(usage.cachedInputTokens),
    },
    correlationId: 'tokens',
  }];
}

function commandStatus(status: string | undefined, completed: boolean): 'started' | 'completed' | 'failed' {
  if (status === 'failed') return 'failed';
  if (!completed) return 'started';
  return 'completed';
}

function commandActions(item: JsonRecord): readonly string[] | undefined {
  if (!Array.isArray(item.commandActions) || item.commandActions.length === 0) return undefined;
  const lines = item.commandActions.map((value) => {
    const action = record(value);
    const command = text(action.command);
    const kind = text(action.type) ?? 'action';
    return command ? `${kind}: ${command}` : kind;
  }).filter((line) => line.trim());
  return lines.length ? lines : undefined;
}

function isSandboxFailure(output: string | undefined): boolean {
  return Boolean(output && /sandbox|deny-read ACL|helper_unknown_error/i.test(output));
}

function itemText(item: JsonRecord): string | undefined {
  const direct = text(item.text);
  if (direct && direct.trim()) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.map((part) => text(record(part).text) ?? '').filter((part) => part.trim());
  return parts.length ? parts.join('\n') : undefined;
}

function reasoningText(item: JsonRecord): string | undefined {
  const summary = Array.isArray(item.summary)
    ? item.summary.map((part) => text(record(part).text) ?? (typeof part === 'string' ? part : '')).filter((part) => part.trim()).join('\n')
    : text(item.summary);
  if (summary?.trim()) return summary;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.map((part) => text(record(part).text) ?? '').filter((part) => part.trim());
  return parts.length ? parts.join('\n') : undefined;
}

function fileChanges(item: JsonRecord): readonly FileChange[] {
  const changes = Array.isArray(item.changes) ? item.changes : Array.isArray(item.files) ? item.files : [item];
  return changes.map((value) => {
    const change = record(value);
    const path = text(change.path) ?? text(change.filename) ?? 'file';
    const kind = text(change.kind) ?? text(change.status) ?? 'changed';
    const diff = text(change.unifiedDiff) ?? text(change.diff) ?? text(change.patch);
    return { path, kind, ...(diff ? { diff } : {}) };
  });
}

function readableFields(item: JsonRecord, keys?: readonly string[]): string | undefined {
  const selected = keys ?? Object.keys(item).filter((key) => key !== 'type' && key !== 'id' && key !== 'status');
  const lines = selected.map((key) => {
    const value = item[key];
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'string') return `${key}  ${value}`;
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}  ${value}`;
    try {
      return `${key}  ${JSON.stringify(value)}`;
    } catch {
      return undefined;
    }
  }).filter((line): line is string => Boolean(line));
  return lines.length ? lines.join('\n') : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
