import type { RecoveryResult } from "../../agents/recovery-agent.js";
import type { EnvironmentBaseline, RecoveryPreview } from "../../environment/local-workspace-provider.js";
import type { StructuredAgentResult } from "../../infrastructure/agent/host.js";
import type { RecoveryReadinessResult } from "./readiness.js";
import type { RecoveryAttempt } from "./types.js";

/** TUI/CLI projection of Recovery. No workspace Provider or accept hook. */
export type RecoveryView = {
  readonly cleanupFailed?: boolean;
  readonly baseline: EnvironmentBaseline;
  readonly providerPreview?: RecoveryPreview;
  readonly staging?: { readonly recoveryId: string; readonly caseId: string; readonly sourceRoot: string; readonly root: string };
  readonly taskReadiness?: RecoveryReadinessResult;
  readonly acceptedAutomatically?: boolean;
  readonly recovery: StructuredAgentResult<RecoveryResult>;
  readonly experimentRoot: string;
  readonly experimentId: string;
  readonly hasAccept: boolean;
};

export function recoveryViewFromAttempt(attempt: RecoveryAttempt): RecoveryView {
  return {
    ...(attempt.cleanupFailed ? { cleanupFailed: true } : {}),
    baseline: attempt.baseline,
    ...(attempt.providerPreview ? { providerPreview: attempt.providerPreview } : {}),
    ...(attempt.staging
      ? {
          staging: {
            recoveryId: attempt.staging.recoveryId,
            caseId: attempt.staging.caseId,
            sourceRoot: attempt.staging.sourceRoot,
            root: attempt.staging.root,
          },
        }
      : {}),
    ...(attempt.taskReadiness ? { taskReadiness: attempt.taskReadiness } : {}),
    ...(attempt.acceptedAutomatically ? { acceptedAutomatically: true } : {}),
    recovery: attempt.recovery,
    experimentRoot: attempt.experimentRoot,
    experimentId: attempt.experimentId,
    hasAccept: attempt.accept !== undefined,
  };
}
