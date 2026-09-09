/**
 * Host mechanical checks for Recovery. Business verdicts (ready/blocked) stay with the Agent.
 */
export type RecoveryMechanicalCheck = {
  status: "ok" | "failed";
  reasonCodes: readonly (
    | "unsafe_path"
    | "source_tripwire"
    | "missing_report"
    | "invalid_envelope"
  )[];
};

export function mechanicalRecoveryFailure(reason: RecoveryMechanicalCheck["reasonCodes"][number]): RecoveryMechanicalCheck {
  return { status: "failed", reasonCodes: [reason] };
}
