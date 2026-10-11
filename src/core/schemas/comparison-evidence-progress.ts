import { Type } from '@sinclair/typebox';

export const ComparisonEvidenceProgressSchema = Type.Object({
  schemaVersion: Type.Literal(1), phase: Type.Union([Type.Literal('investigate'), Type.Literal('review')]),
  sourceToolCallId: Type.String({ minLength: 1, maxLength: 256 }),
  tool: Type.String({ minLength: 1, maxLength: 64 }), contentDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  byteLength: Type.Integer({ minimum: 0 }), semanticAssessment: Type.Literal('not_certified'),
}, { additionalProperties: false });
