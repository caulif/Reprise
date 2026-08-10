import { Value } from '@sinclair/typebox/value';
import { EvidenceRefSchema } from '../core/schema.js';
import { Type, type Static } from '@sinclair/typebox';
import { PiAgentHost, type StructuredAgentResult } from '../infrastructure/pi-agent-host.js';

export const ComparisonResultSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  observations: Type.Array(Type.Object({
    text: Type.String({ minLength: 1 }),
    evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
    side: Type.Optional(Type.Union([Type.Literal('baseline'), Type.Literal('candidate'), Type.Literal('both')])),
  })),
  limitations: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});
export type ComparisonResult = Static<typeof ComparisonResultSchema>;

export type ComparisonContext = {
  task: { caseId: string; summary: string };
  baseline: { summary: string; evidenceRefs: readonly string[] };
  candidates: readonly { runId: string; summary: string; evidenceRefs: readonly string[] }[];
  telemetry: readonly { runId: string; summary: string }[];
  fidelity: readonly { runId: string; comparisonClass: string }[];
  artifactRefs: readonly string[];
  allowModelText: boolean;
};

export interface ComparisonAgentPort {
  compare(context: ComparisonContext): Promise<StructuredAgentResult<ComparisonResult>>;
}

export class ComparisonAgent implements ComparisonAgentPort {
  readonly #host: PiAgentHost;
  readonly #timeoutMs: number;
  readonly #maxRepairAttempts: number;

  constructor(input: { host: PiAgentHost; timeoutMs: number; maxRepairAttempts: number }) {
    this.#host = input.host;
    this.#timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  async compare(context: ComparisonContext): Promise<StructuredAgentResult<ComparisonResult>> {
    return this.#host.request<ComparisonResult>({
      systemPrompt: 'Organize only the supplied comparison facts. Return exactly one JSON object with summary (string), observations (array of objects with text (string), evidence (array containing only supplied evidence refs), and optional side (baseline, candidate, or both)), limitations (array of strings), and generatedAt (ISO timestamp). Do not add top-level keys or modify runtime results or fidelity.',
      context,
      schema: ComparisonResultSchema,
      timeoutMs: this.#timeoutMs,
      maxRepairAttempts: this.#maxRepairAttempts,
      fallback: { summary: 'Comparison agent unavailable; report persisted facts only.', observations: [], limitations: ['No validated comparison narrative was available.'], generatedAt: new Date().toISOString() },
      allowModelText: context.allowModelText,
      capabilities: ['read_artifact'],
      validate: (result) => comparisonError(result, context),
    });
  }
}

export function assertComparisonResult(value: unknown, context: ComparisonContext): asserts value is ComparisonResult {
  const error = comparisonError(value, context);
  if (error) throw new Error(`Invalid ComparisonResult: ${error}.`);
}

function comparisonError(value: unknown, context: ComparisonContext): string | undefined {
  if (!Value.Check(ComparisonResultSchema, value)) return 'schema validation failed';
  const evidence = new Set([...context.baseline.evidenceRefs, ...context.candidates.flatMap((candidate) => candidate.evidenceRefs), ...context.artifactRefs]);
  return value.observations.some((observation) => observation.evidence.some((ref) => !evidence.has(ref))) ? 'unknown evidence reference' : undefined;
}
