import { Type, type Static } from '@sinclair/typebox';

export const TimingFactsSchema = Type.Object({
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
