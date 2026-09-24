import { Type, type Static } from '@sinclair/typebox';
import { ComparisonShortRefSchema } from '../comparison-schema.js';
import { EvidenceRefSchema } from './ids.js';

export const ControllerDecisionSchema = Type.Union([
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

export const ComparisonResultSchema = Type.Object({
  status: Type.Union([Type.Literal('completed'), Type.Literal('insufficient_evidence')]),
  evidenceRefs: Type.Array(ComparisonShortRefSchema),
  headline: Type.Optional(Type.String({ minLength: 1, maxLength: 280 })),
  reportPath: Type.Optional(Type.Literal('report.html')),
});
export type ComparisonAgentEnvelope = Static<typeof ComparisonResultSchema>;
