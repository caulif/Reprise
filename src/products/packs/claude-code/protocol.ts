import { record, text } from "../../../core/json.js";
import { runtimeTargetEvent, type TargetEvent } from "../../../core/runtime.js";
import { liveFromClaudeToolUse } from "../../shared/public-live-map.js";

export const CLAUDE_DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendMessage'] as const;
export const CLAUDE_REQUIRED_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--replay-user-messages',
  '--strict-mcp-config',
  '--disallowed-tools', CLAUDE_DISALLOWED_TOOLS.join(','),
  '--no-session-persistence',
] as const;

/** Maps Claude stream-json frames to CandidateRuntimeEvent types. Keep-alives stay inside the adapter. */
export function claudeFrameEvents(frame: Record<string, unknown>): readonly TargetEvent[] {
  const type = text(frame.type);
  if (type === "system" && text(frame.subtype) === "init") return [runtimeTargetEvent("session_started", frame)];
  if (type === "assistant") {
    return [runtimeTargetEvent("visible_output", frame), ...claudeToolStartedEvents(frame)];
  }
  if (type === "user") return [runtimeTargetEvent("tool_finished", frame)];
  if (type === "result") return [runtimeTargetEvent("usage_reported", frame)];
  return [];
}

function claudeToolStartedEvents(frame: Record<string, unknown>): readonly TargetEvent[] {
  const sessionId = peekClaudeSessionId(frame);
  const content = record(record(frame.message).content ? record(frame.message) : frame).content;
  if (!Array.isArray(content)) return [];
  const events: TargetEvent[] = [];
  for (const part of content) {
    const block = record(part);
    if (text(block.type) !== "tool_use") continue;
    const name = text(block.name);
    if (!name) continue;
    const mapped = liveFromClaudeToolUse(name, block.input, text(block.id));
    events.push(runtimeTargetEvent("tool_started", {
      schemaVersion: 1,
      ...(sessionId ? { sessionId } : {}),
      evidenceRefs: [],
      ...(mapped.callId ? { callId: mapped.callId } : {}),
      live: mapped.live,
    }));
  }
  return events;
}

function claudeResultLooksFailed(frame: Record<string, unknown>, normalTerminal: ReadonlySet<string>): boolean {
  const terminal = text(frame.terminal_reason);
  return frame.is_error === true || (terminal !== undefined && !normalTerminal.has(terminal));
}

export function claudeSettlementStatus(
  frame: Record<string, unknown>,
  normalTerminal: ReadonlySet<string>,
): "completed" | "failed" | undefined {
  const subtype = text(frame.subtype);
  if (claudeResultLooksFailed(frame, normalTerminal)) return "failed";
  if (subtype?.startsWith("error_")) return "failed";
  if (subtype === "success" && frame.is_error !== true) return "completed";
  return undefined;
}

export function peekClaudeSessionId(row: Record<string, unknown>): string | undefined {
  return text(row.sessionId) ?? text(row.session_id);
}
