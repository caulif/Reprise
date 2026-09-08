import { join } from "node:path";
import { isMissing } from "./experiment-helpers.js";
import { readCommittedModelLog } from "../infrastructure/agent-history-read.js";

export type CommittedExperimentHistory = {
  readonly runStatus: "finished" | "interrupted" | "unknown";
  readonly diagnosticCode?: string;
  readonly incompleteModelInput: boolean;
  readonly legacyRequestComplete: boolean;
};

/** Read-only committed facts for History. Does not acquire writer lock, start a candidate, or load a Product Pack. */
export async function readCommittedExperimentHistory(experimentRoot: string): Promise<CommittedExperimentHistory> {
  try {
    const log = await readCommittedModelLog(join(experimentRoot, "events.jsonl"));
    return {
      runStatus: log.runStatus,
      ...(log.diagnostic ? { diagnosticCode: log.diagnostic.code } : {}),
      incompleteModelInput: log.requests.some((request) => request.contentComplete === false),
      legacyRequestComplete: log.requests.some((request) => request.legacyRequestComplete === true),
    };
  } catch (error) {
    if (isMissing(error)) return { runStatus: "unknown", incompleteModelInput: false, legacyRequestComplete: false };
    throw error;
  }
}
