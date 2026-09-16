import type { RunPolicy } from "../core/schema.js";

/** Last-resort safety valve. Completion is a Controller decision, not these numbers. */
export const DEFAULT_RUN_POLICY: RunPolicy = {
  wallClockMs: 24 * 60 * 60_000,
  maxTargetTurns: 256,
  maxModelCalls: 256,
  turnTimeoutMs: 2 * 60 * 60_000,
  maxConsecutiveNoProgress: 2,
};

export const TUI_RUN_POLICY = DEFAULT_RUN_POLICY;
