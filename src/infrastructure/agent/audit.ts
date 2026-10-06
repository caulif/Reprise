import { inlineBody, redactModelVisibleText, redactModelVisibleValue } from "./model-input.js";
import type { AgentAuditSink, InvocationCursor, ProviderAdapter } from "./types.js";
import { recordedContext, recordedImageRefs } from './artifacts.js';
import { AgentModelRequestFactsSchema, RecordedModelContextSchema, type AgentTextBody } from '../../core/agent-model-input-schema.js';
import { Value } from '@sinclair/typebox/value';
import { AgentUsageFactsSchema } from '../../core/schema.js';

export function callerLoopHooks(
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
  audit: AgentAuditSink | undefined,
): Pick<
  Parameters<ProviderAdapter["createSession"]>[0],
  "onContextCompact" | "onAssistantVisible" | "onRetry" | "onBeforeToolCall" | "onToolRejected" | "onAfterToolCall" | "onModelRequest" | "onModelUsage"
> {
  return {
    onModelUsage: async (payload) => {
      if (!Value.Check(AgentUsageFactsSchema, payload)) throw new Error('Model usage facts failed schema validation.');
      await audit?.append({ type: 'agent.usage_reported', sessionId, role,
        payload: { schemaVersion: 1, invocationId: cursor.invocationId, requestIndex: cursor.requestIndex, ...payload } });
    },
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
          retainedTail: inlineBody(JSON.stringify(redactModelVisibleValue(await recordedContext(payload.retainedTail ?? [], audit)))),
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
    onToolRejected: async ({ tool, callDigest }) => {
      const payload = { tool, toolCallId: `${cursor.invocationId ?? sessionId}:tool:${cursor.toolSeq = (cursor.toolSeq ?? 0) + 1}`, callDigest,
        ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}), nativeHook: 'sdk_rejected', code: 'sdk_pre_execution_rejected' };
      await audit?.append({ type: 'agent.tool_called', sessionId, role, payload });
      await audit?.append({ type: 'agent.tool_failed', sessionId, role, payload: { ...payload,
        message: 'Pi SDK rejected the tool call before Host execution; no Host tool effect occurred.' } });
    },
    onAfterToolCall: async (payload) => {
      await audit?.append({ type: "agent.tool_completed", sessionId, role, payload: { ...payload, nativeHook: "after" } });
    },
    onModelRequest: async (payload) => {
      const { compactionContext, generationContext, ...request } = payload;
      const compactionInput = compactionContext && await recordModelContext(compactionContext, audit);
      const generationInput = generationContext && await recordModelContext(generationContext, audit);
      const facts = { ...request, ...(compactionInput ? { compactionInput } : {}), ...(generationInput ? { generationInput } : {}), images: await recordedImageRefs(payload.images, audit) };
      if (!Value.Check(AgentModelRequestFactsSchema, facts)) throw new Error('Model request facts failed schema validation.');
      await audit?.append({
        type: "agent.model_request",
        sessionId,
        role,
        payload: { schemaVersion: 1, invocationId: cursor.invocationId, requestIndex: cursor.requestIndex, ...facts },
      });
    },
  };
}

async function recordModelContext(context: { systemPrompt?: string; messages: readonly unknown[]; tools?: readonly unknown[] }, audit: AgentAuditSink | undefined): Promise<AgentTextBody> {
  const recorded = redactModelVisibleValue({ ...context, messages: await recordedContext(context.messages, audit) });
  if (!Value.Check(RecordedModelContextSchema, recorded)) throw new Error('Model input context failed schema validation.');
  return { encoding: 'inline', schemaVersion: 1, text: JSON.stringify(recorded) };
}
