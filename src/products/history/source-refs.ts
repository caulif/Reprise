import { sha256 } from "../../core/identity.js";
import type { TaskCase } from "../../core/schema.js";

export type RecoveryEvidenceCatalogEntry = {
  ref: string;
  source: "transcript" | "historical_events";
  index: number;
  contentHash: string;
};

/** Creates deterministic Host-owned refs even when imported history rows have no product event id. */
export function recoveryEvidenceCatalog(taskCase: TaskCase): RecoveryEvidenceCatalogEntry[] {
  return [
    ...taskCase.transcript.map((value, index) => catalogEntry("transcript", index, value)),
    ...taskCase.historicalEvents.map((value, index) => catalogEntry("historical_events", index, value)),
  ];
}

function catalogEntry(
  source: RecoveryEvidenceCatalogEntry["source"],
  index: number,
  value: unknown,
): RecoveryEvidenceCatalogEntry {
  const contentHash = sha256(JSON.stringify(value));
  return {
    ref: `event:${source === "transcript" ? "transcript" : "history"}-${index}-${contentHash.slice(0, 16)}`,
    source,
    index,
    contentHash,
  };
}
