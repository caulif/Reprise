import { Type, type Static } from "@sinclair/typebox";

const text = Type.String({ minLength: 1, maxLength: 1200 });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" });
const refs = Type.Array(Type.String({ pattern: "^(ev|media)-[0-9]{2,6}$" }), { maxItems: 16, uniqueItems: true });
const side = Type.Union([Type.Literal("baseline"), Type.Literal("candidate")]);
const boundaryText = Type.String({ minLength: 1, maxLength: 240, pattern: "^[^<>\\r\\n]*\\S[^<>\\r\\n]*$" });
const instances = Type.Array(boundaryText, { maxItems: 12, uniqueItems: true });
const boundary = { relationship: boundaryText, domain: boundaryText, uncheckedInstances: instances };
const ComparisonSupportBoundarySchema = Type.Union([
  Type.Object({ ...boundary, supportStage: Type.Literal("delivered_output"), coveredInstances: Type.Array(boundaryText, { minItems: 1, maxItems: 12, uniqueItems: true }) }, { additionalProperties: false }),
  Type.Object({ ...boundary, supportStage: Type.Literal("intermediate_only"), coveredInstances: instances }, { additionalProperties: false }),
  Type.Object({ ...boundary, supportStage: Type.Literal("unavailable"), coveredInstances: Type.Array(boundaryText, { maxItems: 0 }) }, { additionalProperties: false }),
]);
export type ComparisonSupportBoundary = Static<typeof ComparisonSupportBoundarySchema>;
const final = Type.Object({
  side,
  sourceRefs: refs,
  status: Type.Union([Type.Literal("located"), Type.Literal("unavailable")]),
  description: text,
}, { additionalProperties: false });
const observation = Type.Object({
  side,
  method: Type.Union([
    Type.Literal("source_inspection"), Type.Literal("execution_record"), Type.Literal("sample"),
    Type.Literal("mathematical_recomputation"), Type.Literal("self_report"), Type.Literal("unavailable"),
  ]),
  result: text,
  scope: text,
  evidenceRefs: refs,
  timing: Type.Union([Type.Literal("original_run"), Type.Literal("comparison_check")]),
  supportBoundary: Type.Optional(ComparisonSupportBoundarySchema),
}, { additionalProperties: false });

export const ComparisonFindingsSubmissionSchema = Type.Object({
  criteria: Type.Array(text, { minItems: 1, maxItems: 12, description: 'Task success criteria. Each finding.criterion must repeat one of these strings exactly, without paraphrasing.' }),
  finals: Type.Array(final, { minItems: 2, maxItems: 2 }),
  findings: Type.Array(Type.Object({
    id,
    criterion: Type.String({ minLength: 1, maxLength: 1200, description: 'Copy exactly one string from criteria. Do not abbreviate, summarize or paraphrase it.' }),
    difference: text,
    userConsequence: text,
    observations: Type.Array(observation, { minItems: 2, maxItems: 2, description: 'Exactly two observations per finding: one baseline and one candidate. Combine multiple measurements for the same side in its single result and scope. If that side cannot be verified, use method=unavailable and describe the uncertainty; never invent opposite-side evidence.' }),
    limitations: Type.Array(text, { maxItems: 8 }),
    counterEvidenceRefs: refs,
  }, { additionalProperties: false }), { maxItems: 12 }),
  decisionQuestions: Type.Array(Type.Object({
    id,
    question: text,
    decisionImpact: text,
    status: Type.Union([Type.Literal("pending"), Type.Literal("resolved"), Type.Literal("unavailable")]),
    evidenceRefs: refs,
    resolution: Type.Optional(text),
    nextCheck: Type.Optional(text),
    reopenReason: Type.Optional(text),
  }, { additionalProperties: false }), { maxItems: 16, description: 'Complete question history, not a patch: include every previously accepted ID with the exact same question and decisionImpact, even after catalog changes. Pending requires nextCheck; resolved/unavailable requires resolution; settled to pending requires reopenReason. Repair feedback contains prior model-authored claims, not certified answers. Do not erase or automatically resolve history.' }),
  importantLimitations: Type.Array(text, { maxItems: 12 }),
}, { additionalProperties: false, description: 'Complete replacement snapshot. Preserve all previously accepted decision questions and their identities; rejected submissions do not mutate the saved state.' });
export type ComparisonFindingsSubmission = Static<typeof ComparisonFindingsSubmissionSchema>;

const toolObservation = Type.Object({ ...observation.properties, supportBoundary: ComparisonSupportBoundarySchema }, { additionalProperties: false });
const baseFinding = ComparisonFindingsSubmissionSchema.properties.findings.items;
export const ComparisonFindingsToolSubmissionSchema = Type.Object({
  ...ComparisonFindingsSubmissionSchema.properties,
  findings: Type.Array(Type.Object({ ...baseFinding.properties,
    observations: Type.Array(toolObservation, { minItems: 2, maxItems: 2 }),
  }, { additionalProperties: false }), { maxItems: 12 }),
}, { additionalProperties: false });

export const ComparisonDiscoveryRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Type.String({ minLength: 1, maxLength: 128 }),
  revision: Type.Integer({ minimum: 1 }),
  catalogRevision: Type.Integer({ minimum: 0 }),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  submission: ComparisonFindingsSubmissionSchema,
}, { additionalProperties: false });
export type ComparisonDiscoveryRecord = Static<typeof ComparisonDiscoveryRecordSchema>;

const discoveryBinding = Type.Object({ revision: Type.Integer({ minimum: 1 }), catalogRevision: Type.Integer({ minimum: 0 }),
  digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
export const ComparisonInvestigationClosedSchema = Type.Object({
  schemaVersion: Type.Literal(1), attemptId: Type.String({ minLength: 1, maxLength: 128 }),
  sessionId: Type.String({ minLength: 1, maxLength: 128 }), reason: Type.Literal('bounded_investigation_timeout'),
  previous: discoveryBinding, current: discoveryBinding,
  questionIds: Type.Array(id, { maxItems: 16, uniqueItems: true }), semanticAssessment: Type.Literal('not_certified'),
}, { additionalProperties: false });
export type ComparisonInvestigationClosure = Pick<Static<typeof ComparisonInvestigationClosedSchema>, 'previous' | 'current' | 'questionIds'>;

export const ComparisonFindingsUpdatedSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Type.String({ minLength: 1, maxLength: 128 }),
  revision: Type.Integer({ minimum: 1 }),
  catalogRevision: Type.Integer({ minimum: 0 }),
  digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  artifactId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const ComparisonDraftAcceptedSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Type.String({ minLength: 1, maxLength: 128 }),
  draftDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  catalogRevision: Type.Integer({ minimum: 0 }),
  findingsRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type ComparisonDraftBinding = Omit<Static<typeof ComparisonDraftAcceptedSchema>, 'schemaVersion' | 'attemptId'>;
