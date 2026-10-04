import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1, pattern: '^[a-z0-9-]+$' });
const Count = Type.Integer({ minimum: 0 });
const SideSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  file: Type.String({ minLength: 1, pattern: '^[a-z0-9-]+\\.(txt|md|js|json|html|svg)$' }),
  content: Type.Optional(Type.String()),
  finalMessage: Type.String(),
  process: Type.Array(Type.String()),
});
const ComparisonEvaluationCaseSchema = Type.Object({
  id: Id,
  taskClass: Type.Union((['code', 'text', 'data', 'visual', 'interaction', 'insufficient'] as const).map(value => Type.Literal(value))),
  provenance: Type.Literal('synthetic'),
  task: Type.String({ minLength: 1 }),
  baseline: SideSchema,
  candidate: SideSchema,
  expectations: Type.Object({
    decisiveFacts: Type.Array(Type.Object({ id: Id, description: Type.String({ minLength: 1 }) }), { minItems: 1 }),
    limitations: Type.Array(Type.Object({ id: Id, description: Type.String({ minLength: 1 }) })),
    forbiddenInferences: Type.Array(Type.String({ minLength: 1 })),
  }),
});
export type ComparisonEvaluationCase = Static<typeof ComparisonEvaluationCaseSchema>;
export const ComparisonEvaluationSuiteSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  cases: Type.Array(ComparisonEvaluationCaseSchema, { minItems: 12 }),
});
export type ComparisonEvaluationSuite = Static<typeof ComparisonEvaluationSuiteSchema>;
export const ComparisonEvaluationLedgerSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  suiteHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  model: Type.String({ minLength: 1 }),
  providerId: Type.Optional(Type.String({ minLength: 1 })),
  inputCapabilities: Type.Optional(Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]))),
  rows: Type.Array(Type.Object({
    caseId: Id,
    repetition: Type.Integer({ minimum: 1 }),
    variant: Type.Union([Type.Literal('original'), Type.Literal('swapped'), Type.Literal('blind')]),
    inputIdentityHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')]),
    reportPath: Type.Optional(Type.String({ minLength: 1 })),
    reportHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    eventsPath: Type.String({ minLength: 1 }),
    eventsHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    elapsedMs: Type.Number({ minimum: 0 }),
    mainTextCharacters: Type.Optional(Count),
    modelRequests: Count,
    toolCalls: Count,
    compactions: Count,
    retries: Type.Optional(Count),
    previews: Type.Optional(Count),
    usageCoverage: Type.Optional(Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('missing')])),
    usage: Type.Optional(Type.Object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, totalTokens: Count })),
    estimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    knownEstimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    pricingLookup: Type.Union([Type.Literal('hit'), Type.Literal('miss'), Type.Literal('invalid')]),
    review: Type.Optional(Type.Object({
      reviewer: Type.String({ minLength: 1 }),
      reviewedReportHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      supportedFactIds: Type.Array(Id),
      disclosedLimitationIds: Type.Array(Id),
      unsupportedClaims: Count,
      factualErrors: Count,
      processMisattributions: Count,
      counterevidenceHandled: Type.Boolean(),
      understandableWithin30Seconds: Type.Boolean(),
      readabilityAssessment: Type.Optional(Type.Union([Type.Literal('agent_estimate'), Type.Literal('human_reader_test'), Type.Literal('not_measured')])),
      readingSeconds: Type.Number({ minimum: 0 }),
      canonicalPreference: Type.Union((['baseline', 'candidate', 'conditional', 'similar', 'unknown'] as const).map(value => Type.Literal(value))),
      preferenceReason: Type.String({ minLength: 1 }),
      notes: Type.String(),
    })),
  })),
});
export type ComparisonEvaluationLedger = Static<typeof ComparisonEvaluationLedgerSchema>;
