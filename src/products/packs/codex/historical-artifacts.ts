import { isRecord, record, text } from "../../../core/json.js";
import type {
  HistoricalArtifactExtractInput,
  HistoricalArtifactExtractResult,
} from "../../contract.js";
import {
  HistoricalArtifactBuilder,
  sourceHashForExtract,
} from "../../shared/historical-artifact-apply.js";
import { applyUpdateHunks, parseApplyPatchText } from "./apply-patch.js";
import {
  classifyShellCommand,
  classifyCustomExec,
  commandFromArguments,
  isCodexApplyPatchTool,
  isCodexShellTool,
  isFailedToolOutput,
  isFailedCustomExecOutput,
  isSuccessfulCustomExecOutput,
  patchTextFromApplyPatchArguments,
} from "./historical-artifact-policy.js";

export { extractStaticApplyPatchFromExec } from "./historical-artifact-policy.js";

export const CODEX_HISTORICAL_ARTIFACTS_VERSION = "codex-historical-artifacts/v1";

type PendingCall = {
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
  readonly inputAvailable: boolean;
  readonly sourceRef: string;
};

/**
 * Reconstruct deliverable bytes from frozen Codex transcript/events.
 * Does not write files, exec history, or read the live cwd.
 */
export function extractCodexHistoricalArtifacts(input: HistoricalArtifactExtractInput): HistoricalArtifactExtractResult {
  const builder = new HistoricalArtifactBuilder({
    sourceHash: sourceHashForExtract(input),
    extractorVersion: CODEX_HISTORICAL_ARTIFACTS_VERSION,
    ...(input.historicalCwd ? { historicalCwd: input.historicalCwd } : {}),
  });
  const pending = new Map<string, PendingCall>();
  for (const [index, row] of input.historicalEvents.entries()) {
    if (!isRecord(row)) continue;
    const sourceRef = `event:history-${index}`;
    const payload = record(row.payload);
    const payloadType = text(payload.type);
    if (row.type === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const callId = text(payload.call_id) ?? text(payload.callId) ?? `anon-${index}`;
      const name = text(payload.name) ?? "tool";
      const argumentsText = text(payload.arguments) ?? text(payload.input) ?? "";
      pending.set(callId, {
        callId, name, argumentsText, sourceRef,
        inputAvailable: name !== "exec" || payloadType !== "custom_tool_call" || typeof payload.input === "string",
      });
      continue;
    }
    if (row.type === "response_item" && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      const callId = text(payload.call_id) ?? text(payload.callId);
      const output = payload.output;
      if (!callId) {
        builder.issue("ambiguous_version", [sourceRef], undefined, "Tool output missing call_id.");
        continue;
      }
      const call = pending.get(callId);
      pending.delete(callId);
      if (!call) {
        builder.issue("ambiguous_version", [sourceRef], undefined, "Tool output without matching call.");
        continue;
      }
      const refs = [call.sourceRef, sourceRef];
      if (call.name === "exec") {
        if (!call.inputAvailable) {
          builder.markAllUnknown(refs, "unsupported_write");
          continue;
        }
        const classified = classifyCustomExec(call.argumentsText);
        if (classified.kind === "no_write_evidence") continue;
        if (!isSuccessfulCustomExecOutput(output)) {
          builder.markAllUnknown(refs, isFailedCustomExecOutput(output) ? "failed_tool" : "ambiguous_version");
          continue;
        }
        if (classified.kind === "static_apply_patch") applyParsedPatch(builder, classified.patch, refs);
        else builder.markAllUnknown(refs, "unsupported_write");
        continue;
      }
      if (isFailedToolOutput(text(output) ?? "")) {
        builder.issue("failed_tool", refs);
        continue;
      }
      applySuccessfulCodexTool(builder, call, refs);
    }
  }
  for (const call of pending.values()) {
    builder.issue("ambiguous_version", [call.sourceRef], undefined, "Tool call has no successful result.");
  }
  return builder.finish();
}

function applySuccessfulCodexTool(builder: HistoricalArtifactBuilder, call: PendingCall, refs: readonly string[]): void {
  if (isCodexApplyPatchTool(call.name)) {
    applyPatchArgument(builder, call.argumentsText, refs);
    return;
  }
  if (!isCodexShellTool(call.name)) return;
  const command = commandFromArguments(call.argumentsText);
  if (command === undefined) {
    builder.markAllUnknown(refs, "unsupported_write");
    return;
  }
  const classified = classifyShellCommand(command);
  if (classified.kind === "static_apply_patch") {
    applyParsedPatch(builder, classified.patch, refs);
    return;
  }
  builder.markAllUnknown(refs, "unsupported_write");
}

function applyPatchArgument(builder: HistoricalArtifactBuilder, argumentsText: string, refs: readonly string[]): void {
  const patchText = patchTextFromApplyPatchArguments(argumentsText);
  if (!patchText) {
    builder.issue("truncated_content", refs, undefined, "apply_patch arguments missing patch text.");
    return;
  }
  applyParsedPatch(builder, patchText, refs);
}

function applyParsedPatch(builder: HistoricalArtifactBuilder, patchText: string, refs: readonly string[]): void {
  const parsed = parseApplyPatchText(patchText);
  if (!parsed.ok) {
    builder.issue(parsed.reason === "empty" ? "truncated_content" : "unsupported_write", refs);
    return;
  }
  for (const op of parsed.ops) {
    if (op.kind === "add") {
      builder.applyWrite({ kind: "add", logicalPath: op.path, bytes: op.bytes, sourceRefs: refs });
      continue;
    }
    if (op.kind === "delete") {
      builder.applyWrite({ kind: "delete", logicalPath: op.path, sourceRefs: refs });
      continue;
    }
    if (op.kind === "move") {
      builder.applyWrite({
        kind: "move",
        logicalPath: op.path,
        destinationPath: op.destinationPath,
        sourceRefs: refs,
      });
      continue;
    }
    const preimage = builder.knownBytes(op.path);
    if (!preimage) {
      builder.markUnknown(op.path, refs, "missing_preimage");
      continue;
    }
    const next = applyUpdateHunks(preimage, op.hunks);
    if (!next) {
      builder.markUnknown(op.path, refs, "ambiguous_version");
      continue;
    }
    builder.applyWrite({ kind: "update", logicalPath: op.path, bytes: next, sourceRefs: refs });
  }
}
