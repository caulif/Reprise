import { Type } from '@sinclair/typebox';

export const ComparisonReviewRequestSchema = Type.Object({
  attemptId: Type.String({ minLength: 1 }), reviewInspectionContractVersion: Type.Literal(1),
}, { additionalProperties: false });

export const ComparisonReviewStartedSchema = Type.Object({
  schemaVersion: Type.Literal(1), attemptId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }), inspectionRequired: Type.Literal(true),
}, { additionalProperties: false });

export const ComparisonDraftInspectionSchema = Type.Object({
  schemaVersion: Type.Literal(1), status: Type.Literal('available'),
  draftDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  catalogRevision: Type.Integer({ minimum: 0 }),
  bindingRevision: Type.Integer({ minimum: 1 }),
  findingsRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  decisionShape: Type.Union([Type.Literal('single_difference'), Type.Literal('multiple_differences'), Type.Literal('unknown')]),
  reviewInspectionRequired: Type.Boolean(), semanticValidation: Type.Literal('not_performed'),
}, { additionalProperties: false });

export const ComparisonDraftAcceptanceReceiptSchema = Type.Object({
  ...Type.Omit(ComparisonDraftInspectionSchema, ['status', 'reviewInspectionRequired', 'semanticValidation']).properties,
  status: Type.Literal('accepted'),
}, { additionalProperties: false });
