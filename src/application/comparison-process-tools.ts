import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import { ManagedProcesses } from "../infrastructure/managed-processes.js";

const StartSchema = Type.Object({ command: Type.String({ minLength: 1, maxLength: 8192 }) });
const PollSchema = Type.Object({ taskId: Type.String({ minLength: 1 }),
  cursor: Type.Optional(Type.Object({ stdout: Type.Integer({ minimum: 0 }), stderr: Type.Integer({ minimum: 0 }) })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })) });
const StopSchema = Type.Object({ taskId: Type.String({ minLength: 1 }) });

function result(value: Record<string, unknown>): AgentToolResult {
  return { content: JSON.stringify(value), details: value };
}

export function createComparisonProcessTools(processes: ManagedProcesses): AgentToolDefinition[] {
  return [
    { name: "process_start", description: "Start a long-running command in this attempt's scratch directory; returns an attempt-scoped taskId.",
      parameters: StartSchema, async execute(params, signal) {
        if (!Value.Check(StartSchema, params)) return result({ status: "invalid_request" });
        try { return result(await processes.start(params.command, signal)); }
        catch (error) { return result({ status: "error", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "process_poll", description: "Read incremental stdout/stderr from an attempt-scoped taskId. The returned cursor is repeatable; full output stays under scratch/process.",
      parameters: PollSchema, async execute(params) {
        if (!Value.Check(PollSchema, params)) return result({ status: "invalid_request" });
        try { return result(await processes.poll(params.taskId, params.cursor ?? { stdout: 0, stderr: 0 }, params.maxBytes)); }
        catch (error) { return result({ status: "error", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "process_stop", description: "Stop an attempt-scoped background command and its process tree.",
      parameters: StopSchema, async execute(params) {
        if (!Value.Check(StopSchema, params)) return result({ status: "invalid_request" });
        try { processes.stop(params.taskId); return result({ status: "stopped" }); }
        catch (error) { return result({ status: "error", message: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
