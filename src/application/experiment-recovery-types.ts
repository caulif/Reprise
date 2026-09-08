import type { RecoveryAgentPort, RecoveryResult } from "../agents/recovery-agent.js";
import type {
  EventEnvelope,
  RecoveryCompensationRequest,
  RecoveryCompensationResult,
  RecoveryExternalEffect,
  RecoveryReviewFeedback,
  TaskCase,
} from "../core/schema.js";
import type {
  EnvironmentBaseline,
  LocalWorkspaceProvider,
  RecoveryPreview,
  RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import type { ProductPack } from "../products/contract.js";
import type { ExperimentActivity } from "./experiment-activity.js";
import type { RecoveryReadinessResult } from "./recovery-readiness.js";

export type RecoveryAttempt = {
  readonly cleanupFailed?: boolean;
  readonly baseline: EnvironmentBaseline;
  readonly providerPreview?: RecoveryPreview;
  readonly staging?: RecoveryStaging;
  /** Host-measured task continuation readiness; candidates are not user-facing success. */
  readonly taskReadiness?: RecoveryReadinessResult;
  /** True when Host promoted the ready staging baseline without operator selection. */
  readonly acceptedAutomatically?: boolean;
  readonly recovery: StructuredAgentResult<RecoveryResult>;
  /** Immutable candidate graph artifact for operator review before acceptance. */
  readonly candidateGraphArtifactId?: string;
  /** Host-owned review action; selecting an unexecuted branch never accepts it. */
  selectCandidate?(candidateId: string): Promise<void>;
  /** Re-executes a Host-selected alternate candidate before it can be accepted. */
  reexecuteCandidate?(candidateId?: string): Promise<void>;
  /** Records an explicit operator verdict as Host-owned evidence without accepting implicitly. */
  recordReviewFeedback?(input: {
    candidateId: string;
    decision: RecoveryReviewFeedback["decision"];
    evidenceRefs?: readonly string[];
  }): Promise<string>;
  /** Records an external effect without claiming that local recovery reversed it. */
  recordExternalEffect?(input: Omit<RecoveryExternalEffect, "schemaVersion" | "recordedAt">): Promise<string>;
  /** Creates an auditable compensation request; unobserved effects remain review-required. */
  requestCompensation?(
    input: Omit<RecoveryCompensationRequest, "schemaVersion" | "requestedAt">,
  ): Promise<RecoveryCompensationResult>;
  readonly experimentRoot: string;
  readonly experimentId: string;
  readonly provider: LocalWorkspaceProvider;
  accept?(): Promise<EnvironmentBaseline>;
};

export type RecoveryAttemptMode =
  | "maximum-effort-safe"
  | "maximum-effort-review"
  | "maximum-effort-aggressive";

export type RecoveryAttemptInput = {
  signal?: AbortSignal;
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  /** Optional Host-owned pre-mutation checkpoint captured before the task started. */
  checkpointRoot?: string;
  taskCase: TaskCase;
  recovery: RecoveryAgentPort;
  /** Defaults to safe maximum-effort investigation in isolated staging. */
  attemptMode?: RecoveryAttemptMode;
  /** Bounds retries after transient Recovery model failures; each attempt is independently audited. */
  maxModelAttempts?: number;
  /** Explicit Host capability for legacy shell-based diagnostics; disabled by default. */
  allowShell?: boolean;
  /** Explicit opt-in for replaying allowlisted historical commands inside recovery staging. */
  executeReadinessCommands?: boolean;
  /** Explicitly allow exploratory replay from the current workspace when history is insufficient. */
  allowCurrentStateFallback?: boolean;
  environmentProvider?: LocalWorkspaceProvider;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  pack?: ProductPack;
  activity?: ExperimentActivity;
};
