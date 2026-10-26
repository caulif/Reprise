import { record, text } from '../../../core/json.js';
import type { EventEnvelope } from '../../../core/schema.js';
import type { TargetRunFacts, UserSurfaceProjection } from '../../contract.js';
import { projectUserVisibleTurn, publicAssistantFacts } from '../../contract.js';

const EVIDENCE_TYPES = new Set([
  'runtime.turn_settled',
  'runtime.visible_output',
  'runtime.tool_started',
  'runtime.tool_finished',
]);

export const acpProjection: UserSurfaceProjection = {
  inspectRunFacts(events) {
    return inspectAcpRunFacts(events);
  },
  projectTurn(input) {
    return projectUserVisibleTurn({
      turnIndex: input.turnIndex,
      settlement: input.settlement,
      facts: inspectAcpRunFacts(input.events),
      allowModelText: input.allowModelText,
    });
  },
};

/** ACP streams assistant text as `agent_message_chunk`; only public text reaches this projection. */
function inspectAcpRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
  const outputs = events.filter((event) => event.type === 'runtime.visible_output');
  const texts = outputs
    .filter((event) => text(record(event.payload).kind) !== 'plan')
    .flatMap((event) => {
      const value = text(record(event.payload).text);
      return value ? [value] : [];
    });
  const commands = [...new Set(
    events
      .filter((event) => event.type === 'runtime.tool_started')
      .flatMap((event) => {
        const payload = record(event.payload);
        const title = text(payload.title);
        return text(payload.kind) === 'execute' && title ? [title] : [];
      }),
  )];
  return {
    ...publicAssistantFacts(texts),
    commands,
    rejectedApprovals: 0,
    evidenceEvents: events.filter((event) => EVIDENCE_TYPES.has(event.type)),
  };
}
