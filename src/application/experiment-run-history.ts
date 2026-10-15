import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { RunAttemptSchema, RunRecordSchema, RunStartupFailureSchema, type EventEnvelope, type RunAttempt, type RunRecord } from "../core/schema.js";
import { parseCommittedEventLog } from "../infrastructure/agent/model-input.js";

export async function readCommittedRunEvents(root: string) {
  try { return parseCommittedEventLog(await readFile(join(root, "events.jsonl"), "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { events: [] };
    throw error;
  }
}

export function matchingRunRecord(value: unknown, experimentId: string, runId: string, caseId: string, events: readonly EventEnvelope[] = []): value is RunRecord {
  if (!Value.Check(RunRecordSchema, value)) return false;
  const valid = value.attempt.experimentId === experimentId
    && value.attempt.runId === runId && value.attempt.caseId === caseId
    && value.trace.experimentId === experimentId && value.trace.runId === runId
    && (!value.manifest || Value.Equal(value.manifest.attempt, value.attempt));
  if (!valid) return false;
  if (!hasRunLifecycle(events, runId)) return value.artifactRefs.every((ref) =>
    Value.Equal(ref, { artifactId: ref.artifactId, caseId })
    || Value.Equal(ref, { artifactId: ref.artifactId, experimentId, runId }));
  const created = events.find((event) => event.type === "run.attempt_created" && event.runId === runId);
  const finished = events.find((event) => event.type === "run.finished" && event.runId === runId);
  if (!created || !Value.Check(RunAttemptSchema, created.payload) || !Value.Equal(created.payload, value.attempt)
    || !finished || created.sequence >= finished.sequence || !Value.Check(RunRecordSchema, finished.payload)) return false;
  const { artifactRefs: _committedRefs, ...committed } = finished.payload;
  const { artifactRefs: _persistedRefs, ...persisted } = value;
  if (!Value.Equal(committed, persisted) || !Value.Equal(value.artifactRefs.slice(0, _committedRefs.length), _committedRefs)) return false;
  const extra = value.artifactRefs.slice(_committedRefs.length);
  return extra.length === 0 || (extra.length === 1
    && Value.Equal(extra[0], { artifactId: "host-trace.json", experimentId, runId })
    && events.some((event) => event.type === "artifact.created" && event.runId === runId && event.sequence > finished.sequence
      && typeof event.payload === "object" && event.payload !== null && "artifactId" in event.payload && event.payload.artifactId === "host-trace.json"));
}

export function hasRunLifecycle(events: readonly EventEnvelope[], runId: string): boolean {
  return events.some((event) => event.runId === runId && event.type.startsWith("run."));
}

async function legacyRunTimestamp(root: string, runId: string): Promise<number | undefined> {
  for (const name of ["record.json", "attempt.json"]) {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, "runs", runId, name), "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) continue;
      throw error;
    }
    const attempt = Value.Check(RunAttemptSchema, value) ? value : Value.Check(RunRecordSchema, value) ? value.attempt : undefined;
    if (attempt?.runId === runId && attempt.experimentId === basename(root)) {
      const time = Date.parse(attempt.createdAt);
      return Number.isFinite(time) ? time : undefined;
    }
  }
  return undefined;
}

export async function legacyRunOrder(root: string, ids: readonly string[]): Promise<readonly string[]> {
  const timestamps = await Promise.all(ids.map(async (id) => ({ id, time: await legacyRunTimestamp(root, id) })));
  return timestamps.sort((a, b) => (a.time ?? -Infinity) - (b.time ?? -Infinity) || a.id.localeCompare(b.id)).map((item) => item.id);
}

export async function legacyOrderingKind(root: string, ids: readonly string[]): Promise<"legacy_timestamp" | "unknown"> {
  const times = await Promise.all(ids.map((id) => legacyRunTimestamp(root, id)));
  const known = times.filter((time): time is number => time !== undefined);
  return known.length === times.length && known.filter((time) => time === Math.max(...known)).length === 1 ? "legacy_timestamp" : "unknown";
}

export function committedRunOrder(root: string, events: Awaited<ReturnType<typeof readCommittedRunEvents>>["events"]): readonly string[] {
  return [...new Set(events.filter((event) => event.type === "run.attempt_created" && Value.Check(RunAttemptSchema, event.payload)
    && event.payload.experimentId === basename(root) && event.payload.runId === event.runId).map((event) => event.runId!))];
}

export function latestCommittedAttempt(root: string, events: readonly EventEnvelope[], runId?: string) {
  for (const event of [...events].reverse()) {
    if (event.type !== "run.attempt_created" || (runId && event.runId !== runId) || !Value.Check(RunAttemptSchema, event.payload)) continue;
    if (event.payload.experimentId === basename(root) && event.payload.runId === event.runId) return event.payload;
  }
  return undefined;
}

export function committedStartupFailure(events: readonly EventEnvelope[], attempt: RunAttempt) {
  const created = events.find((event) => event.type === "run.attempt_created" && event.runId === attempt.runId && Value.Equal(event.payload, attempt));
  if (!created) return undefined;
  for (const event of [...events].reverse()) {
    if (event.type !== "run.startup_failed" || event.runId !== attempt.runId || event.sequence <= created.sequence || !Value.Check(RunStartupFailureSchema, event.payload)) continue;
    const failure = event.payload;
    if (failure.experimentId === attempt.experimentId && failure.runId === attempt.runId && failure.caseId === attempt.caseId) return failure;
  }
  return undefined;
}
