import type { RecoveryAgentPort } from "../../agents/recovery-agent.js";
import type { EventEnvelope, TaskCase } from "../../core/schema.js";
import type { LocalWorkspaceProvider } from "../../environment/local-workspace-provider.js";
import type { ProductPack } from "../../products/contract.js";
import type { ExperimentActivity } from "../experiment-activity.js";

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
