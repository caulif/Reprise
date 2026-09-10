import type { RecoveryContext } from "./recovery-agent.js";

const WORKING_SET_INITIAL_INPUT_CHARS = 8_000;
const WORKING_SET_EVIDENCE_REFS = 8;
const RECOVERY_INITIAL_INPUT_OBSERVATION = "observations/task/initial-input.txt";
const RECOVERY_PLAYBOOK_OBSERVATION = "observations/playbook.md";
const RECOVERY_CATALOG_INDEX = "observations/INDEX.tsv";

/** Model-visible Recovery JSON. Host validation still uses the full context object. */
export function recoveryWorkingSet(context: RecoveryContext): Record<string, unknown> {
  const initial = context.task.initialInput;
  const text = initial.text;
  const truncated = text.length > WORKING_SET_INITIAL_INPUT_CHARS;
  const evidence = context.evidence;
  return {
    schemaVersion: 1,
    task: {
      caseId: context.task.caseId,
      initialInput: {
        ...initial,
        text: truncated ? text.slice(0, WORKING_SET_INITIAL_INPUT_CHARS) : text,
        truncated,
        fullTextPath: RECOVERY_INITIAL_INPUT_OBSERVATION,
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
      textPath: RECOVERY_PLAYBOOK_OBSERVATION,
    },
    observations: { root: "observations", index: "observations/INDEX.md" },
    ...(evidence
      ? {
          evidence: {
            catalogCount: evidence.catalogCount,
            verifiedCount: evidence.verifiedCount,
            catalogIndex: RECOVERY_CATALOG_INDEX,
            evidenceRefs: evidence.evidenceRefs.slice(0, WORKING_SET_EVIDENCE_REFS),
            verified: evidence.verified.slice(0, WORKING_SET_EVIDENCE_REFS),
          },
        }
      : {}),
  };
}

export function recoveryModelPrompt(context: RecoveryContext): string {
  return JSON.stringify(recoveryWorkingSet(context));
}
