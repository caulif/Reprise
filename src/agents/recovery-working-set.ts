import type { RecoveryContext } from "./recovery-agent.js";

const WORKING_SET_INITIAL_INPUT_CHARS = 8_000;

/** Model-visible Recovery JSON. Host validation still uses the full context object. */
export function recoveryWorkingSet(context: RecoveryContext): Record<string, unknown> {
  const initial = context.task.initialInput;
  const text = initial.text;
  const truncated = text.length > WORKING_SET_INITIAL_INPUT_CHARS;
  return {
    schemaVersion: 1,
    task: {
      caseId: context.task.caseId,
      initialInput: {
        ...initial,
        text: truncated ? text.slice(0, WORKING_SET_INITIAL_INPUT_CHARS) : text,
        truncated,
      },
    },
    evidenceLevel: context.evidenceLevel,
    session: context.session,
    clues: context.clues,
    runtimeCapabilities: context.runtimeCapabilities,
    staging: context.staging,
    budget: context.budget,
    allowModelText: context.allowModelText,
    workRecords: ".reprise/recovery-work",
    reportPath: "recovery.md",
    playbook: {
      productId: context.playbook.productId,
      version: context.playbook.version,
      sha256: context.playbook.sha256,
    },
    observations: { root: "observations", index: "observations/INDEX.md" },
  };
}

export function recoveryModelPrompt(context: RecoveryContext): string {
  return JSON.stringify(recoveryWorkingSet(context));
}
