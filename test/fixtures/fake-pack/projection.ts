import { record, text } from '../../../src/core/json.js';
import type { EventEnvelope } from '../../../src/core/schema.js';
import type { UserSurfaceProjection, TargetRunFacts } from '../../../src/products/contract.js';
import { projectUserVisibleTurn, publicAssistantFacts } from '../../../src/products/contract.js';

export const fakeActivityTranslator: UserSurfaceProjection = {
  inspectRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
    const messages = events.filter((event) => event.type === 'fake.message' || event.type === 'runtime.visible_output');
    const texts = messages.map((event) => text(record(event.payload).text));
    return {
      ...publicAssistantFacts(texts),
      commands: [],
      rejectedApprovals: 0,
      evidenceEvents: messages,
    };
  },
  projectTurn(input) {
    return projectUserVisibleTurn({
      turnIndex: input.turnIndex,
      settlement: input.settlement,
      facts: fakeActivityTranslator.inspectRunFacts(input.events),
      allowModelText: input.allowModelText,
    });
  },
};
