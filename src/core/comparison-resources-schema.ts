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
  model: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal('generation'), Type.Literal('compaction')]),
  usage: Type.Object({
    input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }), cacheWrite: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
  }),
});
export type AgentUsageFacts = Static<typeof AgentUsageFactsSchema>;

export const ComparisonResourceSummarySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  modelRequests: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Integer({ minimum: 0 }), usageReports: Type.Integer({ minimum: 0 }),
  estimatedCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  knownEstimatedCostUsd: Type.Number({ minimum: 0 }), pricingIncomplete: Type.Boolean(),
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
  startedAt: Type.Integer({ minimum: 0 }), finishedAt: Type.Integer({ minimum: 0 }),
  firstEventAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  firstTextAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), events: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
