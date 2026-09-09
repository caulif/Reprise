import { Type, type Static } from "@sinclair/typebox";
import { EvidenceRefSchema, Hash, Id, JsonRecord, Timestamp } from "./ids.js";
import { ArtifactRefSchema, CandidateSpecSchema } from "./task-case.js";
import { CandidateSessionHandleSchema } from "./candidate.js";

const AgentBudgetSchema = Type.Object({
  callTimeoutMs: Type.Integer({ minimum: 1 }),
  maxStructuredRepairAttempts: Type.Integer({ minimum: 0 }),
  maxCalls: Type.Optional(Type.Integer({ minimum: 1 })),
});
const AgentConfigSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  requestedModel: Type.String({ minLength: 1 }),
  options: Type.Optional(JsonRecord),
  budget: AgentBudgetSchema,
  contextPolicy: Type.Optional(JsonRecord),
});
const RunPolicySchema = Type.Object({
  wallClockMs: Type.Integer({ minimum: 1 }),
  maxTargetTurns: Type.Integer({ minimum: 1 }),
  maxModelCalls: Type.Integer({ minimum: 1 }),
  turnTimeoutMs: Type.Integer({ minimum: 1 }),
  maxConsecutiveNoProgress: Type.Integer({ minimum: 1 }),
});
export const ExperimentSpecSchema = Type.Object({
  experimentId: Id,
  taskCaseId: Id,
  candidates: Type.Array(CandidateSpecSchema, { minItems: 1 }),
  controller: AgentConfigSchema,
  comparison: AgentConfigSchema,
  runPolicy: RunPolicySchema,
  outputRoot: Type.String({ minLength: 1 }),
});
export type ExperimentSpec = Static<typeof ExperimentSpecSchema>;
export type AgentBudget = Static<typeof AgentBudgetSchema>;
export type AgentConfig = Static<typeof AgentConfigSchema>;
export type RunPolicy = Static<typeof RunPolicySchema>;
export const RunAttemptSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  runId: Id,
  experimentId: Id,
  caseId: Id,
  candidate: CandidateSpecSchema,
  policy: RunPolicySchema,
  createdAt: Timestamp,
});
export type RunAttempt = Static<typeof RunAttemptSchema>;
const ResolvedAgentConfigSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  requestedModel: Type.String({ minLength: 1 }),
  budget: AgentBudgetSchema,
});
export const RunManifestSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  attempt: RunAttemptSchema,
  resolvedModel: Type.Object({
    requested: Type.String({ minLength: 1 }),
    resolved: Type.Union([
      Type.String({ minLength: 1 }),
      Type.Literal("unknown"),
    ]),
  }),
  runtime: Type.Object({
    productId: Id,
    executable: Type.String({ minLength: 1 }),
    version: Type.Optional(Type.String()),
    configHash: Type.Optional(Hash),
  }),
  environment: Type.Object({
    environmentId: Id,
    workspacePath: Type.String({ minLength: 1 }),
  }),
  controller: ResolvedAgentConfigSchema,
  comparison: ResolvedAgentConfigSchema,
  startedAt: Timestamp,
});
export type RunManifest = Static<typeof RunManifestSchema>;
const RunOutcomeSchema = Type.Object({
  task: Type.Object({
    status: Type.Union([
      Type.Literal("apparently_completed"),
      Type.Literal("incomplete"),
      Type.Literal("indeterminate"),
      Type.Literal("not_assessed"),
    ]),
    decidedBy: Type.Optional(Type.Literal("controller")),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
  termination: Type.Object({
    kind: Type.Union([
      Type.Literal("completed"),
      Type.Literal("limit_reached"),
      Type.Literal("stalled"),
      Type.Literal("cancelled"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
      Type.Literal("uncertain"),
    ]),
    code: Type.String({ minLength: 1 }),
    initiatedBy: Type.Union([
      Type.Literal("target"),
      Type.Literal("controller"),
      Type.Literal("user"),
      Type.Literal("harness"),
    ]),
    failure: Type.Optional(
      Type.Object({
        origin: Type.Union([
          Type.Literal("runtime"),
          Type.Literal("controller"),
          Type.Literal("environment"),
          Type.Literal("harness"),
          Type.Literal("external_dependency"),
          Type.Literal("unknown"),
        ]),
        code: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        evidenceRefs: Type.Array(EvidenceRefSchema),
      }),
    ),
  }),
  cleanup: Type.Object({
    status: Type.Union([
      Type.Literal("not_needed"),
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("unknown"),
    ]),
    remainingResourceIds: Type.Array(Id),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
});
export type RunOutcome = Static<typeof RunOutcomeSchema>;
const CandidateRunStateSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("preparing"),
  Type.Literal("launching"),
  Type.Literal("awaiting_target"),
  Type.Literal("awaiting_controller"),
  Type.Literal("finalizing"),
  Type.Literal("finished"),
]);
export type CandidateRunState = Static<typeof CandidateRunStateSchema>;
export const RunRecordSchema = Type.Object({
  attempt: RunAttemptSchema,
  manifest: Type.Optional(RunManifestSchema),
  state: Type.Literal("finished"),
  stageReached: Type.Union([
    Type.Literal("created"),
    Type.Literal("preparing"),
    Type.Literal("launching"),
    Type.Literal("awaiting_target"),
    Type.Literal("awaiting_controller"),
  ]),
  outcome: RunOutcomeSchema,
  trace: Type.Object({
    experimentId: Id,
    runId: Id,
    firstSequence: Type.Integer({ minimum: 1 }),
      lastSequence: Type.Integer({ minimum: 1 }),
    }),
  session: Type.Optional(CandidateSessionHandleSchema),
  artifactRefs: Type.Array(ArtifactRefSchema),
  warnings: Type.Array(
    Type.Object({
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      evidenceRefs: Type.Array(EvidenceRefSchema),
    }),
  ),
});
export type RunRecord = Static<typeof RunRecordSchema>;
