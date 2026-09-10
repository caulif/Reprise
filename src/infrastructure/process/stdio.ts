const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:api[_-]?key|authorization|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** Target stderr is persisted verbatim into the run journal, so credentials must never survive the trip. */
export function redactDiagnostic(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), value);
}

export function summarizeDiagnostic(value: string, limit = 240): string {
  const flattened = value.replace(/https?:\/\/[^\s]+/gi, '[endpoint]').replace(/[\r\n\t]/g, ' ');
  return redactDiagnostic(flattened).slice(0, limit);
}
