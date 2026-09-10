import { record, text } from "../core/json.js";
import type { CandidateRunState, EventEnvelope } from "../core/schema.js";

export type CandidateRunPhase = "recovery" | "candidate_starting" | "candidate_generating" | "candidate_reconnecting";

export type CandidateRunDisplay = {
  livePhase?: CandidateRunPhase;
  machineState?: CandidateRunState;
  failed: boolean;
  cleanupStatus?: string;
};

const MACHINE_STATES = new Set<CandidateRunState>([
  "created",
  "preparing",
  "launching",
  "awaiting_target",
  "awaiting_controller",
  "finalizing",
  "finished",
]);

export function isCandidateRunState(value: string | undefined): value is CandidateRunState {
  return value !== undefined && MACHINE_STATES.has(value as CandidateRunState);
}

/** Live activity phase is a query over persisted events. UI must not derive a second state machine. */
export function candidateRunPhaseFromEvent(event: EventEnvelope): CandidateRunPhase | undefined {
  const type = event.type;
  if (type.startsWith("recovery.")) return "recovery";
  if (type.startsWith("agent.") && text(record(event.payload).role) === "recovery") return "recovery";
  if (type === "run.attempt_created" || type === "runtime.session_started") return "candidate_starting";
  if (type === "runtime.delivery_observed" || (type === "run.state_changed" && record(event.payload).to === "awaiting_target")) {
    return "candidate_generating";
  }
  if (
    type === "runtime.turn_started"
    || type === "runtime.tool_started"
    || type === "runtime.tool_finished"
    || type === "runtime.visible_output"
    || type === "runtime.visible_prompt"
  ) return "candidate_generating";
  if (type === "runtime.runtime_failed") {
    const attempt = /Reconnecting\s+(\d+)\s*\/\s*(\d+)/i.exec(text(record(event.payload).message) ?? "");
    if (attempt) return "candidate_reconnecting";
  }
  return undefined;
}

/**
 * Read-only display status for TUI/CLI.
 * Live activity uses `livePhase`. Machine/final states come from `run.state_changed` and `run.outcome_created`, not timeline titles.
 */
export function candidateRunDisplayFromEvents(events: readonly EventEnvelope[]): CandidateRunDisplay {
  let livePhase: CandidateRunPhase | undefined;
  let machineState: CandidateRunState | undefined;
  let failed = false;
  let cleanupStatus: string | undefined;
  for (const event of events) {
    const phase = candidateRunPhaseFromEvent(event);
    if (phase) livePhase = phase;
    if (event.type === "run.state_changed") {
      const to = text(record(event.payload).to);
      if (isCandidateRunState(to)) machineState = to;
    }
    if (event.type === "run.outcome_created") {
      const payload = record(event.payload);
      failed = text(record(payload.termination).kind) === "failed";
      cleanupStatus = text(record(payload.cleanup).status);
    }
  }
  return {
    failed,
    ...(livePhase ? { livePhase } : {}),
    ...(machineState ? { machineState } : {}),
    ...(cleanupStatus ? { cleanupStatus } : {}),
  };
}
