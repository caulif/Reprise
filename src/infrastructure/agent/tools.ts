import { sha256 } from "../../core/identity.js";
import { redactToolResultForModel, toolResultBody } from "./model-input.js";
import type { AgentAuditSink, AgentToolDefinition, AgentToolResult, InvocationCursor } from "./types.js";

class AgentToolFailure extends Error {
  constructor(cause: unknown) {
    super("Recovery agent tool execution failed.", { cause });
    this.name = "AgentToolFailure";
  }
}

export function instrumentTools(
  tools: readonly AgentToolDefinition[],
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
  audit?: AgentAuditSink,
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
        const toolCallId = `${cursor.invocationId ?? sessionId}:tool:${cursor.toolSeq = (cursor.toolSeq ?? 0) + 1}`;
        await audit?.append({
          type: "agent.tool_called",
          sessionId,
          role,
          payload: {
            tool: tool.name,
            toolCallId,
            params: safeParams(params),
            ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
          },
        });
        try {
          const result = await tool.execute(params, signal);
          const visible = redactToolResultForModel(result);
          await tool.onCompleted?.(visible);
          await audit?.append({
            type: "agent.tool_completed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              toolCallId,
              byteLength: contentByteLength(visible),
              contentTypes: contentTypes(visible),
              contentDigest: contentDigest(visible),
              body: toolResultBody(visible),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
              ...(visible.details && typeof visible.details === "object" ? { details: safeDetails(visible.details) } : {}),
            },
          });
          return visible;
        } catch (error) {
          await audit?.append({
            type: "agent.tool_failed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              message: error instanceof Error ? error.message : String(error),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
            },
          });
          throw new AgentToolFailure(error);
        }
      },
    };
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
          : key === "command" && typeof item === "string"
            ? redactAuditText(item)
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
          : typeof item === "string" && item.length > 512
            ? `${item.slice(0, 512)}…`
            : item;
  }
  return facts;
}

function redactAuditText(text: string): string {
  return text
    .replace(/(authorization\s*[=:]\s*)(?:"?)(?:Bearer\s+)?[^\s"]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 2048);
}
