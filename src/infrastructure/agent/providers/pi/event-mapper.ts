export function isAssistantMessageEnd(
  event: { type: string; message?: { role?: string } },
): event is { type: "message_end"; message: { role: "assistant" } } {
  return event.type === "message_end" && event.message?.role === "assistant";
}
