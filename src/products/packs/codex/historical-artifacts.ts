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

export const CODEX_HISTORICAL_ARTIFACTS_VERSION = "codex-historical-artifacts/v1";

type PendingCall = {
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
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
      pending.set(callId, { callId, name, argumentsText, sourceRef });
      continue;
    }
    if (row.type === "response_item" && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      const callId = text(payload.call_id) ?? text(payload.callId);
      const output = text(payload.output) ?? "";
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
      if (isFailedToolOutput(output)) {
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
  const name = call.name.toLowerCase();
  if (name === "apply_patch" || name.endsWith("apply_patch")) {
    applyPatchArgument(builder, call.argumentsText, refs);
    return;
  }
  if (/(?:shell|command|exec)/i.test(call.name)) {
    const command = commandFromArguments(call.argumentsText);
    if (command === undefined) {
      builder.markAllUnknown(refs, "unsupported_write");
      return;
    }
    const staticPatch = extractStaticApplyPatchFromExec(command);
    if (staticPatch.status === "ok") {
      applyParsedPatch(builder, staticPatch.patch, refs);
      return;
    }
    if (staticPatch.status === "unsupported") {
      // Dynamic apply_patch / non-static construction — do not keep earlier finals.
      builder.markAllUnknown(refs, "unsupported_write");
      return;
    }
    // No apply_patch call: still invalidate when the shell likely rewrote files.
    if (looksLikeMutatingShell(command)) {
      builder.markAllUnknown(refs, "unsupported_write");
    }
  }
}

function looksLikeMutatingShell(command: string): boolean {
  return /(?:writeFileSync|writeFile|Write-Item|Set-Content|Out-File|Move-Item|Copy-Item|\btee\b|\bmv\b|\bcp\b|\brm\b|Remove-Item|\bcat\s*>|\bprintf\s|>|>>)/i.test(command);
}

function applyPatchArgument(builder: HistoricalArtifactBuilder, argumentsText: string, refs: readonly string[]): void {
  let patchText: string | undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isRecord(parsed)) patchText = text(parsed.patch) ?? text(parsed.input);
  } catch {
    patchText = argumentsText.includes("*** ") ? argumentsText : undefined;
  }
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

function commandFromArguments(argumentsText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (!isRecord(parsed)) return undefined;
    return text(parsed.command) ?? text(parsed.cmd);
  } catch {
    return undefined;
  }
}

function isFailedToolOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (/^\[error\]/i.test(trimmed)) return true;
  if (/"success"\s*:\s*false/i.test(trimmed)) return true;
  if (/\bexit[_ ]code["']?\s*[:=]\s*(?!0\b)\d+/i.test(trimmed)) return true;
  if (/^(?:Error|ERROR|Failed|failed)\b/.test(trimmed) && !/success/i.test(trimmed)) return true;
  return false;
}

type StaticPatchExtract =
  | { readonly status: "ok"; readonly patch: string }
  | { readonly status: "absent" }
  | { readonly status: "unsupported" };

/**
 * Only decodes `const name = "..." ; apply_patch(name)` (or template-free double-quoted literals).
 * Rejects concatenation, templates, function calls, and unbound names.
 */
export function extractStaticApplyPatchFromExec(command: string): StaticPatchExtract {
  if (!/\bapply_patch\s*\(/.test(command)) return { status: "absent" };
  const call = command.match(/\bapply_patch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (!call) {
    const inline = command.match(/\bapply_patch\s*\(\s*("(?:\\.|[^"\\])*")\s*\)/);
    if (inline?.[1]) {
      try {
        return { status: "ok", patch: JSON.parse(inline[1]) as string };
      } catch {
        return { status: "unsupported" };
      }
    }
    return { status: "unsupported" };
  }
  const ident = call[1]!;
  const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRegExp(ident)}\s*=\s*("(?:\\.|[^"\\])*")\s*;`);
  const matched = command.match(decl);
  if (!matched?.[1]) return { status: "unsupported" };
  // Reject if the same identifier is reassigned or built via concatenation before apply_patch.
  const beforeCall = command.slice(0, call.index ?? 0);
  if (new RegExp(String.raw`\b${escapeRegExp(ident)}\s*[+\=]`).test(beforeCall.replace(decl, ""))) {
    return { status: "unsupported" };
  }
  try {
    return { status: "ok", patch: JSON.parse(matched[1]) as string };
  } catch {
    return { status: "unsupported" };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
