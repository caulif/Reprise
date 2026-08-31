import {
  isRelativePath,
  recoveryEvidenceCatalog,
  type ResolvedRecoveryFacts,
} from "../infrastructure/recovery-tools.js";
import type { TaskCase } from "../core/schema.js";

export const INVESTIGATION_PACKET_MAX_PATHS = 256;
const INVESTIGATION_PACKET_MAX_LATER_TURNS = 8;
const INVESTIGATION_PACKET_MAX_TURN_CHARS = 400;

export type RecoveryInvestigationPacket = {
  schemaVersion: 1;
  laterUserTurns: string[];
  candidatePaths: string[];
  preimagePaths: string[];
  patchPaths: string[];
  isRepo?: boolean;
  truncated: boolean;
};

/** Host-bounded history clues for Recovery; never the full transcript. */
export function buildRecoveryInvestigationPacket(
  taskCase: TaskCase,
  facts: Pick<ResolvedRecoveryFacts, "git" | "preimages" | "patches">,
): RecoveryInvestigationPacket {
  const laterUserTurns = laterTurns(taskCase);
  const catalogPaths: string[] = [];
  let pathTruncated = false;
  for (const entry of recoveryEvidenceCatalog(taskCase)) {
    const observation =
      entry.source === "transcript"
        ? taskCase.transcript[entry.index]
        : taskCase.historicalEvents[entry.index];
    for (const path of relativePathCluesFromValue(observation)) {
      if (catalogPaths.length >= INVESTIGATION_PACKET_MAX_PATHS) {
        pathTruncated = true;
        break;
      }
      catalogPaths.push(path);
    }
    if (pathTruncated) break;
  }
  const relevant =
    Array.isArray(taskCase.taskContext?.relevantPaths)
      ? taskCase.taskContext.relevantPaths.filter((item): item is string => typeof item === "string")
      : [];
  const candidatePaths = uniqueLimited(
    [...relevant, ...catalogPaths],
    INVESTIGATION_PACKET_MAX_PATHS,
  );
  const preimagePaths = uniqueLimited(
    facts.preimages.map((item) => item.path),
    INVESTIGATION_PACKET_MAX_PATHS,
  );
  const patchPaths = uniqueLimited(
    facts.patches.map((item) => item.targetPath),
    INVESTIGATION_PACKET_MAX_PATHS,
  );
  return {
    schemaVersion: 1,
    laterUserTurns: laterUserTurns.turns,
    candidatePaths,
    preimagePaths,
    patchPaths,
    ...(facts.git ? { isRepo: facts.git.isRepo } : {}),
    truncated:
      laterUserTurns.truncated ||
      pathTruncated ||
      candidatePaths.length === INVESTIGATION_PACKET_MAX_PATHS,
  };
}

function relativePathCluesFromValue(value: unknown): string[] {
  const text = JSON.stringify(value);
  const candidates =
    text.match(/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\.[A-Za-z0-9_-]{1,32})/g) ?? [];
  return [
    ...new Set(
      candidates.filter((item) => isRelativePath(item) && !item.startsWith("event:")),
    ),
  ].slice(0, 32);
}

function laterTurns(taskCase: TaskCase): { turns: string[]; truncated: boolean } {
  const users = taskCase.transcript.filter((message) => message.role === "user");
  const startText = taskCase.initialInput.text;
  const start = users.findIndex((message) => message.text === startText);
  const rest = (start >= 0 ? users.slice(start + 1) : users.slice(1)).map((message) =>
    message.text.slice(0, INVESTIGATION_PACKET_MAX_TURN_CHARS),
  );
  return {
    turns: rest.slice(0, INVESTIGATION_PACKET_MAX_LATER_TURNS),
    truncated: rest.length > INVESTIGATION_PACKET_MAX_LATER_TURNS,
  };
}

function uniqueLimited(values: readonly string[], max: number): string[] {
  return [...new Set(values.filter((item) => item.length > 0))].slice(0, max);
}
