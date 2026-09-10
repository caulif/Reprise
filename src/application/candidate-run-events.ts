import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../core/identity.js";
import { isRecord, record, text } from "../core/json.js";
import { isCandidateRuntimeJournalType, type TargetEvent, type TargetEventSink } from "../core/runtime.js";
import { CandidateRuntimeEventSchema, type EventEnvelope } from "../core/schema.js";

export type CandidateRuntimeJournal = {
  append(event: { type: string; runId: string; operationId?: string; payload: unknown; occurredAt?: string }): Promise<EventEnvelope>;
  events(runId: string): readonly EventEnvelope[];
};

export class CandidateRuntimeJournalError extends Error {
  readonly code: "late" | "duplicate" | "session" | "type" | "payload" | "sequence" | "turn" | "message" | "call" | "lifecycle";
  constructor(code: CandidateRuntimeJournalError["code"], message: string) {
    super(message);
    this.name = "CandidateRuntimeJournalError";
    this.code = code;
  }
}

/** Identity fields plus adapter body for a `runtime.*` EventEnvelope.payload. */
export function candidateRuntimeJournalPayload(sessionId: string, payload: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = isRecord(payload) ? { ...payload } : payload === undefined ? {} : { value: payload };
  const refs = body.evidenceRefs;
  return {
    ...body,
    schemaVersion: 1,
    sessionId: text(body.sessionId) ?? sessionId,
    evidenceRefs: Array.isArray(refs) ? refs.filter((item): item is string => typeof item === "string") : [],
  };
}

export function assertCandidateRuntimeJournal(envelope: EventEnvelope): void {
  if (!isCandidateRuntimeJournalType(envelope.type)) {
    throw new CandidateRuntimeJournalError("type", `TargetRunner must emit CandidateRuntimeEvent types, not ${envelope.type}.`);
  }
  if (!Value.Check(CandidateRuntimeEventSchema, envelope.payload)) {
    throw new CandidateRuntimeJournalError("payload", `Candidate runtime journal event ${envelope.type} payload is not a CandidateRuntimeEvent.`);
  }
}

function runtimeWriteClosed(events: readonly EventEnvelope[], runId: string): boolean {
  return events.some((event) => event.runId === runId && (event.type === "run.finished" || event.type === "run.outcome_created"));
}

const TURN_OPENERS = new Set(["runtime.turn_started", "runtime.delivery_observed", "runtime.message_submitted"]);
const MESSAGE_OPENERS = new Set(["runtime.message_submitted", "runtime.delivery_observed"]);
const SESSION_OPENERS = new Set(["runtime.session_started", "runtime.session_failed"]);

function assertRuntimeJournalAffiliation(
  events: readonly EventEnvelope[],
  type: string,
  body: Record<string, unknown>,
): void {
  const sessionOpened = events.some((event) => SESSION_OPENERS.has(event.type));
  const sessionClosed = events.some((event) => event.type === "runtime.session_closed");
  if (sessionClosed) {
    throw new CandidateRuntimeJournalError("lifecycle", `Candidate runtime event ${type} arrived after runtime.session_closed.`);
  }
  if (!sessionOpened && !SESSION_OPENERS.has(type)) {
    throw new CandidateRuntimeJournalError("lifecycle", `Candidate runtime event ${type} arrived before runtime.session_started.`);
  }
  const turnId = text(body.turnId);
  if (turnId) {
    const settled = settledTurnIds(events);
    if (type === "runtime.turn_settled") {
      if (settled.has(turnId)) {
        throw new CandidateRuntimeJournalError("turn", `turnId ${turnId} is not an active turn of this CandidateRun.`);
      }
    } else if (TURN_OPENERS.has(type)) {
      if (settled.has(turnId)) {
        throw new CandidateRuntimeJournalError("turn", `turnId ${turnId} is not an active turn of this CandidateRun.`);
      }
    } else if (!openTurnIds(events).has(turnId)) {
      throw new CandidateRuntimeJournalError("turn", `turnId ${turnId} is not an active turn of this CandidateRun.`);
    }
  }
  const messageId = text(body.messageId);
  if (messageId && !MESSAGE_OPENERS.has(type) && !knownMessageIds(events).has(messageId)) {
    throw new CandidateRuntimeJournalError("message", `messageId ${messageId} is not a submitted message of this CandidateRun.`);
  }
  const callId = text(body.callId);
  if (callId && type === "runtime.tool_finished" && finishedCallIds(events).has(callId)) {
    throw new CandidateRuntimeJournalError("call", `callId ${callId} already has a completed tool_finished event.`);
  }
}

