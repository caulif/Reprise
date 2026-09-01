import {
  compact,
  convertToLlm,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";

export { convertToLlm };

const COMPACT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 400 } as const;

export type PiCompactionAudit = {
  summary: string;
  tokensBefore: number;
  retainedCount: number;
};

export function contextWindowOf(model: { contextWindow?: number }): number {
  const window = model.contextWindow;
  return typeof window === "number" && window > 0 ? window : 128_000;
}

export function needsPiCompaction(messages: readonly AgentMessage[], contextWindow: number): boolean {
  return shouldCompact(estimateContextTokens([...messages]).tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

export async function compactPiMessages(input: {
  messages: readonly AgentMessage[];
  models: Pick<Models, "completeSimple">;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
}): Promise<{ messages: AgentMessage[]; audit: PiCompactionAudit } | undefined> {
  const prepared = prepareCompaction(agentMessagesToEntries(input.messages), DEFAULT_COMPACTION_SETTINGS);
  if (!prepared.ok || !prepared.value) return undefined;
  if (prepared.value.messagesToSummarize.length === 0) return undefined;
  const compacted = await compact(
    prepared.value,
    input.models as Models,
    input.model,
    undefined,
    input.signal,
    input.thinkingLevel,
    COMPACT_RETRY,
  );
  if (!compacted.ok) return undefined;
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
