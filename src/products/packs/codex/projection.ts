import { isRecord, record, text, type JsonRecord } from '../../../core/json.js';
import type { EventEnvelope } from '../../../core/schema.js';
import type { UserSurfaceProjection, TargetRunFacts } from '../../contract.js';
import { projectUserVisibleTurn } from '../../contract.js';

export const codexProjection: UserSurfaceProjection = {
  inspectRunFacts(events) {
    return inspectCodexRunFacts(events);
  },
  projectTurn(input) {
    return projectUserVisibleTurn({
      turnIndex: input.turnIndex,
      settlement: input.settlement,
      facts: inspectCodexRunFacts(input.events),
      allowModelText: input.allowModelText,
    });
  },
};

function inspectCodexRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
  const completed = events.filter((event) => event.type === 'runtime.tool_finished' || event.type === 'runtime.visible_output');
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
  const prompt = events
    .filter((event) => event.type === 'runtime.visible_prompt')
    .map((event) => itemText(record(record(event.payload).item)))
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .at(-1);
  const rejected = events.filter((event) => event.type === 'runtime.runtime_failed');
  const evidenceEvents = events.filter((event) => (
    event.type === 'runtime.turn_settled'
    || event.type === 'runtime.tool_finished'
    || event.type === 'runtime.visible_output'
    || event.type === 'runtime.visible_prompt'
    || event.type === 'runtime.runtime_failed'
  ));
  return {
    ...(finalMessage ? { finalMessage } : {}),
    ...(prompt ? { prompt } : {}),
    commands,
    rejectedApprovals: rejected.length,
    evidenceEvents,
  };
}

function itemText(item: JsonRecord): string | undefined {
  const direct = text(item.text);
  if (direct && direct.trim()) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.map((part) => text(record(part).text) ?? '').filter((part) => part.trim());
  return parts.length ? parts.join('\n') : undefined;
}
