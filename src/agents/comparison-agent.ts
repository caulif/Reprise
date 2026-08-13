import { Type, type Static } from '@sinclair/typebox';
import { EvidenceRefSchema } from '../core/schema.js';
import { PiAgentHost, type AgentInvocation, type AgentToolDefinition } from '../infrastructure/pi-agent-host.js';

export const ComparisonResultSchema = Type.Object({
  status: Type.Union([Type.Literal('completed'), Type.Literal('insufficient_evidence')]),
  reportPath: Type.Literal('comparison.md'),
  evidenceRefs: Type.Array(EvidenceRefSchema),
  limitationCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type ComparisonResult = Static<typeof ComparisonResultSchema>;

export type ComparisonContext = {
  task: { caseId: string; summary: string };
  baseline: { summary: string; evidenceRefs: readonly string[] };
  candidates: readonly { runId: string; summary: string; evidenceRefs: readonly string[] }[];
  telemetry: readonly { runId: string; summary: string }[];
  artifactRefs: readonly string[];
  allowModelText: boolean;
};

export interface ComparisonAgentPort {
  compare(context: ComparisonContext, tools?: readonly AgentToolDefinition[]): Promise<AgentInvocation<ComparisonResult>>;
}

const SYSTEM_PROMPT = [
  'You are Reprise Comparison, a read-only evidence investigator.',
  'Begin from the supplied briefing and manifest. Use Host evidence tools only when a narrower read can affect the user-facing conclusion; do not read all material by default.',
  'Distinguish observed facts, inference, unavailable evidence, result differences, process differences, and replay limitations. Do not rank candidates or convert a harness failure into a capability claim.',
  'Write a free-form user-facing comparison.md with navigable evidence references. Return only a thin JSON envelope: completed or insufficient_evidence, comparison.md, used evidence refs, and optional limitation codes.',
  'comparison.md is the only body the user reads: the Host wraps it in a thin shell (identity, run metrics, file list) and adds nothing else, so you decide what to show and how to organize it. Cite artifact relative paths when a detail matters; the user opens those files. Write Markdown only, never raw HTML.',
].join(' ');

export class ComparisonAgent implements ComparisonAgentPort {
  readonly #host: PiAgentHost;
  readonly #timeoutMs: number;
  readonly #maxRepairAttempts: number;

  constructor(input: { host: PiAgentHost; timeoutMs: number; maxRepairAttempts: number }) {
    this.#host = input.host;
    this.#timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  async compare(context: ComparisonContext, tools: readonly AgentToolDefinition[] = []): Promise<AgentInvocation<ComparisonResult>> {
    const available = new Set([...context.baseline.evidenceRefs, ...context.candidates.flatMap((candidate) => candidate.evidenceRefs), ...context.artifactRefs]);
    return this.#host.request<ComparisonResult>({
      role: 'comparison', systemPrompt: SYSTEM_PROMPT, context, schema: ComparisonResultSchema,
      timeoutMs: this.#timeoutMs, maxRepairAttempts: this.#maxRepairAttempts,
      allowModelText: context.allowModelText, tools,
      validate: (result) => result.evidenceRefs.some((ref) => !available.has(ref)) ? 'unknown evidence reference' : undefined,
    });
  }
}

export function assertComparisonResult(value: unknown, context: ComparisonContext): asserts value is ComparisonResult {
  if (value === null || typeof value !== 'object') throw new Error('Invalid ComparisonEnvelope: schema validation failed.');
  const available = new Set([...context.baseline.evidenceRefs, ...context.candidates.flatMap((candidate) => candidate.evidenceRefs), ...context.artifactRefs]);
  const refs = (value as { evidenceRefs?: unknown }).evidenceRefs;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !available.has(ref))) throw new Error('Invalid ComparisonEnvelope: unknown evidence reference.');
}
