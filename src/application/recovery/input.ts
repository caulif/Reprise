import type { RecoveryAgentPort } from "../../agents/recovery-agent.js";
import type { EventEnvelope, TaskCase, RecoveryGitStart } from "../../core/schema.js";
import type { LocalWorkspaceProvider } from "../../environment/local-workspace-provider.js";
import type { ProductPack } from "../../products/contract.js";
import type { ExperimentActivity } from "../experiment-activity.js";
import type { HarnessConfigurationScope } from '../harness-configuration.js';

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
  /** Explicit task-before commit and complete additional-input allowlist; never inferred from history. */
  gitStart?: RecoveryGitStart;
  taskCase: TaskCase;
  recovery: RecoveryAgentPort;
  resolveRecovery?: (signal: AbortSignal, scope: HarnessConfigurationScope) => Promise<RecoveryAgentPort>;
  onActivity?: (activity: ExperimentActivity) => void;
  /** Defaults to safe maximum-effort investigation in isolated staging. */
  attemptMode?: RecoveryAttemptMode;
  /** Bounds retries after transient Recovery model failures; each attempt is independently audited. */
  maxModelAttempts?: number;
  /** Recovery 生产路径默认开启 shell；此字段保留给测试夹具覆盖。 */
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

