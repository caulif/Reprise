import { Value } from '@sinclair/typebox/value';
import { CandidateProgressCheckpointSchema, type EventEnvelope } from '../core/schema.js';
import { record, text } from '../core/json.js';

/** Reads durable facts only. Silence is not evidence of a stuck model and never triggers a model call. */
export function candidateProgress(events: readonly EventEnvelope[]) {
  const checkpoint = [...events].reverse().find(event => event.type === 'candidate.progress_checkpoint');
  const receipt = checkpoint && Value.Check(CandidateProgressCheckpointSchema, checkpoint.payload) ? checkpoint.payload : undefined;
  const lastTool = [...events].reverse().find(event => ['runtime.tool_started', 'runtime.tool_finished', 'agent.tool_called', 'agent.tool_completed', 'agent.tool_failed'].includes(event.type));
  const commands = new Map<string, { sessionId: string; state: string; eventId: string }>();
  for (const event of events) {
    if (event.type !== 'agent.tool_completed') continue;
    const details = record(record(event.payload).details);
    const sessionId = text(details.session_id), state = text(details.state);
    if (sessionId && state) commands.set(sessionId, { sessionId, state, eventId: event.eventId });
  }
  return {
    status: events.some(event => event.type === 'run.finished') ? 'stopped' : receipt?.delivery === 'unknown' ? 'unknown_delivery'
      : receipt?.nextAction === 'controller_decision' ? 'waiting' : 'active',
    ...(receipt ? { checkpoint: receipt } : {}),
    ...(lastTool ? { lastActualTool: { eventId: lastTool.eventId, type: lastTool.type, occurredAt: lastTool.occurredAt } } : {}),
    backgroundCommands: [...commands.values()].filter(command => command.state === 'running'),
  };
}
