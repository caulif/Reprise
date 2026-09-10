import type { RecoveryResult } from "../../agents/recovery-agent.js";
import type {
  EnvironmentBaseline,
  LocalWorkspaceProvider,
  RecoveryPreview,
  RecoveryStaging,
} from "../../environment/local-workspace-provider.js";
import type { StructuredAgentResult } from "../../infrastructure/agent/host.js";
import type { RecoveryReadinessResult } from "./readiness.js";

export type { RecoveryAttemptInput, RecoveryAttemptMode } from "./input.js";

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
  readonly experimentRoot: string;
  readonly experimentId: string;
  readonly provider: LocalWorkspaceProvider;
  accept?(): Promise<EnvironmentBaseline>;
};
