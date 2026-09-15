import {
  compact,
  convertToLlm,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";

export { convertToLlm };

const COMPACT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 400 } as const;
const TOOL_STUB_BYTES = 16_384;

export type PiCompactionAudit = {
  summary: string;
  tokensBefore: number;
  retainedCount: number;
  reason: string;
  retainedTail: readonly unknown[];
};

export function contextWindowOf(model: { contextWindow?: number }): number {
  const window = model.contextWindow;
  return typeof window === "number" && window > 0 ? window : 128_000;
}

export function estimatedMessageTokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens([...messages]).tokens;
}

export function needsPiCompaction(messages: readonly AgentMessage[], contextWindow: number): boolean {
  const tokens = messages.some((message) => message.role === "compactionSummary")
    ? messages.reduce((sum, message) => sum + estimateTokens(message), 0)
    : estimateContextTokens([...messages]).tokens;
  return shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

export function stripThinkMarkup(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<mm:think>[\s\S]*?<\/mm:think>/gi, "")
    .replace(/<\/mm:think>/gi, "")
    .trim();
}

/** Drop thinking markup and oversized tool bodies. */
export function prunePiMessagesForBudget(messages: AgentMessage[]): { changed: boolean; summary: string } {
  const notes: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
            const next = stripThinkMarkup(block.text);
            if (next !== block.text) {
              block.text = next;
              notes.push("stripped thinking");
            }
          }
        }
      }
    }
    if (message.role === "toolResult") {
      const raw = JSON.stringify(message.content);
      if (Buffer.byteLength(raw) > TOOL_STUB_BYTES) {
        const toolName = "toolName" in message && typeof message.toolName === "string" ? message.toolName : "tool";
        message.content = [{ type: "text", text: JSON.stringify({ stub: true, toolName, byteLength: Buffer.byteLength(raw) }) }];
        notes.push(`stubbed ${toolName}`);
      }
    }
  }
  return { changed: notes.length > 0, summary: [...new Set(notes)].join("; ") || "unchanged" };
}

export async function compactPiMessages(input: {
  messages: readonly AgentMessage[];
  models: Pick<Models, "completeSimple">;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  customInstructions?: string;
  signal?: AbortSignal;
}): Promise<{ messages: AgentMessage[]; audit: PiCompactionAudit } | undefined> {
  input.signal?.throwIfAborted();
  const prepared = prepareCompaction(agentMessagesToEntries(input.messages), DEFAULT_COMPACTION_SETTINGS);
  if (!prepared.ok || !prepared.value) return undefined;
  if (prepared.value.messagesToSummarize.length === 0 && prepared.value.turnPrefixMessages.length === 0) return undefined;
  const summaryTokens = [...prepared.value.messagesToSummarize, ...prepared.value.turnPrefixMessages].reduce((sum, message) => sum + estimateTokens(message), 0)
    + Math.ceil((prepared.value.previousSummary?.length ?? 0) / 3) + 4_096;
  if (summaryTokens >= contextWindowOf(input.model) - DEFAULT_COMPACTION_SETTINGS.reserveTokens) throw new Error('Context budget: summary input exceeds the model window; narrow evidence before compaction.');
  const compacted = await compact(
    prepared.value,
    input.models as Models,
    input.model,
    input.customInstructions,
    input.signal,
    input.thinkingLevel,
    COMPACT_RETRY,
  );
  input.signal?.throwIfAborted();
  if (!compacted.ok) throw new Error('Context budget: summary request failed.');
  const summary = createCompactionSummaryMessage(
    compacted.value.summary,
    compacted.value.tokensBefore,
    Date.now(),
  );
  const messages: AgentMessage[] = [summary, ...compacted.value.retainedTail];
  return {
    messages,
    audit: {
      summary: compacted.value.summary,
      tokensBefore: compacted.value.tokensBefore,
      retainedCount: compacted.value.retainedTail.length,
      reason: "pi_compact",
      retainedTail: compacted.value.retainedTail,
    },
  };
}

function agentMessagesToEntries(messages: readonly AgentMessage[]): Entry[] {
  return messages.map((message, index) => {
    const base = {
      id: `m${index}`,
      seq: index,
      parentId: index === 0 ? null : `m${index - 1}`,
      timestamp: messageTimestamp(message, index),
    };
    if (message.role === "compactionSummary") {
      return {
        ...base,
        type: "compaction" as const,
        summary: message.summary,
        retainedTail: [],
        tokensBefore: message.tokensBefore,
      };
    }
    return { ...base, type: "message" as const, message };
  });
}

function messageTimestamp(message: AgentMessage, index: number): number {
  return "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : index;
}
