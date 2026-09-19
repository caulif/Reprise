/**
 * Codex historical-extract policy: named fail-closed rules for shell/tool classification.
 * Additive rows go here; do not grow ad-hoc regex in the extractor loop.
 */

import { isRecord, text } from "../../../core/json.js";

export function isCodexApplyPatchTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "apply_patch" || lower.endsWith("apply_patch");
}

/** Exact Codex shell-tool names (case-insensitive). Additive rows only — no substring matching. */
const CODEX_SHELL_TOOLS = new Set([
  "shell",
  "bash",
  "shell_command",
  "local_shell",
  "exec_command",
  "powershell",
  "pwsh",
  "cmd",
]);

/** Tools that may run host commands; success defaults to unsupported mutation. */
export function isCodexShellTool(name: string): boolean {
  return CODEX_SHELL_TOOLS.has(name.trim().toLowerCase());
}

export type ShellCommandClass =
  | { readonly kind: "static_apply_patch"; readonly patch: string }
  | { readonly kind: "unsupported_mutation" };

/**
 * Only a sole static apply_patch form is trusted. Any other successful shell
 * (python/sed/npm/opaque scripts, or static patch plus co-mutators) is unsupported.
 */
export function classifyShellCommand(command: string): ShellCommandClass {
  const extracted = extractStaticApplyPatchFromExec(command);
  if (extracted.status === "ok" && isSoleStaticApplyPatchCommand(command, extracted.matchedSpan)) {
    return { kind: "static_apply_patch", patch: extracted.patch };
  }
  return { kind: "unsupported_mutation" };
}

export function isFailedToolOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (/^\[error\]/i.test(trimmed)) return true;
  if (/"success"\s*:\s*false/i.test(trimmed)) return true;
  if (/\bexit[_ ]code["']?\s*[:=]\s*(?!0\b)\d+/i.test(trimmed)) return true;
  if (/^(?:Error|ERROR|Failed|failed)\b/.test(trimmed) && !/success/i.test(trimmed)) return true;
  return false;
}

export function commandFromArguments(argumentsText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (!isRecord(parsed)) return undefined;
    return text(parsed.command) ?? text(parsed.cmd);
  } catch {
    // Non-JSON shell arguments: no recoverable command string for static classification.
    return undefined;
  }
}

export function patchTextFromApplyPatchArguments(argumentsText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isRecord(parsed)) return text(parsed.patch) ?? text(parsed.input);
  } catch {
    // Non-JSON apply_patch payload: allow raw text that already embeds *** patch markers.
    if (argumentsText.includes("*** ")) return argumentsText;
  }
  return undefined;
}

type StaticPatchExtract =
  | { readonly status: "ok"; readonly patch: string; readonly matchedSpan: { readonly start: number; readonly end: number } }
  | { readonly status: "absent" }
  | { readonly status: "unsupported" };

/**
 * Only decodes `const name = "..." ; apply_patch(name)` or inline `apply_patch("...")`.
 * Rejects concatenation, templates, function calls, and unbound names.
 */
export function extractStaticApplyPatchFromExec(command: string): StaticPatchExtract {
  if (!/\bapply_patch\s*\(/.test(command)) return { status: "absent" };
  const call = command.match(/\bapply_patch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (!call || call.index === undefined) {
    const inline = command.match(/\bapply_patch\s*\(\s*("(?:\\.|[^"\\])*")\s*\)/);
    if (inline?.[1] && inline.index !== undefined) {
      try {
        return {
          status: "ok",
          patch: JSON.parse(inline[1]) as string,
          matchedSpan: { start: inline.index, end: inline.index + inline[0].length },
        };
      } catch {
        // Double-quoted apply_patch argument is not valid JSON string literal syntax.
        return { status: "unsupported" };
      }
    }
    return { status: "unsupported" };
  }
  const ident = call[1]!;
  const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRegExp(ident)}\s*=\s*("(?:\\.|[^"\\])*")\s*;`);
  const matched = command.match(decl);
  if (!matched?.[1] || matched.index === undefined) return { status: "unsupported" };
  const beforeCall = command.slice(0, call.index);
  const withoutDecl = `${beforeCall.slice(0, matched.index)}${beforeCall.slice(matched.index + matched[0].length)}`;
  if (new RegExp(String.raw`\b${escapeRegExp(ident)}\s*[+=]`).test(withoutDecl)) {
    return { status: "unsupported" };
  }
  try {
    return {
      status: "ok",
      patch: JSON.parse(matched[1]) as string,
      matchedSpan: { start: matched.index, end: call.index + call[0].length },
    };
  } catch {
    // Declared patch initializer is not a JSON-decodable double-quoted string.
    return { status: "unsupported" };
  }
}

/** True when removing the static decl+call leaves only whitespace/semicolons. */
function isSoleStaticApplyPatchCommand(command: string, span: { start: number; end: number }): boolean {
  const remainder = `${command.slice(0, span.start)}${command.slice(span.end)}`;
  return residualIsBenign(remainder);
}

function residualIsBenign(remainder: string): boolean {
  const trimmed = remainder.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim();
  if (!trimmed) return true;
  // Allow a leading const/let/var decl already consumed; residual may only be empty statements.
  return /^[;\s]*$/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
