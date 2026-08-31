export function unknownEvidenceRefMessage(
  refs: readonly string[],
  available: ReadonlySet<string>,
): string | undefined {
  return refs.some((ref) => !available.has(ref)) ? "unknown evidence reference" : undefined;
}
