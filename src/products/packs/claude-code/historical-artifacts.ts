import { isRecord, record, text, type JsonRecord } from "../../../core/json.js";
import type {
  HistoricalArtifactExtractInput,
  HistoricalArtifactExtractResult,
} from "../../contract.js";
import {
  HistoricalArtifactBuilder,
  applyUniqueReplace,
  sourceHashForExtract,
} from "../../shared/historical-artifact-apply.js";

export const CLAUDE_HISTORICAL_ARTIFACTS_VERSION = "claude-historical-artifacts/v1";

const FILE_TOOLS = new Set(["Write", "Edit", "Delete"]);
const MUTATING_SHELL_TOOLS = new Set(["Bash", "Shell", "bash", "shell"]);

type PendingTool = {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: JsonRecord;
  readonly sourceRef: string;
};

/**
 * Reconstruct deliverable bytes from frozen Claude Code transcript/events.
 * Maps complete Write and unique Edit; successful Bash invalidates priors (fail-closed).
 */
export function extractClaudeHistoricalArtifacts(input: HistoricalArtifactExtractInput): HistoricalArtifactExtractResult {
  const builder = new HistoricalArtifactBuilder({
    sourceHash: sourceHashForExtract(input),
    extractorVersion: CLAUDE_HISTORICAL_ARTIFACTS_VERSION,
    ...(input.historicalCwd ? { historicalCwd: input.historicalCwd } : {}),
  });
  const pending = new Map<string, PendingTool>();
  for (const [index, row] of input.historicalEvents.entries()) {
    if (!isRecord(row)) continue;
    const sourceRef = `event:history-${index}`;
    if (row.type === "assistant") {
      collectAssistantTools(pending, row, sourceRef);
      continue;
    }
    if (row.type === "user") {
      applyToolResults(builder, pending, row, sourceRef);
    }
  }
  for (const call of pending.values()) {
    builder.issue("ambiguous_version", [call.sourceRef], undefined, "Tool call has no successful result.");
  }
  return builder.finish();
}

function collectAssistantTools(pending: Map<string, PendingTool>, row: JsonRecord, sourceRef: string): void {
  const content = record(row.message).content;
  if (!Array.isArray(content)) return;
  for (const [blockIndex, part] of content.entries()) {
    if (!isRecord(part) || part.type !== "tool_use") continue;
    const name = text(part.name);
    if (!name || (!FILE_TOOLS.has(name) && !MUTATING_SHELL_TOOLS.has(name))) continue;
    const toolUseId = text(part.id) ?? `tool-${sourceRef}-${blockIndex}`;
    pending.set(toolUseId, { toolUseId, name, input: record(part.input), sourceRef });
  }
}

function applyToolResults(
  builder: HistoricalArtifactBuilder,
  pending: Map<string, PendingTool>,
  row: JsonRecord,
  sourceRef: string,
): void {
  const content = row.message && isRecord(row.message) ? row.message.content : row.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool_result") continue;
    const toolUseId = text(part.tool_use_id) ?? text(part.toolUseId);
    if (!toolUseId) continue;
    const call = pending.get(toolUseId);
    pending.delete(toolUseId);
    if (!call) continue;
    const refs = [call.sourceRef, sourceRef];
    if (part.is_error === true) {
      builder.issue("failed_tool", refs);
      continue;
    }
    if (MUTATING_SHELL_TOOLS.has(call.name)) {
      builder.markAllUnknown(refs, "unsupported_write");
      continue;
    }
    applyClaudeWrite(builder, call, refs);
  }
}

function applyClaudeWrite(builder: HistoricalArtifactBuilder, call: PendingTool, refs: readonly string[]): void {
  const path = text(call.input.file_path) ?? text(call.input.path);
  if (!path) {
    builder.markAllUnknown(refs, "unsupported_write");
    return;
  }
  if (call.name === "Delete") {
    builder.applyWrite({ kind: "delete", logicalPath: path, sourceRefs: refs });
    return;
  }
  if (call.name === "Write") {
    const body = text(call.input.content) ?? text(call.input.new_string);
    if (body === undefined) {
      builder.markUnknown(path, refs, "truncated_content");
      return;
    }
    builder.applyWrite({ kind: "add", logicalPath: path, bytes: Buffer.from(body, "utf8"), sourceRefs: refs });
    return;
  }
  if (call.name === "Edit") {
    const oldText = text(call.input.old_string) ?? text(call.input.oldString);
    const newText = text(call.input.new_string) ?? text(call.input.newString);
    if (oldText === undefined || newText === undefined) {
      builder.markUnknown(path, refs, "unsupported_write");
      return;
    }
    const preimage = builder.knownBytes(path);
    if (!preimage) {
      builder.markUnknown(path, refs, "missing_preimage");
      return;
    }
    const next = applyUniqueReplace(preimage, oldText, newText);
    if (!next) {
      builder.markUnknown(path, refs, "ambiguous_version");
      return;
    }
    builder.applyWrite({ kind: "update", logicalPath: path, bytes: next, sourceRefs: refs });
    return;
  }
  builder.markUnknown(path, refs, "unsupported_write");
}