function payloadId(event: EventEnvelope, key: "turnId" | "messageId" | "callId"): string | undefined {
  return text(record(event.payload)[key]);
}

function openTurnIds(events: readonly EventEnvelope[]): Set<string> {
  const open = new Set<string>();
  const settled = settledTurnIds(events);
  for (const event of events) {
    const turnId = payloadId(event, "turnId");
    if (turnId && !settled.has(turnId)) open.add(turnId);
  }
  return open;
}

function settledTurnIds(events: readonly EventEnvelope[]): Set<string> {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.type !== "runtime.turn_settled") continue;
    const turnId = payloadId(event, "turnId");
    if (turnId) settled.add(turnId);
  }
  return settled;
}

function knownMessageIds(events: readonly EventEnvelope[]): Set<string> {
  const known = new Set<string>();
  for (const event of events) {
    if (!MESSAGE_OPENERS.has(event.type)) continue;
    const messageId = payloadId(event, "messageId");
    if (messageId) known.add(messageId);
  }
  return known;
}

function finishedCallIds(events: readonly EventEnvelope[]): Set<string> {
  const finished = new Set<string>();
  for (const event of events) {
    if (event.type !== "runtime.tool_finished") continue;
    const callId = payloadId(event, "callId");
    if (callId) finished.add(callId);
  }
  return finished;
}

function boundSessionId(sessionId: string, payload: Record<string, unknown>): string {
  const fromPayload = text(payload.sessionId);
  if (sessionId && sessionId !== "unstarted") return sessionId;
  if (fromPayload) return fromPayload;
  if (sessionId === "unstarted") return "unstarted";
  throw new CandidateRuntimeJournalError("session", "Candidate runtime event is missing a real sessionId.");
}

/** The only Application write path for `runtime.*` Journal rows. */
export async function appendCandidateRuntimeEvent(input: {
  journal: CandidateRuntimeJournal;
  runId: string;
  sessionId: string;
  type: string;
  payload: unknown;
  occurredAt?: string;
  operationId?: string;
}): Promise<EventEnvelope> {
  if (!isCandidateRuntimeJournalType(input.type)) {
    throw new CandidateRuntimeJournalError("type", `TargetRunner must emit CandidateRuntimeEvent types, not ${input.type}.`);
  }
  const events = input.journal.events(input.runId);
  if (runtimeWriteClosed(events, input.runId)) {
    throw new CandidateRuntimeJournalError("late", `Candidate runtime event ${input.type} arrived after CandidateRun ${input.runId} finished.`);
  }
  const body = isRecord(input.payload) ? input.payload : {};
  if (typeof body.sequence === "number") {
    throw new CandidateRuntimeJournalError("sequence", "Adapter payload must not set Journal sequence.");
  }
  const sessionId = boundSessionId(input.sessionId, body);
  const fromPayload = text(body.sessionId);
  if (fromPayload && fromPayload !== sessionId) {
    throw new CandidateRuntimeJournalError("session", `Candidate runtime event sessionId ${fromPayload} does not match bound session ${sessionId}.`);
  }
  assertRuntimeJournalAffiliation(events, input.type, body);
  const payload = candidateRuntimeJournalPayload(sessionId, input.payload);
  const fingerprint = `rt-${sha256(`${input.type}\n${input.occurredAt ?? ""}\n${JSON.stringify(payload)}`).slice(0, 32)}`;
  const operationId = input.operationId ?? fingerprint;
  const envelope = await input.journal.append({
    type: input.type,
    runId: input.runId,
    operationId,
    payload,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
  assertCandidateRuntimeJournal(envelope);
  return envelope;
}

export function createCandidateRuntimeSink(input: {
  journal: CandidateRuntimeJournal;
  runId: string;
  sessionId: () => string;
  onCommitted?: (event: EventEnvelope) => void;
}): TargetEventSink {
  return {
    async append(event: TargetEvent): Promise<void> {
      const envelope = await appendCandidateRuntimeEvent({
        journal: input.journal,
        runId: input.runId,
        sessionId: input.sessionId(),
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
      });
      input.onCommitted?.(envelope);
    },
  };
}
