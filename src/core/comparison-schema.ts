import { Type, type Static } from "@sinclair/typebox";
const EvidenceRefSchema = Type.String({ pattern: "^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const ComparisonMediaRefSchema = Type.String({ pattern: "^media:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
export type ComparisonMediaRef = Static<typeof ComparisonMediaRefSchema>;

const MetricSideSchema = Type.Object({
  elapsedMs: Type.Optional(Type.Number()),
  tokens: Type.Optional(Type.Object({
    total: Type.Number(),
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    cached: Type.Optional(Type.Number()),
    reasoning: Type.Optional(Type.Number()),
  })),
  costUsd: Type.Optional(Type.Number()),
  usageStatus: Type.Optional(Type.Union([
    Type.Literal("collected"),
    Type.Literal("not_collected"),
    Type.Literal("unknown"),
  ])),
  pricingStatus: Type.Optional(Type.Union([
    Type.Literal("collected"),
    Type.Literal("not_collected"),
    Type.Literal("pricing_unavailable"),
    Type.Literal("unknown"),
  ])),
  pricingVersion: Type.Optional(Type.String()),
  collectedAt: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  pricingModelId: Type.Optional(Type.String()),
  pricingSource: Type.Optional(Type.String()),
  pricingRates: Type.Optional(Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheCreation: Type.Number(),
  })),
  toolCostsIncluded: Type.Optional(Type.Boolean()),
});

const ComparisonReportFactsSchema = Type.Object({
  run: Type.Object({ runId: Type.String(), outcome: Type.String(), terminationCode: Type.String(), initiatedBy: Type.String(), elapsedMs: Type.Optional(Type.Number()), candidateElapsedMs: Type.Optional(Type.Number()) }),
  models: Type.Object({ candidate: Type.String(), baseline: Type.Optional(Type.String()), controller: Type.Optional(Type.String()), comparison: Type.Optional(Type.String()) }),
  activity: Type.Object({ candidateTurns: Type.Optional(Type.Integer({ minimum: 0 })), controllerCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Object({ total: Type.Integer({ minimum: 0 }), succeeded: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }), rejectedApprovals: Type.Integer({ minimum: 0 }) })) }),
  limits: Type.Object({ wallClockMs: Type.Optional(Type.Number()), maxTargetTurns: Type.Optional(Type.Integer({ minimum: 0 })), maxModelCalls: Type.Optional(Type.Integer({ minimum: 0 })), triggered: Type.Array(Type.String()) }),
  runtime: Type.Object({ productId: Type.String(), sandbox: Type.Optional(Type.String()), approvalPolicy: Type.Optional(Type.String()), network: Type.Optional(Type.String()) }),
  delivery: Type.Object({ changedPaths: Type.Array(Type.String()), targetArtifactStatus: Type.String(), verificationStatus: Type.String(), changedPathsIndexed: Type.Optional(Type.Integer({ minimum: 0 })), changedPathsOmitted: Type.Optional(Type.Integer({ minimum: 0 })) }),
  replay: Type.Object({ sourceRootKind: Type.Optional(Type.String()), conditions: Type.Array(Type.String()), baselineEvidence: Type.String(), candidateEvidence: Type.String() }),
  metrics: Type.Optional(Type.Object({
    baseline: Type.Optional(MetricSideSchema),
    candidate: Type.Optional(MetricSideSchema),
  })),
});
export const ComparisonMediaShortRefSchema = Type.String({ pattern: "^media-[0-9]{2,6}$" });
export const ComparisonMediaDerivationSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("original"),
    Type.Literal("headless_screenshot"),
    Type.Literal("render_preview"),
    Type.Literal("host_review"),
  ]),
  rendererVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  viewport: Type.Optional(Type.Object({
    width: Type.Integer({ minimum: 1, maximum: 8192 }),
    height: Type.Integer({ minimum: 1, maximum: 8192 }),
    scale: Type.Number({ exclusiveMinimum: 0, maximum: 4 }),
  })),
  sampleTimesMs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 60_000 }), { maxItems: 16 })),
  capturedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  sourceHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  finalUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  urlStateOmitted: Type.Optional(Type.Boolean()),
  errorsOmitted: Type.Optional(Type.Integer({ minimum: 0 })),
  actions: Type.Optional(Type.Array(Type.Object({
    action: Type.Union([Type.Literal("click"), Type.Literal("fill")]),
    selector: Type.String({ minLength: 1, maxLength: 512 }),
    elapsedMs: Type.Integer({ minimum: 0 }),
  }), { maxItems: 256 })),
});
export type ComparisonMediaDerivation = Static<typeof ComparisonMediaDerivationSchema>;
export const ComparisonMediaRecordSchema = Type.Object({
  ref: ComparisonMediaRefSchema,
  shortRef: Type.Optional(ComparisonMediaShortRefSchema),
  label: Type.Optional(Type.String({ minLength: 1 })),
  side: Type.Union([
    Type.Literal("baseline"),
    Type.Literal("candidate"),
    Type.Literal("host"),
    Type.Literal("derived"),
  ]),
  inspectPath: Type.String({ minLength: 1 }),
  reportHref: Type.String({ minLength: 1 }),
  mediaType: Type.String({ minLength: 1 }),
  available: Type.Boolean(),
  byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
  sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  derivation: Type.Optional(ComparisonMediaDerivationSchema),
});
export type ComparisonMediaRecord = Static<typeof ComparisonMediaRecordSchema>;
export const ComparisonReportModelSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  formatVersion: Type.Literal(2),
  headline: Type.Optional(Type.String({ minLength: 1, maxLength: 280 })),
  task: Type.String(),
  status: Type.Object({
    baseline: Type.String(),
    candidate: Type.String(),
    candidateOutcome: Type.String(),
    terminationCode: Type.String(),
  }),
  metrics: Type.Optional(Type.Object({
    baseline: Type.Optional(MetricSideSchema),
    candidate: Type.Optional(MetricSideSchema),
  })),
  slots: Type.Object({
    header: Type.Optional(Type.String()),
    comparison: Type.Optional(Type.String()),
    details: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    process: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  evidenceRefs: Type.Array(EvidenceRefSchema),
  mediaRefs: Type.Array(ComparisonMediaRefSchema),
  limitationCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });
