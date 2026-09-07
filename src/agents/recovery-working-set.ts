import type { RecoveryContext } from "./recovery-agent.js";

const WORKING_SET_INITIAL_INPUT_CHARS = 8_000;
const WORKING_SET_EVIDENCE_REFS = 16;
const WORKING_SET_GIT_PATHS = 32;

/** Model-visible Recovery JSON. Host validation still uses the full context object. */
export function recoveryWorkingSet(context: RecoveryContext): Record<string, unknown> {
  const initial = context.task.initialInput;
  const text = initial.text;
  const truncated = text.length > WORKING_SET_INITIAL_INPUT_CHARS;
  const refs = context.resolved.evidenceRefs;
  const git = context.resolved.git;
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
    attemptMode: context.attemptMode,
    session: context.session,
    clues: context.clues,
    investigationPacket: context.investigationPacket,
    investigation: context.investigation,
    executionCandidate: context.executionCandidate,
    recoveryCandidates: context.recoveryCandidates,
    runtimeCapabilities: context.runtimeCapabilities,
    staging: context.staging,
    budget: context.budget,
    allowModelText: context.allowModelText,
    readiness: context.readiness,
    readinessFeedback: context.readinessFeedback,
    playbook: {
      productId: context.playbook.productId,
      version: context.playbook.version,
      sha256: context.playbook.sha256,
    },
    observations: { root: "observations", index: "observations/INDEX.md" },
    resolved: {
      git: git
        ? {
            isRepo: git.isRepo,
            headState: git.headState,
            ...(git.head ? { head: git.head } : {}),
            ...(git.historicalCommitPresent === undefined ? {} : { historicalCommitPresent: git.historicalCommitPresent }),
            dirtyPathCount: git.dirtyPaths.length,
            untrackedPathCount: git.untrackedPaths.length,
            dirtyPaths: git.dirtyPaths.slice(0, WORKING_SET_GIT_PATHS),
            untrackedPaths: git.untrackedPaths.slice(0, WORKING_SET_GIT_PATHS),
            ...(git.statusAvailable === undefined ? {} : { statusAvailable: git.statusAvailable }),
          }
        : undefined,
      patchCount: context.resolved.patches.length,
      preimageCount: context.resolved.preimages.length,
      catalogCount: context.resolved.catalog?.length ?? 0,
      evidenceRefCount: refs.length,
      evidenceRefs: refs.slice(0, WORKING_SET_EVIDENCE_REFS),
      patches: context.resolved.patches.slice(0, WORKING_SET_GIT_PATHS),
      preimages: context.resolved.preimages.slice(0, WORKING_SET_GIT_PATHS),
    },
  };
}

export function recoveryModelPrompt(context: RecoveryContext): string {
  return JSON.stringify(recoveryWorkingSet(context));
}
