import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ToolPreconditionRejected } from "../../../../core/tool-precondition-rejected.js";
import type { AgentToolDefinition } from "../../types.js";
import { AgentToolFailure } from '../../tools.js';
import { observePiFailure } from './yield-deadline.js';

const WRITE_TOOLS = new Set(["edit", "write", "shell_exec"]);

const PI_TOOL_EXECUTION = "sequential" as const;

export function toPiTool(tool: AgentToolDefinition, onFailure?: (error: unknown) => void, onRecoverableFailure = onFailure): AgentTool {
  const parameters = JSON.parse(JSON.stringify(tool.parameters)) as AgentTool['parameters'];
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    prepareArguments(params) {
      try {
        const validated: unknown = validateToolArguments({ name: tool.name, description: tool.description, parameters },
          { type: 'toolCall', id: 'validation', name: tool.name, arguments: params as Record<string, unknown> });
        return validated;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Validation failed for tool ')) {
          throw new Error(error.message.split('\n\nReceived arguments:')[0], { cause: error });
        }
        throw error;
      }
    },
    ...(WRITE_TOOLS.has(tool.name) ? { executionMode: "sequential" as const } : {}),
    async execute(_toolCallId, params, signal) {
      const result = await observePiFailure(() => tool.execute(params, signal ?? new AbortController().signal), (error) => {
        if (error instanceof AgentToolFailure) onFailure?.(error);
        else if (!(error instanceof ToolPreconditionRejected)) onRecoverableFailure?.(error);
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
