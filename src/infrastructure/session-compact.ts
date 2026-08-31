import { sha256 } from "../core/identity.js";

export type CompactableMessage = {
  role: string;
  toolName?: string;
  toolCallId?: string;
  content?: unknown;
};

export type CompactedToolRef = {
  toolName: string;
  toolCallId: string;
  digest: string;
  byteLength: number;
};

const COMPACTED = '"compacted":true';

export function compactAgentMessages<T extends CompactableMessage>(
  messages: readonly T[],
): { messages: T[]; replaced: CompactedToolRef[] } {
  const lastAssistant = lastIndex(messages, (message) => message.role === "assistant");
  const replaced: CompactedToolRef[] = [];
  const next = messages.map((message, index) => {
    if (message.role !== "toolResult" || index > lastAssistant) return message;
    const text = toolResultText(message);
    if (text.includes(COMPACTED)) return message;
    const byteLength = Buffer.byteLength(text);
    const digest = sha256(text);
    replaced.push({
      toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "unknown",
      digest,
      byteLength,
    });
    return {
      ...message,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            compacted: true,
            toolName: message.toolName,
            byteLength,
            digest,
          }),
        },
      ],
    };
  });
  return { messages: next, replaced };
}

function lastIndex<T>(values: readonly T[], match: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (match(values[index]!)) return index;
  }
  return -1;
}

function toolResultText(message: CompactableMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}
