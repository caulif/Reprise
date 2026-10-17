import { Type, type Static } from '@sinclair/typebox';

export const ComparisonResourcesSchema = Type.Object({
  investigationModelRequests: Type.Optional(Type.Integer({ minimum: 1 })),
  investigationToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
  investigationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxModelRequests: Type.Optional(Type.Integer({ minimum: 1 })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
  maxElapsedMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxEstimatedCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});
export type ComparisonResources = Static<typeof ComparisonResourcesSchema>;

export const AgentUsageFactsSchema = Type.Object({
  requestId: Type.Optional(Type.String({ minLength: 1 })),
  estimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  pricingModelId: Type.Optional(Type.String({ minLength: 1 })),
  pricingVersion: Type.Optional(Type.String({ minLength: 1 })),
  pricingSource: Type.Optional(Type.String({ minLength: 1 })),
  rates: Type.Optional(Type.Object({ input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }), cacheCreation: Type.Number({ minimum: 0 }) })),
  model: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal('generation'), Type.Literal('compaction')]),
  usage: Type.Object({
    input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }), cacheWrite: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
  }),
});
export type AgentUsageFacts = Static<typeof AgentUsageFactsSchema>;

export const AgentUsageEstimateSchema = Type.Composite([AgentUsageFactsSchema, Type.Object({
  requestId: Type.String({ minLength: 1 }),
  basis: Type.Literal('pi-character-heuristic-v1'),
  reason: Type.Literal('failed_request_usage_missing'),
  failureKind: Type.String({ minLength: 1 }),
  errorMessage: Type.String({ maxLength: 1000 }),
})]);
export type AgentUsageEstimate = Static<typeof AgentUsageEstimateSchema>;

export const CostBasisSchema = Type.Union([Type.Literal('reported_usage'), Type.Literal('includes_fallback'), Type.Literal('incomplete')]);

export const ComparisonResourceSummarySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  modelRequests: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Integer({ minimum: 0 }), usageReports: Type.Integer({ minimum: 0 }),
  estimatedCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  knownEstimatedCostUsd: Type.Number({ minimum: 0 }), pricingIncomplete: Type.Boolean(),
  fallbackEstimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  fallbackRequests: Type.Optional(Type.Integer({ minimum: 0 })),
  costBasis: Type.Optional(CostBasisSchema),
  investigationLimit: Type.Union([Type.String(), Type.Null()]),
});

export const ComparisonSourceContinuationSchema = Type.Object({
  role: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()), attemptId: Type.Optional(Type.String()),
  schemaVersion: Type.Literal(1), phase: Type.String(), granted: Type.Boolean(), reason: Type.String(),
  oldDeadline: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  newDeadline: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  remainingMs: Type.Number({ minimum: 0 }), extension: Type.Integer({ minimum: 0, maximum: 2 }),
}, { additionalProperties: false });

export const AgentModelStreamSchema = Type.Object({
  role: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()), attemptId: Type.Optional(Type.String()),
  schemaVersion: Type.Literal(1), invocationId: Type.Optional(Type.String()), requestIndex: Type.Integer({ minimum: 0 }),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
  startedAt: Type.Integer({ minimum: 0 }), finishedAt: Type.Integer({ minimum: 0 }),
  firstEventAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  firstTextAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), events: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
