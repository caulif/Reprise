import { inlineBody, redactModelVisibleText } from "./model-input.js";
import type { AgentAuditSink, InvocationCursor, ProviderAdapter } from "./types.js";

export function callerLoopHooks(
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
  audit: AgentAuditSink | undefined,
): Pick<
  Parameters<ProviderAdapter["createSession"]>[0],
  "onContextCompact" | "onAssistantVisible" | "onRetry" | "onBeforeToolCall" | "onAfterToolCall" | "onModelRequest"
> {
  return {
    onContextCompact: async (payload) => {
      await audit?.append({
        type: "agent.context_compacted",
        sessionId,
        role,
        payload: {
          schemaVersion: 1,
          invocationId: cursor.invocationId,
          requestIndex: cursor.requestIndex,
          summary: redactModelVisibleText(payload.summary).text,
          tokensBefore: payload.tokensBefore,
          retainedCount: payload.retainedCount,
          reason: payload.reason ?? "compact",
          retainedTail: inlineBody(JSON.stringify(payload.retainedTail ?? [])),
        },
      });
    },
    onAssistantVisible: async (payload) => {
      await audit?.append({ type: "agent.assistant_visible", sessionId, role, payload });
    },
    onRetry: async (payload) => {
      await audit?.append({ type: "agent.request_retried", sessionId, role, payload });
    },
    onBeforeToolCall: async ({ tool }) => {
      await audit?.append({ type: "agent.tool_called", sessionId, role, payload: { tool, nativeHook: "before" } });
    },
    onAfterToolCall: async (payload) => {
      await audit?.append({ type: "agent.tool_completed", sessionId, role, payload: { ...payload, nativeHook: "after" } });
    },
    onModelRequest: async (payload) => {
      await audit?.append({
        type: "agent.model_request",
        sessionId,
        role,
        payload: { schemaVersion: 1, invocationId: cursor.invocationId, requestIndex: cursor.requestIndex, ...payload },
      });
    },
  };
}
