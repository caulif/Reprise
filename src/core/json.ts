/**
 * Narrowing helpers for values that crossed a trust boundary (persisted JSON, RPC payloads,
 * session files). Every reader in the codebase used to carry its own copy of these four lines.
 */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Absent or malformed objects collapse to `{}` so callers can keep chaining lookups. */
export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
