import { record, text, type JsonRecord } from "../../../core/json.js";
import { runtimeTargetEvent, type TargetEvent } from "../../../core/runtime.js";
import { liveFromCodexItem } from "../../shared/public-live-map.js";
import { toolFacts } from "../../shared/tool-facts.js";
import { redactNotificationParams } from "./turn-settlement.js";
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { NativeExecutionObservationSchema } from '../../../core/schema.js';
import { nativeExecutionObservation } from '../../../core/execution-boundary.js';

const SandboxPolicySchema = Type.Union([
  Type.Object({ type: Type.Literal('dangerFullAccess') }),
  Type.Object({ type: Type.Literal('readOnly'), networkAccess: Type.Boolean() }),
  Type.Object({ type: Type.Literal('workspaceWrite'), writableRoots: Type.Array(Type.String()), networkAccess: Type.Boolean(), excludeTmpdirEnvVar: Type.Boolean(), excludeSlashTmp: Type.Boolean() }),
  Type.Object({ type: Type.Literal('externalSandbox'), networkAccess: Type.Union([Type.Literal('enabled'), Type.Literal('restricted')]) }),
]);
const SANDBOX_MODES = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write', externalSandbox: 'external-sandbox' } as const;

export function codexExecutionObservation(value: unknown, configured: string) {
  const mode = Value.Check(SandboxPolicySchema, value) ? SANDBOX_MODES[value.type] : value;
  const observation = nativeExecutionObservation(mode, configured);
  return Value.Check(NativeExecutionObservationSchema, observation) ? observation : undefined;
}

/** Maps Codex notifications to CandidateRuntimeEvent types. Deltas and heartbeats stay inside the adapter. */
export function codexNotificationEvent(method: string, params: unknown): TargetEvent | undefined {
  if (method.includes("delta") || method === "stderr") return undefined;
  const payload = redactNotificationParams(method, params);
  if (method === "item/started" || method === "item/completed") return mapItem(method === "item/completed", payload);
  if (method === "turn/started") return runtimeTargetEvent("turn_started", payload);
  if (method === "turn/completed") return runtimeTargetEvent("turn_settled", payload);
  if (method === "thread/tokenUsage/updated") return runtimeTargetEvent("usage_reported", payload);
  if (method === "error" || method === "server/request/rejected" || method === "server_request_rejected" || method === "protocol_error") {
    return runtimeTargetEvent("runtime_failed", payload);
  }
  if (method === "turn/plan/updated") return runtimeTargetEvent("visible_output", { kind: "plan", ...record(payload) });
  if (method === "mcpServer/startupStatus/updated") return runtimeTargetEvent("tool_started", payload);
  return undefined;
}

export function peekCodexSessionMetaId(row: JsonRecord): string | undefined {
  return text(row.type) === "session_meta" ? text(record(row.payload).id) : undefined;
}

function mapItem(completed: boolean, payload: unknown): TargetEvent | undefined {
  const item = record(record(payload).item);
  const kind = text(item.type);
  if (kind === "reasoning") return undefined;
  if (kind === "agentMessage") return runtimeTargetEvent("visible_output", { ...record(payload), streaming: !completed });
  if (kind === "userMessage") return runtimeTargetEvent("visible_prompt", payload);
  const live = liveFromCodexItem(item);
  return runtimeTargetEvent(completed ? "tool_finished" : "tool_started", {
    ...record(payload),
    ...(live ? { live } : {}),
    // A Codex item names its MCP tool (`item.tool`); every other item kind is identified by its category.
    ...toolFacts({ name: text(item.tool) ?? kind, input: item.command ?? item.arguments, exitCode: item.exitCode ?? item.exit_code }),
  });
}
