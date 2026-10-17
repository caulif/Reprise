import { Type, type Static } from '@sinclair/typebox';

export const RuntimeTurnTimingSchema = Type.Object({
  schemaVersion: Type.Literal(1), valueMs: Type.Number({ minimum: 0 }),
  semantics: Type.Literal('runtime_turn_elapsed'), boundary: Type.Literal('runtime_admission_to_settlement'),
  aggregation: Type.Literal('per_turn'), turnId: Type.String(), clientMessageId: Type.String(), resultId: Type.Optional(Type.String()),
});

export const TimingComparisonSchema = Type.Object({
  status: Type.Union([Type.Literal('comparable'), Type.Literal('reference'), Type.Literal('incomplete'), Type.Literal('unavailable')]),
  reasons: Type.Array(Type.String()),
});
export type TimingComparison = Static<typeof TimingComparisonSchema>;

export const TimingFactsSchema = Type.Object({
  schemaVersion: Type.Optional(Type.Literal(2)),
  semantics: Type.Optional(Type.String()),
  boundary: Type.Optional(Type.String()),
  scope: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal('session_record'), Type.Literal('selected_task')]),
    identity: Type.Optional(Type.String()), refs: Type.Array(Type.String()) })),
  sessionCoverage: Type.Optional(Type.Object({ initializationOnlyStarts: Type.Integer({ minimum: 0 }), activeMissingEnds: Type.Integer({ minimum: 0 }) })),
  outcomes: Type.Optional(Type.Object({ failed: Type.Integer({ minimum: 0 }), aborted: Type.Integer({ minimum: 0 }) })),
  valueMs: Type.Optional(Type.Number({ minimum: 0 })),
  basis: Type.Union([Type.Literal('turn_wall_clock_sum'), Type.Literal('run_wall_clock_span')]),
  coverage: Type.Object({
    completedTurns: Type.Integer({ minimum: 0 }),
    measuredTurns: Type.Integer({ minimum: 0 }),
    openTurns: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unavailable')]),
  }),
  sources: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal('duration_ms'), Type.Literal('turn_timestamps'), Type.Literal('matched_events'), Type.Literal('submission_settlement'), Type.Literal('run_span')]),
    refs: Type.Array(Type.String()),
  })),
  diagnostics: Type.Array(Type.String()),
});

export type TimingFacts = Static<typeof TimingFactsSchema>;
