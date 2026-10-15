import { sha256 } from "../../core/identity.js";
import { Value } from '@sinclair/typebox/value';
import { ToolPreconditionRejected } from "../../core/tool-precondition-rejected.js";
import { inlineBody, redactToolResultForModel, toolResultBody } from "./model-input.js";
import type { AgentAuditEvent, AgentAuditSink, AgentToolDefinition, AgentToolResult, InvocationCursor } from "./types.js";
import { recordedImageRefs } from './artifacts.js';
import { preserveToolDelivery } from './tool-delivery.js';
import { redactModelVisibleText } from './model-input.js';

export class AgentToolFailure extends Error {
  constructor(role: string, cause: unknown) {
    super(`${role} agent tool execution failed.`, { cause });
    this.name = "AgentToolFailure";
  }
}

export function instrumentTools(
  tools: readonly AgentToolDefinition[],
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
  audit?: AgentAuditSink,
  acceptsImage = false,
): AgentToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || !tool.description.trim() || names.has(tool.name)) {
      throw new Error("Agent tool definitions require unique safe names and descriptions.");
    }
    names.add(tool.name);
    return {
      ...tool,
      async execute(params, signal) {
        signal.throwIfAborted();
        const startedAt = Date.now();
        const requestIndex = cursor.requestIndex;
        const toolCallId = `${cursor.invocationId ?? sessionId}:tool:${cursor.toolSeq = (cursor.toolSeq ?? 0) + 1}`;
        let rejection: ToolPreconditionRejected | undefined;
        try {
          await appendToolAudit(audit, role, {
            type: "agent.tool_called",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              toolCallId,
              params: safeParams(params),
              startedAt, requestIndex, executionMode: tool.executionMode ?? "sequential",
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
            },
          });
          const raw = await (async () => {
            if (role === 'controller' && !Value.Check(tool.parameters, params)) throw new ToolPreconditionRejected('invalid_arguments', 'Arguments do not match the tool schema. Correct the parameters and retry.');
            return tool.execute(params, signal, { sessionId, invocationId: cursor.invocationId ?? sessionId });
          })().catch((error: unknown) => {
            if (role === 'controller' && error instanceof ToolPreconditionRejected && !signal.aborted &&
              ['invalid_path', 'symlink_path', 'not_regular_file', 'invalid_arguments', 'edit_text_mismatch', 'workspace_busy', 'invalid_process_session'].includes(error.reason)) {
              const failure = { status: 'rejected', code: error.reason, message: error.message, retryable: true };
              return { content: JSON.stringify(failure), details: failure };
            }
            if (error instanceof ToolPreconditionRejected && !signal.aborted) rejection = error;
            throw error;
          });
          const result = acceptsImage ? raw : stripImageBlocksForTextOnly(raw);
          const visible = redactToolResultForModel(result);
          signal.throwIfAborted();
          const images = visible.contentBlocks?.filter((block) => block.type === 'image');
          const refs = await recordedImageRefs(images, audit);
          let index = 0;
          const body = images?.length ? inlineBody(JSON.stringify(visible.contentBlocks!.map((block) => block.type === 'image' ? refs[index++] : block))) : toolResultBody(visible);
          await appendToolAudit(audit, role, {
            type: "agent.tool_completed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              toolCallId,
              startedAt, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt, requestIndex,
              byteLength: contentByteLength(visible),
              contentTypes: contentTypes(visible),
              contentDigest: contentDigest(visible),
              body,
              ...(images?.length ? { images: refs } : {}),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
              ...(visible.details && typeof visible.details === "object" ? { details: safeDetails(visible.details) } : {}),
            },
          });
          signal.throwIfAborted();
          await tool.onCompleted?.(visible);
          return visible;
        } catch (error) {
          await appendToolAudit(audit, role, {
            type: "agent.tool_failed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              toolCallId,
              startedAt, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt, requestIndex,
              message: error instanceof AgentToolFailure && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
            },
          });
          if (rejection) {
            const wrapped = new ToolPreconditionRejected(rejection.reason, rejection.message, { cause: error });
            wrapped.name = "AgentToolFailure";
            throw wrapped;
          }
          throw new AgentToolFailure(role, error);
        }
      },
    };
  });
}

async function appendToolAudit(audit: AgentAuditSink | undefined, role: string, event: AgentAuditEvent): Promise<void> {
  try {
    await audit?.append(event);
  } catch (error) {
    throw new AgentToolFailure(role, error);
  }
}

const IMAGE_OMITTED_NOTE = "Image content omitted: this model session does not accept image input.";

function stripImageBlocksForTextOnly(result: AgentToolResult): AgentToolResult {
  if (!result.contentBlocks?.some((block) => block.type === "image")) return result;
  const deliveryText = (text: string): string => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'imageDelivery' in parsed) {
        return JSON.stringify({ ...parsed, imageDelivery: 'unsupported_model' });
      }
    } catch { /* Non-JSON tool text has no structured delivery receipt to update. */ }
    return text;
  };
  const textBlocks = result.contentBlocks.filter((block) => block.type === "text").map((block) => ({ ...block, text: deliveryText(block.text) }));
  const content = `${deliveryText(result.content)}\n${IMAGE_OMITTED_NOTE}`.trim();
  return preserveToolDelivery(result, {
    content,
    contentBlocks: [...textBlocks, { type: "text" as const, text: IMAGE_OMITTED_NOTE }],
    details: { ...(typeof result.details === 'object' && result.details !== null ? result.details : {}), imageDelivery: 'unsupported_model' },
  });
}

function contentByteLength(result: AgentToolResult): number {
  if (!result.contentBlocks) return Buffer.byteLength(result.content);
  return result.contentBlocks.reduce(
    (total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text) : Buffer.byteLength(block.data, "base64")),
    0,
  );
}

function contentTypes(result: AgentToolResult): string[] {
  return result.contentBlocks ? [...new Set(result.contentBlocks.map((block) => block.type))] : ["text"];
}

function contentDigest(result: AgentToolResult): string {
  return sha256(result.contentBlocks ? JSON.stringify(result.contentBlocks) : result.content);
}

function safeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valueType: typeof value };
  const facts: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    facts[key] =
      key === "content" && typeof item === "string"
        ? { byteLength: Buffer.byteLength(item) }
        : key === "path" && typeof item === "string"
          ? redactAuditText(item).slice(0, 240)
          : ["command", "cmd", "workdir", "chars", "session_id"].includes(key) && typeof item === "string"
            ? redactAuditText(item)
            : ["yield_time_ms", "max_output_tokens"].includes(key) && typeof item === "number" ? item
            : typeof item;
  }
  return facts;
}

function safeDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valueType: typeof value };
  const facts: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    facts[key] =
      key === "command" && typeof item === "string"
        ? redactAuditText(item)
        : key === "content" && typeof item === "string"
          ? { byteLength: Buffer.byteLength(item) }
          : typeof item === "string"
            ? redactModelVisibleText(item).text
            : item;
  }
  return facts;
}

function redactAuditText(text: string): string {
  return redactModelVisibleText(text).text;
}
