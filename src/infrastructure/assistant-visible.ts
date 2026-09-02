const MAX_VISIBLE_CHARS = 4_096;

export function visibleAssistantText(content: readonly { type?: string; text?: string }[] | undefined): string {
  if (!content?.length) return "";
  const text = content
    .filter((block) => block.type === "text" && block.text?.trim())
    .map((block) => block.text?.trim() ?? "")
    .join("\n")
    .trim();
  if (!text) return "";
  if (isStructuredEnvelope(text)) return "";
  return text.length > MAX_VISIBLE_CHARS ? `${text.slice(0, MAX_VISIBLE_CHARS)}…` : text;
}

export function isStructuredEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const value = JSON.parse(trimmed) as { type?: unknown; status?: unknown };
    return Boolean(value && typeof value === "object" && (value.type || value.status));
  } catch {
    return false;
  }
}
