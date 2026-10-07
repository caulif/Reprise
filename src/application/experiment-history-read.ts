import { basename, join } from "node:path";
import { experimentModelInputResolver, isMissing } from "./experiment-helpers.js";
import { readCommittedModelLog } from "../infrastructure/agent/history-read.js";
import { ExperimentStore } from '../infrastructure/store/experiment-store.js';

export type CommittedExperimentHistory = {
  readonly runStatus: "finished" | "interrupted" | "unknown";
  readonly diagnosticCode?: string;
  readonly incompleteModelInput: boolean;
  readonly legacyRequestComplete: boolean;
};

/** Read-only committed facts for History. Does not acquire writer lock, start a candidate, or load a Product Pack. */
export async function readCommittedExperimentHistory(experimentRoot: string, experimentId = basename(experimentRoot)): Promise<CommittedExperimentHistory> {
  try {
    const log = await readCommittedModelLog(join(experimentRoot, "events.jsonl"), {
      forEvents: (events) => {
        const store = ExperimentStore.committedReader(experimentRoot, experimentId, events);
        return Object.assign(experimentModelInputResolver(store), { forRun: (runId: string | undefined) => experimentModelInputResolver(store, runId) });
      },
    });
    return {
      runStatus: log.runStatus,
      ...(log.diagnostic ? { diagnosticCode: log.diagnostic.code } : {}),
      incompleteModelInput: log.requests.some((request) => request.contentComplete === false)
        || (log.compactionRequests?.some((request) => request.contentComplete === false) ?? false)
        || log.diagnostic?.code === 'missing_attachment' || log.diagnostic?.code === 'attachment_checksum',
      legacyRequestComplete: log.requests.some((request) => request.legacyRequestComplete === true),
    };
  } catch (error) {
    if (isMissing(error)) return { runStatus: "unknown", incompleteModelInput: false, legacyRequestComplete: false };
    throw error;
  }
}
