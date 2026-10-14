export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}

export function integer(
  value: unknown,
  fallback: number | undefined,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
