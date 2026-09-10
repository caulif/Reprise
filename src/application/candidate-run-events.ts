import { Value } from "@sinclair/typebox/value";
import { isRecord, text } from "../core/json.js";
import { isCandidateRuntimeJournalType } from "../core/runtime.js";
import { CandidateRuntimeEventSchema, type EventEnvelope } from "../core/schema.js";

/** Identity fields plus adapter body for a `runtime.*` EventEnvelope.payload. */
export function candidateRuntimeJournalPayload(sessionId: string, payload: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = isRecord(payload) ? { ...payload } : payload === undefined ? {} : { value: payload };
  const refs = body.evidenceRefs;
  return {
    ...body,
    sessionId: text(body.sessionId) ?? sessionId,
    evidenceRefs: Array.isArray(refs) ? refs.filter((item): item is string => typeof item === "string") : [],
  };
}

export function assertCandidateRuntimeJournal(envelope: EventEnvelope): void {
  if (!isCandidateRuntimeJournalType(envelope.type)) {
    throw new Error(`TargetRunner must emit CandidateRuntimeEvent types, not ${envelope.type}.`);
  }
  if (!Value.Check(CandidateRuntimeEventSchema, envelope.payload)) {
    throw new Error(`Candidate runtime journal event ${envelope.type} payload is not a CandidateRuntimeEvent.`);
  }
}
