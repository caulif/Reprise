import { text } from "../../../core/json.js";
import { runtimeTargetEvent, type TargetEvent } from "../../../core/runtime.js";

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
export function claudeFrameEvent(frame: Record<string, unknown>): TargetEvent | undefined {
  const type = text(frame.type);
  if (type === "system" && text(frame.subtype) === "init") return runtimeTargetEvent("session_started", frame);
  if (type === "assistant") return runtimeTargetEvent("visible_output", frame);
  if (type === "user") return runtimeTargetEvent("tool_finished", frame);
  if (type === "result") return runtimeTargetEvent("usage_reported", frame);
  return undefined;
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
  return text(row.sessionId);
}
