import type { AgentFailure, AgentFailureCode } from "./types.js";

export type AgentFailureKind =
  | "authentication"
  | "rate_limited"
  | "transient_network"
  | "transient_upstream"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "tool"
  | "privacy"
  | "persistence"
  | "unknown";

function agentFailureRetryable(kind: AgentFailureKind | undefined): boolean {
  return kind === "rate_limited" || kind === "transient_network" || kind === "transient_upstream" || kind === "timeout";
}

export function toAgentFailure(input: {
  code: AgentFailureCode;
  message: string;
  attempts: number;
  kind?: AgentFailureKind;
  retryable?: boolean;
}): AgentFailure {
  const kind = input.kind ?? (input.code === "privacy_blocked" ? "privacy" : input.code === "audit_failure" ? "persistence" : "unknown");
  return {
    code: input.code,
    message: input.message,
    attempts: input.attempts,
    kind,
    retryable: input.retryable ?? agentFailureRetryable(kind),
  };
}

/** Classifies provider errors for retry policy. Transport abort is not user cancel. */
export function classifyAgentFailure(error: unknown): AgentFailureKind {
  if (error instanceof Error && error.name === "AgentToolFailure") return "tool";
  if (isTimeout(error)) return "timeout";
  const details = errorDetails(error).toLowerCase();
  const status = errorStatus(error);
  if (status === 401 || status === 403 || /\b(unauthori[sz]ed|forbidden|invalid api key|authentication)\b/.test(details))
    return "authentication";
  if (status === 429 || /\b(rate.?limit|too many requests|quota)\b/.test(details)) return "rate_limited";
  if ([408, 500, 502, 503, 504].includes(status ?? 0) || /\b(upstream_error|upstream request failed|service temporarily unavailable|bad gateway|gateway timeout)\b/.test(details))
    return "transient_upstream";
  if (isTransportFailure(details, error)) return "transient_network";
  if (isUserCancel(error, details)) return "cancelled";
  if (/\b(context_length_exceeded|maximum context length|prompt is too long|context window|context budget)\b/.test(details))
    return "protocol";
  if (/\b(invalid json|schema|protocol|malformed|unexpected response)\b/.test(details)) return "protocol";
  return "unknown";
}

function isTransportFailure(details: string, error: unknown): boolean {
  if (/\b(http\/2 stream failed|und_err_|fetch failed|econnreset|econnrefused|enotfound|etimedout|timeout|network|transport|socket)\b/.test(details))
    return true;
  if (error instanceof Error && error.name === "AbortError" && !isUserCancel(error, details)) return true;
  return false;
}

function isUserCancel(error: unknown, details: string): boolean {
  return error instanceof Error && error.name === "AbortError" && /\bpi model request was aborted\b/.test(details);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.message === "agent timeout");
}

function errorStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    for (const value of [record.status, record.statusCode, record.code]) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
      if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
    }
    current = record.cause;
  }
  return undefined;
}

function errorDetails(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else break;
  }
  return messages.join(" ");
}
