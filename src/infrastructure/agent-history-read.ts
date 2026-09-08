import { readFile } from "node:fs/promises";
import type { EventEnvelope } from "../core/schema.js";
import {
  parseCommittedEventLog,
  reconstructModelRequests,
  type ArtifactBodyResolver,
} from "./agent-model-input.js";

/** Read-only: committed events and reconstructed model input. Does not load providers, Runtime, or product packs. */
export async function readCommittedModelLog(
  eventsPath: string,
  resolveArtifact?: ArtifactBodyResolver,
) {
  const parsed = parseCommittedEventLog(await readFile(eventsPath, "utf8"));
  const rebuilt = await reconstructModelRequests(parsed.events, resolveArtifact);
  return {
    events: parsed.events,
    requests: rebuilt.requests,
    diagnostic: rebuilt.diagnostic ?? parsed.diagnostic,
    runStatus: historicalRunStatus(parsed.events),
  };
}

/** Candidate/run display status from committed events only; lock files and PIDs are irrelevant. */
export function historicalRunStatus(events: readonly EventEnvelope[]): "finished" | "interrupted" | "unknown" {
  if (events.some((event) => event.type === "run.finished")) return "finished";
  if (events.some((event) => event.type === "run.attempt_created")) return "interrupted";
  return "unknown";
}
