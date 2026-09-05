import { Type } from "@sinclair/typebox";
const EvidenceRefSchema = Type.String({ pattern: "^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });

const ComparisonReportFactsSchema = Type.Object({
  run: Type.Object({ runId: Type.String(), outcome: Type.String(), terminationCode: Type.String(), initiatedBy: Type.String(), elapsedMs: Type.Optional(Type.Number()), candidateElapsedMs: Type.Optional(Type.Number()) }),
  models: Type.Object({ candidate: Type.String(), controller: Type.Optional(Type.String()), comparison: Type.Optional(Type.String()) }),
  activity: Type.Object({ candidateTurns: Type.Optional(Type.Integer({ minimum: 0 })), controllerCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Object({ total: Type.Integer({ minimum: 0 }), succeeded: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }), rejectedApprovals: Type.Integer({ minimum: 0 }) })) }),
  limits: Type.Object({ wallClockMs: Type.Optional(Type.Number()), maxTargetTurns: Type.Optional(Type.Integer({ minimum: 0 })), maxModelCalls: Type.Optional(Type.Integer({ minimum: 0 })), triggered: Type.Array(Type.String()) }),
  runtime: Type.Object({ productId: Type.String(), sandbox: Type.Optional(Type.String()), approvalPolicy: Type.Optional(Type.String()), network: Type.Optional(Type.String()) }),
  delivery: Type.Object({ changedPaths: Type.Array(Type.String()), targetArtifactStatus: Type.String(), verificationStatus: Type.String() }),
  replay: Type.Object({ sourceRootKind: Type.Optional(Type.String()), conditions: Type.Array(Type.String()), baselineEvidence: Type.String(), candidateEvidence: Type.String() }),
});
export const ComparisonBriefingContextSchema = Type.Object({
  task: Type.Object({ caseId: Type.String(), summary: Type.String() }), baseline: Type.Object({ summary: Type.String(), evidenceRefs: Type.Array(Type.String()) }),
  candidates: Type.Array(Type.Object({ runId: Type.String(), summary: Type.String(), evidenceRefs: Type.Array(Type.String()) })), telemetry: Type.Array(Type.Object({ runId: Type.String(), summary: Type.String() })), reportFacts: ComparisonReportFactsSchema,
  artifactRefs: Type.Array(Type.String()), allowModelText: Type.Boolean(), replayScope: Type.Object({ historical: Type.String(), candidate: Type.String() }), hostReplay: Type.Optional(Type.Object({ sourceRootKind: Type.String(), stopKind: Type.String(), conditions: Type.Array(Type.String()) })), promptContent: Type.Optional(Type.String()),
});
const AgentFailureSchema = Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("authentication"), Type.Literal("rate_limited"), Type.Literal("transient_network"), Type.Literal("transient_upstream"), Type.Literal("tool"), Type.Literal("timeout"), Type.Literal("protocol"), Type.Literal("cancelled"), Type.Literal("unknown")])), code: Type.Union([Type.Literal("agent_timeout"), Type.Literal("agent_failure"), Type.Literal("invalid_output"), Type.Literal("privacy_blocked")]), message: Type.String(), attempts: Type.Integer({ minimum: 0 }) });
const ComparisonOutputSchema = Type.Object({ status: Type.Union([Type.Literal("completed"), Type.Literal("insufficient_evidence")]), reportPath: Type.Literal("report.html"), evidenceRefs: Type.Array(EvidenceRefSchema), limitationCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), headline: Type.Optional(Type.String({ minLength: 1, maxLength: 280 })) });
export const ComparisonInvocationSchema = Type.Union([Type.Object({ status: Type.Literal("completed"), value: ComparisonOutputSchema, sessionId: Type.String({ minLength: 1 }) }), Type.Object({ status: Type.Literal("failed"), failure: AgentFailureSchema, sessionId: Type.Optional(Type.String({ minLength: 1 })) }), Type.Object({ status: Type.Literal("cancelled"), factRef: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String({ minLength: 1 })) })]);
