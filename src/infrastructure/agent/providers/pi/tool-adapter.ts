import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { ToolPreconditionRejected } from "../../../../core/tool-precondition-rejected.js";
import type { AgentToolDefinition } from "../../types.js";
import { observePiFailure } from './yield-deadline.js';

const WRITE_TOOLS = new Set(["edit", "write", "shell_exec"]);

const PI_TOOL_EXECUTION = "sequential" as const;

export function toPiTool(tool: AgentToolDefinition, onFailure?: (error: unknown) => void): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as AgentTool["parameters"],
    ...(WRITE_TOOLS.has(tool.name) ? { executionMode: "sequential" as const } : {}),
    async execute(_toolCallId, params, signal) {
      const result = await observePiFailure(() => tool.execute(params, signal ?? new AbortController().signal), (error) => {
        if (!(error instanceof ToolPreconditionRejected)) onFailure?.(error);
      });
      return {
        content: result.contentBlocks ? [...result.contentBlocks] : [{ type: "text", text: result.content }],
        details: result.details ?? {},
      };
    },
  };
}

export function createPiAgent(input: ConstructorParameters<typeof Agent>[0]): Agent {
  return new Agent({ ...input, toolExecution: PI_TOOL_EXECUTION });
}
