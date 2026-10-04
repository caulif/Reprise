import { readFile } from "node:fs/promises";
import type { EventEnvelope } from "../../core/schema.js";
import {
  parseCommittedEventLog,
  reconstructModelRequests,
  type ModelInputResolver,
} from "./model-input.js";

/** Read-only: committed events and reconstructed model input. Does not load providers, Runtime, or product packs. */
export async function readCommittedModelLog(
  eventsPath: string,
  resolveArtifact?: ModelInputResolver | { forEvents(events: readonly EventEnvelope[]): ModelInputResolver },
) {
  const parsed = parseCommittedEventLog(await readFile(eventsPath, "utf8"));
  const resolver = typeof resolveArtifact === 'function' ? resolveArtifact : resolveArtifact?.forEvents(parsed.events);
  const rebuilt = await reconstructModelRequests(parsed.events, resolver);
  return {
    events: parsed.events,
    requests: rebuilt.requests,
    ...(rebuilt.compactionRequests ? { compactionRequests: rebuilt.compactionRequests } : {}),
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
