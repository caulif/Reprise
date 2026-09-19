export function unknownEvidenceRefMessage(
  refs: readonly string[],
  available: ReadonlySet<string>,
): string | undefined {
  const unknown = refs.filter((ref) => !available.has(ref));
  if (unknown.length === 0) return undefined;
  return `unknown evidence reference: ${unknown.join(", ")}`;
}
