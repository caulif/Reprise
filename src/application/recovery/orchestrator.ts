import { Value } from "@sinclair/typebox/value";
import {
  RecoveryLifecycleAttemptSchema,
  type RecoveryLifecycleAttempt,
} from "../../core/schema.js";

export type RecoveryLifecycleState =
  | "created"
  | "staged"
  | "forensics"
  | "model"
  | "validated"
  | "accepted"
  | "failed";

const transitions: Record<RecoveryLifecycleState, readonly RecoveryLifecycleState[]> = {
  created: ["staged", "failed"],
  staged: ["forensics", "failed"],
  forensics: ["model", "failed"],
  model: ["validated", "failed"],
  validated: ["accepted", "failed"],
  accepted: [],
  failed: [],
};

export type RecoveryOrchestratorOptions = {
  onAttempt?: (attempt: RecoveryLifecycleAttempt) => Promise<void> | void;
};

/**
 * Owns Recovery lifecycle state and its auditable operation log.
 * Domain runners stay in their existing modules; this port is the sole state owner.
 */
export class RecoveryOrchestrator {
  private currentState: RecoveryLifecycleState = "created";
  private readonly recordedAttempts: RecoveryLifecycleAttempt[] = [];
  private readonly onAttempt?: RecoveryOrchestratorOptions["onAttempt"];

  public constructor(options: RecoveryOrchestratorOptions = {}) {
    this.onAttempt = options.onAttempt;
  }

  public get state(): RecoveryLifecycleState {
    return this.currentState;
  }

  public get attempts(): readonly RecoveryLifecycleAttempt[] {
    return this.recordedAttempts;
  }

  public transition(next: RecoveryLifecycleState): void {
    this.currentState = transitionRecoveryState(this.currentState, next);
  }

  public async recordAttempt(
    input: RecoveryLifecycleAttempt | Omit<RecoveryLifecycleAttempt, "schemaVersion">,
  ): Promise<void> {
    const record = "schemaVersion" in input ? input : recoveryAttemptRecord(input);
    if (!Value.Check(RecoveryLifecycleAttemptSchema, record)) {
      throw new Error("Recovery lifecycle attempt is invalid.");
    }
    this.recordedAttempts.push(record);
    await this.onAttempt?.(record);
  }

  /** Moves an unfinished run to the only meaningful terminal outcome. */
  public fail(): void {
    if (this.currentState === "accepted" || this.currentState === "failed") return;
    this.transition("failed");
  }
}

export function transitionRecoveryState(
  current: RecoveryLifecycleState,
  next: RecoveryLifecycleState,
): RecoveryLifecycleState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid Recovery lifecycle transition: ${current} -> ${next}.`);
  }
  return next;
}

export function recoveryAttemptRecord(
  input: Omit<RecoveryLifecycleAttempt, "schemaVersion">,
): RecoveryLifecycleAttempt {
  const record = { schemaVersion: 2 as const, ...input };
  if (!Value.Check(RecoveryLifecycleAttemptSchema, record)) {
    throw new Error("Recovery lifecycle attempt is invalid.");
  }
  return record;
}
