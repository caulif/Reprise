import { SAFE_ID } from "../core/identity.js";
import type { RunOutcome } from "../core/schema.js";
import type { MessageIdentity, RuntimeFailureKind, TurnSettlement, UserMessage } from "../core/runtime.js";

type Assessment = RunOutcome["task"];
type Termination = RunOutcome["termination"];

export function messageFact(message: UserMessage, identity: MessageIdentity): Record<string, unknown> {
  return { messageId: message.id, clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, text: message.text };
}

export function errorFact(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

export function remainingResources(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("remainingResourceIds" in error)) return [];
  const value: unknown = (error as { remainingResourceIds?: unknown }).remainingResourceIds;
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && SAFE_ID.test(id));
  return ids.length === value.length ? ids : [];
}

export function terminationFor(code: string, cause: unknown): Termination {
  if (code.startsWith("completed.")) return { kind: "completed", code, initiatedBy: "controller" };
  if (code.startsWith("limit.")) return { kind: "limit_reached", code, initiatedBy: "harness" };
  if (code.startsWith("cancelled.")) return { kind: "cancelled", code, initiatedBy: "user" };
  if (code.startsWith("blocked.")) return { kind: "blocked", code, initiatedBy: "controller" };
  if (code.startsWith("stalled.")) return { kind: "stalled", code, initiatedBy: code === "stalled.controller_no_further_value" ? "controller" : "harness" };
  if (code === "failed.controller") {
    const inner = hasFailureCode(cause) ? cause.code : "agent_failure";
    return { kind: "failed", code, initiatedBy: "controller", failure: { origin: "controller", code: inner, message: errorFact(cause).message, evidenceRefs: [] } };
  }
  if (code.startsWith("uncertain.")) return { kind: "uncertain", code, initiatedBy: "harness" };
  return { kind: "failed", code, initiatedBy: "harness", failure: { origin: "runtime", code: specificFailureCode(code, cause), message: errorFact(cause).message, evidenceRefs: [] } };
}

export function finishFromSettlement(settlement: TurnSettlement): { code: string; cause: Error } {
  const specific = runtimeFailureCode(settlement.failure?.kind);
  const message = settlement.failure?.summary ?? `Target turn settled as ${settlement.status}.`;
  return { code: "failed.runtime", cause: Object.assign(new Error(message), { code: specific }) };
}

export function annotateRuntimeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (hasFailureCode(error)) return error;
  const specific = runtimeFailureCode(kindFromThrownMessage(error.message));
  if (specific === "failed.runtime") return error;
  return Object.assign(error, { code: specific });
}

export function assessmentFor(code: string, settled: boolean, hasManifest: boolean): Assessment {
  if (!hasManifest) return { status: "not_assessed", evidenceRefs: [] };
  if (code.startsWith("limit.") && settled) return { status: "incomplete", evidenceRefs: [] };
  return { status: settled ? "indeterminate" : "not_assessed", evidenceRefs: [] };
}

function specificFailureCode(code: string, cause: unknown): string {
  return hasFailureCode(cause) ? cause.code : code;
}

function runtimeFailureCode(kind: RuntimeFailureKind | undefined): string {
  if (kind === "upstream") return "failed.runtime.upstream_unavailable";
  if (kind === "authentication") return "failed.runtime.authentication";
  if (kind === "protocol") return "failed.runtime.protocol";
  if (kind === "process") return "failed.runtime.process";
  return "failed.runtime";
}

function kindFromThrownMessage(message: string): RuntimeFailureKind | undefined {
  if (/unrecognized turn|invalid json-rpc|protocol error/i.test(message)) return "protocol";
  if (/app-server exited|process exited|failed to start:|EPIPE/i.test(message)) return "process";
  if (/HTTP\s*503|\b503\b|temporarily unavailable/i.test(message)) return "upstream";
  if (/unauthorized|invalid api key|HTTP\s*401/i.test(message)) return "authentication";
  return undefined;
}

function hasFailureCode(value: unknown): value is { code: string } {
  if (!value || typeof value !== "object" || !("code" in value)) return false;
  return typeof value.code === "string" && value.code.length > 0;
}
