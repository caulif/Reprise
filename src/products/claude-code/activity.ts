import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import type { EventEnvelope } from '../../core/schema.js';
import type { FileChange, TargetActivityEntry, TargetActivityTranslator, TargetRunFacts } from '../contract.js';

const PREFIX = 'claude-code.';
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const SUBTASK_TOOLS = new Set(['Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate']);
const SCHEDULE_TOOLS = new Set(['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'SendMessage']);

export const claudeActivityTranslator: TargetActivityTranslator = {
  translate(event) {
    if (!event.type.startsWith(PREFIX)) return [];
    const payload = record(event.payload);
    switch (event.type) {
      case 'claude-code.system_init':
        return sandboxFromInit(payload);
      case 'claude-code.assistant':
        return assistantBlocks(payload);
      case 'claude-code.user':
        return toolResults(payload);
      case 'claude-code.result':
        return resultUsage(payload);
      case 'claude-code.protocol_error':
        return [{ activity: { kind: 'runtime_error', message: text(payload.message) ?? 'unknown protocol error' } }];
      default:
        return [];
    }
  },
  inspectRunFacts(events) {
    return inspectClaudeRunFacts(events);
  },
};

export function inspectClaudeRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
  const assistants = events.filter((event) => event.type === 'claude-code.assistant');
  const texts = assistants.flatMap((event) => textBlocks(record(event.payload)));
  const commands = [...new Set(
    assistants.flatMap((event) => toolUses(record(event.payload)))
      .filter((item) => item.name === 'Bash')
      .map((item) => text(record(item.input).command))
      .filter((value): value is string => Boolean(value)),
  )];
  const rejectedApprovals = events.filter((event) => event.type === 'claude-code.result').reduce((count, event) => {
    const listed = record(event.payload).permission_denials;
    return count + (Array.isArray(listed) ? listed.length : 0);
  }, 0);
  const evidenceEvents = events.filter((event) => (
    event.type === 'runtime.turn_settled'
    || event.type === 'claude-code.assistant'
    || event.type === 'claude-code.result'
  ));
  const finalMessage = texts.at(-1);
  return {
    ...(finalMessage ? { finalMessage } : {}),
    commands,
    rejectedApprovals,
    evidenceEvents,
  };
}

function sandboxFromInit(payload: JsonRecord): readonly TargetActivityEntry[] {
  const permission = text(payload.permissionMode) ?? 'unknown';
  const identity = [text(payload.model), text(payload.claude_code_version)].filter(Boolean).join(' · ') || undefined;
  return [{
    activity: {
      kind: 'sandbox_notice',
      label: permission,
      ...(identity ? { identity } : {}),
      caveat: 'Out-of-workspace tools are disallowed. Isolation switches are recorded on the runtime fingerprint.',
    },
  }];
}

function assistantBlocks(payload: JsonRecord): readonly TargetActivityEntry[] {
  const message = record(payload.message);
  const content = message.content;
  if (!Array.isArray(content)) {
    const body = typeof content === 'string' ? content : text(payload.result);
    return body ? [{ activity: { kind: 'message', text: body } }] : [];
  }
  const entries: TargetActivityEntry[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && text(part.text)) entries.push({ activity: { kind: 'message', text: text(part.text)! } });
    if (part.type === 'thinking' && text(part.thinking)) entries.push({ activity: { kind: 'thinking', text: text(part.thinking)! } });
    if (part.type === 'tool_use') entries.push(...toolUse(part));
  }
  return entries;
}

function toolUse(part: JsonRecord): readonly TargetActivityEntry[] {
  const name = text(part.name) ?? 'tool';
  const id = text(part.id);
  const extra = id ? { correlationId: id } : {};
  const input = record(part.input);
  if (name === 'Bash') {
    return [{ activity: { kind: 'command', command: text(input.command) ?? 'command', status: 'started' }, ...extra }];
  }
  if (FILE_TOOLS.has(name)) {
    return [{ activity: { kind: 'file_change', changes: fileChanges(name, input), completed: false }, ...extra }];
  }
  if (SEARCH_TOOLS.has(name)) {
    const query = text(input.query) ?? text(input.url);
    return [{ activity: { kind: 'web_search', ...(query ? { query } : {}), completed: false }, ...extra }];
  }
  if (READ_TOOLS.has(name)) {
    const body = readableInput(input);
    return [{ activity: { kind: 'tool_call', name, status: 'started', ...(body ? { body } : {}) }, ...extra }];
  }
  if (SUBTASK_TOOLS.has(name)) {
    const body = readableInput(input);
    return [{ activity: { kind: 'subtask', name, status: 'started', ...(body ? { body } : {}) }, ...extra }];
  }
  if (SCHEDULE_TOOLS.has(name)) {
    const body = readableInput(input);
    return [{ activity: { kind: 'schedule', name, status: 'started', ...(body ? { body } : {}) }, ...extra }];
  }
  const body = readableInput(input);
  return [{ activity: { kind: 'other', label: name, ...(body ? { body } : {}) }, ...extra }];
}

function toolResults(payload: JsonRecord): readonly TargetActivityEntry[] {
  const content = record(payload.message).content ?? payload.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool_result') return [];
    const id = text(part.tool_use_id);
    const failed = part.is_error === true;
    const body = typeof part.content === 'string' ? part.content : undefined;
    return [{
      activity: { kind: 'tool_call', name: 'tool', status: failed ? 'failed' : 'completed', ...(body ? { body } : {}) },
      ...(id ? { correlationId: id } : {}),
    }];
  });
}

function resultUsage(payload: JsonRecord): readonly TargetActivityEntry[] {
  const usage = record(payload.usage);
  const total = number(usage.input_tokens) + number(usage.output_tokens);
  if (!total) return [];
  return [{
    activity: {
      kind: 'token_usage',
      total,
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      cached: number(usage.cache_read_input_tokens),
    },
    correlationId: 'tokens',
  }];
}

function fileChanges(name: string, input: JsonRecord): readonly FileChange[] {
  const path = text(input.file_path) ?? text(input.path) ?? 'file';
  const kind = name === 'Write' ? 'add' : name === 'NotebookEdit' ? 'edit' : 'update';
  const diff = text(input.new_string) ?? text(input.contents) ?? text(input.content);
  return [{ path, kind, ...(diff ? { diff } : {}) }];
}

function textBlocks(payload: JsonRecord): string[] {
  const content = record(payload.message).content;
  if (typeof content === 'string' && content.trim()) return [content];
  if (!Array.isArray(content)) return [];
  return content.map((part) => (isRecord(part) && part.type === 'text' ? text(part.text) : undefined)).filter((value): value is string => Boolean(value));
}

function toolUses(payload: JsonRecord): JsonRecord[] {
  const content = record(payload.message).content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is JsonRecord => isRecord(part) && part.type === 'tool_use');
}

function readableInput(input: JsonRecord): string | undefined {
  const keys = Object.keys(input);
  if (!keys.length) return undefined;
  try { return JSON.stringify(input); } catch { return undefined; }
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
