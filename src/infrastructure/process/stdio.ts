import { redactModelVisibleText } from "../agent/model-input.js";

/** Auth schemes must be fully removed before shared rules rewrite the scheme word alone. */
const AUTH_SCHEME_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:api[_-]?key|authorization|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** Target stderr is persisted verbatim into the run journal, so credentials must never survive the trip. */
export function redactDiagnostic(value: string): string {
  // 1) Complete Bearer/Basic values, 2) shared full-value rules (JSON / special-char secrets),
  // 3) remaining token shapes (sk-/gh-/JWT and field=value leftovers).
  let next = value;
  for (const pattern of AUTH_SCHEME_PATTERNS) next = next.replace(pattern, "[REDACTED]");
  next = redactModelVisibleText(next).text;
  for (const pattern of TOKEN_SHAPE_PATTERNS) next = next.replace(pattern, "[REDACTED]");
  return next;
}

export function summarizeDiagnostic(value: string, limit = 240): string {
  const flattened = value.replace(/https?:\/\/[^\s]+/gi, "[endpoint]").replace(/[\r\n\t]/g, " ");
  return redactDiagnostic(flattened).slice(0, limit);
}