export type ComparisonReportModel = Static<typeof ComparisonReportModelSchema>;
export const ComparisonReportContentSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  headline: Type.String({ minLength: 1, maxLength: 280 }),
  criticalLimitations: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
  evidenceRefs: Type.Array(Type.String({ pattern: "^ev-[0-9]{2,6}$" }), { maxItems: 128 }),
}, { additionalProperties: false });
export type ComparisonReportContent = Static<typeof ComparisonReportContentSchema>;
export const ComparisonPreviewReceiptSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  contentDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  validationDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  preparedDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  evidenceRevision: Type.Integer({ minimum: 0 }),
  contractValid: Type.Boolean(),
  publishable: Type.Boolean(),
  reviewMode: Type.Union([Type.Literal("visual"), Type.Literal("mechanical")]),
  reviewRefs: Type.Array(Type.String()),
}, { additionalProperties: false });
export type ComparisonPreviewReceipt = Static<typeof ComparisonPreviewReceiptSchema>;
export const ComparisonBriefingContextSchema = Type.Object({
  task: Type.Object({ caseId: Type.String(), summary: Type.String() }), baseline: Type.Object({ summary: Type.String(), evidenceRefs: Type.Array(Type.String()) }),
  candidates: Type.Array(Type.Object({ runId: Type.String(), evidenceRefs: Type.Array(Type.String()) })), telemetry: Type.Array(Type.Object({ runId: Type.String() })), reportFacts: ComparisonReportFactsSchema,
  artifactRefs: Type.Array(Type.String()), allowModelText: Type.Boolean(), replayScope: Type.Object({ historical: Type.String(), candidate: Type.String() }), hostReplay: Type.Optional(Type.Object({ sourceRootKind: Type.String(), stopKind: Type.String(), conditions: Type.Array(Type.String()) })), promptContent: Type.Optional(Type.String()),
  media: Type.Optional(Type.Array(ComparisonMediaRecordSchema)),
});
export const ComparisonShortRefSchema = Type.String({ pattern: "^ev-[0-9]{2,6}$" });
const ComparisonOutputSchema = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("insufficient_evidence")]),
  reportPath: Type.Literal("report.html"),
  evidenceRefs: Type.Array(ComparisonShortRefSchema),
  limitationCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  headline: Type.Optional(Type.String({ minLength: 1, maxLength: 280 })),
});
const AgentFailureSchema = Type.Object({
  kind: Type.Optional(Type.Union([
    Type.Literal("authentication"), Type.Literal("rate_limited"), Type.Literal("transient_network"),
    Type.Literal("transient_upstream"), Type.Literal("tool"), Type.Literal("timeout"),
    Type.Literal("protocol"), Type.Literal("cancelled"), Type.Literal("unknown"),
  ])),
  code: Type.Union([
    Type.Literal("agent_timeout"), Type.Literal("agent_failure"), Type.Literal("invalid_output"),
    Type.Literal("privacy_blocked"), Type.Literal("host_zone_modified"), Type.Literal("invalid_envelope"),
    Type.Literal("evidence_unresolved"), Type.Literal("media_unavailable"), Type.Literal("report_incomplete"),
    Type.Literal("publication_failed"),
  ]),
  message: Type.String(),
  attempts: Type.Integer({ minimum: 0 }),
});
export const ComparisonInvocationSchema = Type.Union([Type.Object({ status: Type.Literal("completed"), value: ComparisonOutputSchema, sessionId: Type.String({ minLength: 1 }) }), Type.Object({ status: Type.Literal("failed"), failure: AgentFailureSchema, sessionId: Type.Optional(Type.String({ minLength: 1 })) }), Type.Object({ status: Type.Literal("cancelled"), factRef: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String({ minLength: 1 })) })]);
