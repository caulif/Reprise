import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../core/identity.js";
import {
  ControllerObservationReadPayloadSchema,
  ControllerRequestedPayloadSchema,
  EvidenceRefSchema,
  type ControllerObservationReadPayload,
  type EventEnvelope,
} from "../core/schema.js";

export type ReconstructedControllerRequest = {
  requestId: string;
  runId: string;
  inputDigest: string;
  snapshot: Record<string, unknown>;
};

type ControllerCatalogEntry = {
  ref: string;
  runId: string;
  source: "initial" | "tool";
};

/** Host-asserted refs from a successful observation; `allowed` is this run's event refs when persisting. */
function ownedEvidenceRefs(
  runId: string,
  details: unknown,
  allowed?: ReadonlySet<string>,
): string[] {
  if (!details || typeof details !== "object") return [];
  const record = details as { runId?: unknown; evidenceRefs?: unknown };
  if (record.runId !== runId || !Array.isArray(record.evidenceRefs)) return [];
  const refs: string[] = [];
  for (const ref of record.evidenceRefs) {
    if (typeof ref !== "string" || !Value.Check(EvidenceRefSchema, ref)) continue;
    if (allowed && !allowed.has(ref)) continue;
    refs.push(ref);
  }
  return refs;
}

export function observationReadRecord(input: {
  requestId: string;
  runId: string;
  details: unknown;
  allowedRefs: ReadonlySet<string>;
}): {
  type: "controller.observation_read";
  runId: string;
  operationId: string;
  payload: ControllerObservationReadPayload;
} {
  const rawSource =
    input.details && typeof input.details === "object" ? (input.details as { source?: unknown }).source : undefined;
  const source = typeof rawSource === "string" && rawSource.length > 0 && rawSource.length <= 64 ? rawSource : "unknown";
  const payload: ControllerObservationReadPayload = {
    schemaVersion: 1,
    requestId: input.requestId,
    runId: input.runId,
    source,
    evidenceRefs: ownedEvidenceRefs(input.runId, input.details, input.allowedRefs),
  };
  return {
    type: "controller.observation_read",
    runId: input.runId,
    operationId: `${input.requestId}-observation-${sha256(JSON.stringify(payload)).slice(0, 16)}`,
    payload,
  };
}

/** Rebuilds the persisted, de-identified Controller input without a model call or live workspace read. */
export function reconstructControllerRequest(events: readonly EventEnvelope[], requestId: string): ReconstructedControllerRequest {
  const event = events.find((candidate) => candidate.type === "controller.requested" && candidate.operationId === requestId);
  if (!event || !event.runId) throw new Error(`Controller request ${requestId} was not found.`);
  if (!Value.Check(ControllerRequestedPayloadSchema, event.payload)) throw new Error("controller.requested payload is malformed.");
  const payload = event.payload;
  const snapshot = payload.snapshot as Record<string, unknown>;
  if (sha256(JSON.stringify(snapshot)) !== payload.inputDigest) throw new Error(`Controller request ${requestId} digest mismatch.`);
  return {
    requestId,
    runId: event.runId,
    inputDigest: payload.inputDigest,
    snapshot: { ...snapshot, evidenceCatalog: catalogWithObservationReads(snapshot, events, requestId, event.runId) },
  };
}

function catalogWithObservationReads(
  snapshot: Record<string, unknown>,
  events: readonly EventEnvelope[],
  requestId: string,
  runId: string,
): ControllerCatalogEntry[] {
  const catalog = catalogEntries(snapshot.evidenceCatalog);
  const seen = new Set(catalog.map((entry) => entry.ref));
  for (const candidate of events) {
    if (candidate.type !== "controller.observation_read" || candidate.runId !== runId) continue;
    if (!isPayloadForRequest(candidate.payload, requestId)) continue;
    if (!Value.Check(ControllerObservationReadPayloadSchema, candidate.payload)) {
      throw new Error("controller.observation_read payload is malformed.");
    }
    for (const ref of candidate.payload.evidenceRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      catalog.push({ ref, runId, source: "tool" });
    }
  }
  return catalog;
}

function catalogEntries(value: unknown): ControllerCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ControllerCatalogEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { ref?: unknown; runId?: unknown; source?: unknown };
    if (typeof record.ref !== "string" || typeof record.runId !== "string") continue;
    if (record.source !== "initial" && record.source !== "tool") continue;
    entries.push({ ref: record.ref, runId: record.runId, source: record.source });
  }
  return entries;
}

function isPayloadForRequest(payload: unknown, requestId: string): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { requestId?: unknown }).requestId === requestId);
}
