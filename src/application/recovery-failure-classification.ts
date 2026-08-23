export type RecoveryEvaluationFailureCode =
  | "preflight_failed"
  | "model_request_failed"
  | "agent_protocol_failed"
  | "tool_failed"
  | "verifier_rejected"
  | "source_tripwire_failed"
  | "source_unavailable"
  | "runner_crashed"
  | "cancelled";

/** Maps only known runner stages; an unrecognized stage is an infrastructure crash. */
export function recoveryEvaluationFailureCode(stage: string): RecoveryEvaluationFailureCode {
  switch (stage) {
    case "source_tripwire_failed": return "source_tripwire_failed";
    case "source_unavailable":
    case "selection_source_changed": return "source_unavailable";
    case "preflight_failed":
    case "source_snapshot_budget_exceeded": return "preflight_failed";
    case "verifier_rejected":
    case "provider_validation_failed": return "verifier_rejected";
    case "tool_failed":
    case "agent_tool_failed": return "tool_failed";
    case "model_request_failed":
    case "agent_model_failed":
    case "agent_timeout": return "model_request_failed";
    case "agent_protocol_failed":
    case "agent_invalid_output": return "agent_protocol_failed";
    case "cancelled": return "cancelled";
    default: return "runner_crashed";
  }
}
