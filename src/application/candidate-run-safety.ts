import { sha256 } from "../core/identity.js";
import { fingerprintTree } from "../environment/local-workspace-fs.js";
import type { EnvironmentFingerprint, FingerprintEntry } from "../environment/local-workspace-provider.js";

/** Runtime journal types that mechanically identify a Target model generation. Host-authored rows are not in this list. */
export const TARGET_MODEL_CALL_EVENT_TYPES = ["runtime.turn_started", "runtime.usage_reported"] as const;
export type TargetModelCallEventType = (typeof TARGET_MODEL_CALL_EVENT_TYPES)[number];

const TURN_STARTED: TargetModelCallEventType = "runtime.turn_started";
const USAGE_REPORTED: TargetModelCallEventType = "runtime.usage_reported";

export type TargetModelCallCount = {
  readonly countable: boolean;
  readonly count: number;
  readonly countedType: TargetModelCallEventType | undefined;
};

export function countTargetModelCalls(events: readonly { type: string }[]): TargetModelCallCount {
  let started = 0;
  let usage = 0;
  for (const event of events) {
    if (event.type === TURN_STARTED) started += 1;
    else if (event.type === USAGE_REPORTED) usage += 1;
  }
  if (started > 0) return { countable: true, count: started, countedType: TURN_STARTED };
  if (usage > 0) return { countable: true, count: usage, countedType: USAGE_REPORTED };
  return { countable: false, count: 0, countedType: undefined };
}

export function shouldStopForTargetModelCalls(events: readonly { type: string }[], maxModelCalls: number): boolean {
  const counted = countTargetModelCalls(events);
  return counted.countable && counted.count >= maxModelCalls;
}

export function isExcludedProgressPath(relativePath: string): boolean {
  return relativePath === ".reprise" || relativePath.startsWith(".reprise/");
}

type ProgressEntry = {
  readonly path: string;
  readonly kind: FingerprintEntry["kind"];
  readonly contentHash?: string;
};

function progressEntriesFromResources(resources: readonly FingerprintEntry[]): ProgressEntry[] {
  return resources
    .filter((entry) => !isExcludedProgressPath(entry.path))
    .map((entry) => progressEntry(entry))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function progressDigestFromFingerprint(fingerprint: EnvironmentFingerprint): string {
  return sha256(JSON.stringify(progressEntriesFromResources(fingerprint.resources)));
}

/** Isolated-workspace content fingerprint: relative POSIX path + file hashes, excluding `.reprise/`. */
export async function workspaceProgressFingerprint(root: string): Promise<string> {
  const { fingerprint } = await fingerprintTree(root);
  return progressDigestFromFingerprint(fingerprint);
}

/**
 * First settlement records the baseline (streak 0). Each later identical digest increments.
 * A change resets to 0. Stop when streak >= maxConsecutiveNoProgress.
 */
export function nextNoProgressStreak(previousDigest: string | undefined, currentDigest: string, previousStreak: number): number {
  if (previousDigest === undefined) return 0;
  return previousDigest === currentDigest ? previousStreak + 1 : 0;
}

function progressEntry(entry: FingerprintEntry): ProgressEntry {
  if (entry.kind === "file") {
    return { path: entry.path, kind: "file", contentHash: entry.contentHash ?? "" };
  }
  return { path: entry.path, kind: "directory" };
}
