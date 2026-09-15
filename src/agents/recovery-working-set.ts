import type { RecoveryContext } from "./recovery-agent.js";

const WORKING_SET_INITIAL_INPUT_CHARS = 8_000;
const WORKING_SET_EVIDENCE_REFS = 8;
const RECOVERY_INITIAL_INPUT_OBSERVATION = "observations/task/initial-input.txt";
const RECOVERY_PLAYBOOK_OBSERVATION = "observations/playbook.md";
const RECOVERY_CATALOG_INDEX = "observations/INDEX.tsv";
const SOURCE_SUMMARY_PATH = ".reprise/recovery-work/source-summary.json";

/** Host digest of Recovery facts. The model sees `recoveryModelPrompt`, not this object. */
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

function clue(value: string | undefined): string {
  return value && value.length > 0 ? value : "unknown";
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) return "unknown";
  return value ? "yes" : "no";
}

function count(value: number | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

/** Model-visible Recovery briefing. Host validation still uses the full context object. */
export function recoveryModelPrompt(context: RecoveryContext): string {
  const text = context.task.initialInput.text;
  const truncated = text.length > WORKING_SET_INITIAL_INPUT_CHARS;
  const taskText = truncated ? text.slice(0, WORKING_SET_INITIAL_INPUT_CHARS) : text;
  const evidenceLevel = context.evidenceLevel ?? "transcript";
  const seed = context.staging.seed ?? "unknown";
  const source = context.staging.source;
  const caps = context.runtimeCapabilities;
  const evidence = context.evidence;
  const sampleRefs = (evidence?.evidenceRefs ?? []).slice(0, WORKING_SET_EVIDENCE_REFS);
  const lines = [
    "# Recovery briefing",
    `Task: ${taskText}`,
    ...(truncated ? ["(truncated; full text at observations/task/initial-input.txt)"] : []),
    `Evidence level: ${evidenceLevel}; ${context.session.transcriptLength} historical messages, ${context.session.historicalEventCount} historical events`,
    `Clues: cwd=${clue(context.clues.cwd)}; historicalCommit=${clue(context.clues.historicalCommit)}; sourceVersion=${clue(context.clues.sourceVersion)}`,
    `Work copy seed: ${seed}; currently ${context.staging.fileCount} files, ${context.staging.totalBytes} bytes`,
    `Source directory: ${count(source?.fileCount)} files, ${count(source?.totalBytes)} bytes; whole-tree copy eligible=${yesNo(source?.copyEligible)}; copy budget exceeded=${yesNo(source?.budgetExceeded)}; summary and excluded entries at ${context.staging.summaryPath ?? SOURCE_SUMMARY_PATH}`,
    `Runtime capabilities: session history=${caps?.sessionHistory ?? "unknown"}; local artifacts=${yesNo(caps?.localArtifacts)}; workspace history=${yesNo(caps?.workspaceHistory)}; external side effects=${caps?.externalSideEffects ?? "unknown"}`,
    `Playbook: ${context.playbook.productId} ${context.playbook.version}, text at ${RECOVERY_PLAYBOOK_OBSERVATION}`,
    `Evidence catalog: ${evidence?.catalogCount ?? 0} entries, ${evidence?.verifiedCount ?? 0} verified; index at ${RECOVERY_CATALOG_INDEX}; sample refs: ${sampleRefs.join(", ")}`,
    "Report: recovery.md at the work copy root",
  ];
  return lines.join("\n");
}
