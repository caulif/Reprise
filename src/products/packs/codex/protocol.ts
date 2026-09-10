import { record, text } from "../../../core/json.js";
import { runtimeTargetEvent, type TargetEvent } from "../../../core/runtime.js";
import { redactNotificationParams } from "./turn-settlement.js";

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

function mapItem(completed: boolean, payload: unknown): TargetEvent | undefined {
  const item = record(record(payload).item);
  const kind = text(item.type);
  if (kind === "reasoning") return undefined;
  if (kind === "agentMessage") return runtimeTargetEvent("visible_output", { ...record(payload), streaming: !completed });
  if (kind === "userMessage") return runtimeTargetEvent("visible_prompt", payload);
  return runtimeTargetEvent(completed ? "tool_finished" : "tool_started", payload);
}
