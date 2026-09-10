import { record, text } from '../../../core/json.js';
import type { EventEnvelope } from '../../../core/schema.js';
import type { UserSurfaceProjection, TargetRunFacts } from '../../contract.js';
import { projectUserVisibleTurn } from '../../contract.js';

export const claudeProjection: UserSurfaceProjection = {
  inspectRunFacts(events) {
    return inspectClaudeRunFacts(events);
  },
  projectTurn(input) {
    return projectUserVisibleTurn({
      turnIndex: input.turnIndex,
      settlement: input.settlement,
      facts: inspectClaudeRunFacts(input.events),
      allowModelText: input.allowModelText,
    });
  },
};

function inspectClaudeRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
  const assistants = events.filter((event) => event.type === 'runtime.visible_output');
  const texts = assistants.flatMap((event) => textBlocks(record(event.payload)));
  const commands = [...new Set(
    assistants.flatMap((event) => toolUses(record(event.payload)))
      .filter((item) => item.name === 'Bash')
      .map((item) => text(record(item.input).command))
      .filter((value): value is string => Boolean(value)),
  )];
  const rejectedApprovals = events.filter((event) => event.type === 'runtime.usage_reported').reduce((count, event) => {
    const listed = record(event.payload).permission_denials;
    return count + (Array.isArray(listed) ? listed.length : 0);
  }, 0);
  const evidenceEvents = events.filter((event) => (
    event.type === 'runtime.turn_settled'
    || event.type === 'runtime.visible_output'
    || event.type === 'runtime.usage_reported'
  ));
  const finalMessage = texts.at(-1);
  return {
    ...(finalMessage ? { finalMessage } : {}),
    commands,
    rejectedApprovals,
    evidenceEvents,
  };
}

function textBlocks(payload: ReturnType<typeof record>): string[] {
  const content = record(record(payload.message).content ? record(payload.message) : payload).content;
  if (!Array.isArray(content)) {
    const direct = text(payload.text);
    return direct ? [direct] : [];
  }
  return content.flatMap((part) => {
    const block = record(part);
    return block.type === 'text' && text(block.text) ? [text(block.text) as string] : [];
  });
}

function toolUses(payload: ReturnType<typeof record>): readonly { name: string; input: unknown }[] {
  const content = record(record(payload.message).content ? record(payload.message) : payload).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = record(part);
    const name = text(block.name);
    return block.type === 'tool_use' && name ? [{ name, input: block.input }] : [];
  });
}
