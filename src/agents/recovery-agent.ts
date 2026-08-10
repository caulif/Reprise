import { Type, type Static } from '@sinclair/typebox';
import { EvidenceRefSchema } from '../core/schema.js';
import { PiAgentHost, type StructuredAgentResult } from '../infrastructure/pi-agent-host.js';

const RecoveryResultSchema = Type.Object({
  status: Type.Union([Type.Literal('ready_for_provider_validation'), Type.Literal('unavailable')]),
  proposedSteps: Type.Array(Type.String({ minLength: 1 })),
  evidenceRefs: Type.Array(EvidenceRefSchema),
});
export type RecoveryResult = Static<typeof RecoveryResultSchema>;
export type RecoveryContext = {
  stagingId: string;
  clues: readonly { summary: string; evidenceRef: string }[];
  playbook: { version: string; content: string };
  availableEvidenceRefs: readonly string[];
  allowModelText: boolean;
};

export interface RecoveryAgentPort {
  recover(context: RecoveryContext): Promise<StructuredAgentResult<RecoveryResult>>;
}

export class RecoveryAgent implements RecoveryAgentPort {
  readonly #host: PiAgentHost;
  readonly #timeoutMs: number;
  readonly #maxRepairAttempts: number;

  constructor(input: { host: PiAgentHost; timeoutMs: number; maxRepairAttempts: number }) {
    this.#host = input.host;
    this.#timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  async recover(context: RecoveryContext): Promise<StructuredAgentResult<RecoveryResult>> {
    const available = new Set(context.availableEvidenceRefs);
    return this.#host.request<RecoveryResult>({
      systemPrompt: 'Plan recovery only for the supplied Harness staging area. Return JSON. Never claim verification; the provider validates results.',
      context,
      schema: RecoveryResultSchema,
      timeoutMs: this.#timeoutMs,
      maxRepairAttempts: this.#maxRepairAttempts,
      fallback: { status: 'unavailable', proposedSteps: [], evidenceRefs: [] },
      allowModelText: context.allowModelText,
      capabilities: ['write_staging'],
      validate: (result) => result.evidenceRefs.some((ref) => !available.has(ref)) ? 'unknown evidence reference' : undefined,
    });
  }
}
