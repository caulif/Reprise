import type { SessionSummary } from "../contract.js";

/** Orders discovery and UI summaries by known latest activity, then source path. */
export function compareSessionSummaries(left: SessionSummary, right: SessionSummary): number {
  const leftTime = knownSessionTime(left);
  const rightTime = knownSessionTime(right);
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return rightTime - leftTime;
  if (leftTime !== undefined && rightTime === undefined) return -1;
  if (leftTime === undefined && rightTime !== undefined) return 1;
  return left.sourcePath.localeCompare(right.sourcePath);
}

function knownSessionTime(session: SessionSummary): number | undefined {
  const value = session.updatedAt ?? session.startedAt;
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
