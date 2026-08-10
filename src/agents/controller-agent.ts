import { Type, type Static } from '@sinclair/typebox';
import { EvidenceRefSchema, type CandidateRunState, type TaskCase } from '../core/schema.js';
import { PiAgentHost, type StructuredAgentResult } from '../infrastructure/pi-agent-host.js';

const ControllerDecisionSchema = Type.Union([
  Type.Object({
    type: Type.Literal('send'),
    message: Type.String({ minLength: 1 }),
    intent: Type.Union([Type.Literal('continue'), Type.Literal('inform'), Type.Literal('correct'), Type.Literal('verify')]),
    rationale: Type.Optional(Type.String()),
    evidenceRefs: Type.Optional(Type.Array(EvidenceRefSchema)),
  }),
  Type.Object({
    type: Type.Literal('done'),
    reason: Type.Union([Type.Literal('satisfied'), Type.Literal('blocked'), Type.Literal('requires_real_user_decision'), Type.Literal('no_further_value')]),
    rationale: Type.Optional(Type.String()),
  }),
]);
export type ControllerDecision = Static<typeof ControllerDecisionSchema>;

export type SteeringContext = {
  runId: string;
  runState: CandidateRunState;
  task: Pick<TaskCase, 'initialInput' | 'transcript' | 'baseline' | 'privacy'>;
  current: { summary: string; evidenceRefs: readonly string[] };
  trajectory: { summary: string; evidenceRefs: readonly string[] };
  priorDecisions: readonly ControllerDecision[];
  budget: { targetTurnsUsed: number; targetTurnsLimit: number };
  permissions: { requiresRealUserDecision: boolean };
};

export interface ControllerPort {
  decide(context: SteeringContext): Promise<StructuredAgentResult<ControllerDecision>>;
}

const SYSTEM_PROMPT = [
  'You are the user-collaboration controller for a personal agent comparison.',
  'Treat the original conversation as evidence, not a replay script.',
  'Never present later discoveries as prior user knowledge, invent authority, or execute the target task.',
  'Return exactly one JSON object: send uses type, message, intent, optional rationale, and optional evidenceRefs; done uses type, reason, and optional rationale.',
  'send.intent must be continue, inform, correct, or verify; done.reason must be satisfied, blocked, requires_real_user_decision, or no_further_value.',
].join(' ');

export class ControllerAgent implements ControllerPort {
  readonly #host: PiAgentHost;
  readonly #timeoutMs: number;
  readonly #maxRepairAttempts: number;

  constructor(input: { host: PiAgentHost; timeoutMs: number; maxRepairAttempts: number }) {
    this.#host = input.host;
    this.#timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  async decide(context: SteeringContext): Promise<StructuredAgentResult<ControllerDecision>> {
    if (context.runState !== 'awaiting_controller') throw new Error('Controller can only decide while CandidateRun awaits controller input.');
    const available = new Set([...context.current.evidenceRefs, ...context.trajectory.evidenceRefs]);
    return this.#host.request<ControllerDecision>({
      systemPrompt: SYSTEM_PROMPT,
      context,
      schema: ControllerDecisionSchema,
      timeoutMs: this.#timeoutMs,
      maxRepairAttempts: this.#maxRepairAttempts,
      fallback: { type: 'done', reason: 'no_further_value', rationale: 'Controller output was unavailable.' },
      allowModelText: context.task.privacy.allowModelText,
      capabilities: ['read_observation'],
      validate: (decision) => decision.type === 'send' && decision.evidenceRefs?.some((ref) => !available.has(ref)) ? 'unknown evidence reference' : undefined,
    });
  }
}
