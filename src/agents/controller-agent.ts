import { Type, type Static } from '@sinclair/typebox';
import { EvidenceRefSchema, type CandidateRunState, type TaskCase } from '../core/schema.js';
import { AgentSessionHost, PiAgentHost, type AgentInvocation, type AgentToolDefinition } from '../infrastructure/pi-agent-host.js';

const ControllerDecisionSchema = Type.Union([
  Type.Object({
    type: Type.Literal('send'), message: Type.String({ minLength: 1 }),
    intent: Type.Union([Type.Literal('continue'), Type.Literal('inform'), Type.Literal('correct'), Type.Literal('verify')]),
    rationale: Type.Optional(Type.String()), evidenceRefs: Type.Optional(Type.Array(EvidenceRefSchema)),
  }),
  Type.Object({
    type: Type.Literal('done'),
    reason: Type.Union([Type.Literal('satisfied'), Type.Literal('blocked'), Type.Literal('requires_real_user_decision'), Type.Literal('no_further_value')]),
    rationale: Type.Optional(Type.String()), evidenceRefs: Type.Optional(Type.Array(EvidenceRefSchema)),
  }),
]);
export type ControllerDecision = Static<typeof ControllerDecisionSchema>;

export type SteeringContext = {
  runId: string;
  runState: CandidateRunState;
  task: Pick<TaskCase, 'initialInput' | 'baseline' | 'privacy'>;
  current: { summary: string; evidenceRefs: readonly string[] };
  trajectory: { summary: string; evidenceRefs: readonly string[] };
  budget: { decisionsUsed: number; decisionsLimit: number };
};

export interface ControllerPort {
  decide(context: SteeringContext, tools?: readonly AgentToolDefinition[]): Promise<AgentInvocation<ControllerDecision>>;
  cancel?(runId: string, factRef?: string): Promise<void>;
}

const SYSTEM_PROMPT = [
  'You are the continuous user-collaboration Controller in a Reprise experiment.',
  'Model the original user’s demonstrated goals, knowledge, constraints, and decision boundary; do not replay later discoveries as prior knowledge.',
  'You may inspect only Host-provided observations and evidence. Never execute the target task, write a workspace, bypass a permission boundary, or use other candidates. The decision budget counts your own decisions, not target turns.',
  'After each settled Candidate turn, choose exactly one JSON decision. send has a concise message and intent continue, inform, correct, or verify. done means only that you will not send further messages; Host determines runtime outcome.',
  'Use done:requires_real_user_decision for an authority/approval decision that the historical user cannot safely supply. Never output stop.',
].join(' ');

export class ControllerAgent implements ControllerPort {
  readonly #host: PiAgentHost;
  readonly #timeoutMs: number;
  readonly #maxRepairAttempts: number;
  readonly #sessions = new Map<string, Promise<AgentSessionHost>>();

  constructor(input: { host: PiAgentHost; timeoutMs: number; maxRepairAttempts: number }) {
    this.#host = input.host;
    this.#timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  async decide(context: SteeringContext, tools: readonly AgentToolDefinition[] = []): Promise<AgentInvocation<ControllerDecision>> {
    if (context.runState !== 'awaiting_controller') throw new Error('Controller can only decide while CandidateRun awaits controller input.');
    const available = new Set([...context.current.evidenceRefs, ...context.trajectory.evidenceRefs]);
    let pending = this.#sessions.get(context.runId);
    if (!pending) {
      pending = this.#host.createSession({ role: 'controller', systemPrompt: SYSTEM_PROMPT, allowModelText: context.task.privacy.allowModelText, tools });
      this.#sessions.set(context.runId, pending);
    }
    const session = await pending;
    return session.request({
      context, schema: ControllerDecisionSchema, timeoutMs: this.#timeoutMs, maxRepairAttempts: this.#maxRepairAttempts,
      validate: (decision) => decision.type === 'send' && decision.evidenceRefs?.some((ref) => !available.has(ref)) ? 'unknown evidence reference' : undefined,
    });
  }

  async cancel(runId: string, factRef?: string): Promise<void> {
    const session = this.#sessions.get(runId);
    if (session) await (await session).cancel(factRef);
    this.#sessions.delete(runId);
  }
}
