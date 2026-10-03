import { finishExperimentActivity } from "./experiment-activity.js";

/** Store surface the compare command needs in order to drop writer.lock. */
export type CompareCommandStore = {
  close(): Promise<void>;
  releaseWriterLock(): Promise<void>;
};

/**
 * Runs after compare has produced a result, including preview_failed.
 * store.close() must not be able to skip the lock, and the control listener
 * must be gone before the caller prints JSON and returns.
 */
export async function releaseCompareCommand(input: {
  store: CompareCommandStore;
  experimentId: string;
}): Promise<void> {
  try {
    await input.store.close();
  } catch {
    // The failure JSON is already durable. A close error must not keep the lock.
  } finally {
    await input.store.releaseWriterLock();
    await finishExperimentActivity(input.experimentId);
  }
}
