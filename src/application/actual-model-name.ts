export function actualModelName(resolved: string | undefined): string | undefined {
  const name = resolved?.trim();
  return name && name !== "unknown" && name !== "pending" && name !== "unavailable" ? name : undefined;
}
