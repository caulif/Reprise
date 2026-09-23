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

/** The observed custom exec wrapper is accepted only as one literal patch call. */
export function classifyCustomExec(input: string): ShellCommandClass | { readonly kind: "no_write_evidence" } {
  const literal = String.raw`("(?:\\.|[^"\\])*")`;
  const call = new RegExp(String.raw`^\s*const\s+patch\s*=\s*${literal}\s*;\s*const\s+r\s*=\s*await\s+tools\.apply_patch\(patch\)\s*;\s*text\(r\)\s*;?\s*$`);
  const match = input.match(call);
  if (match?.[1]) {
    try {
      const patch: unknown = JSON.parse(match[1]);
      if (typeof patch === "string" && /^\*\*\* Begin Patch\r?\n/.test(patch)
        && /\r?\n\*\*\* End Patch\r?\n?$/.test(patch)
        && patch.indexOf("*** Begin Patch", 1) === -1
        && patch.indexOf("*** End Patch") === patch.lastIndexOf("*** End Patch")) {
        return { kind: "static_apply_patch", patch };
      }
    } catch {
      // Invalid string literal cannot establish patch bytes.
    }
  }
  return isProvenReadOnlyCustomExec(input)
    ? { kind: "no_write_evidence" }
    : { kind: "unsupported_mutation" };
}

function isProvenReadOnlyCustomExec(input: string): boolean {
  const literal = String.raw`("(?:\\.|[^"\\])*")`;
  const wrapper = new RegExp(String.raw`^\s*const\s+r\s*=\s*await\s+tools\.exec_command\(\{\s*cmd:\s*${literal}(?:\s*,\s*workdir:\s*${literal})?\s*\}\)\s*;\s*text\(r\.output\)\s*;?\s*$`);
  const match = input.match(wrapper);
  if (!match?.[1]) return false;
  try {
    const command: unknown = JSON.parse(match[1]);
    if (match[2] && typeof JSON.parse(match[2]) !== "string") return false;
    return typeof command === "string" && isProvenReadOnlyPowerShell(command);
  } catch {
    // The wrapper has no statically decodable command or workdir string.
    return false;
  }
}

function isProvenReadOnlyPowerShell(command: string): boolean {
  if (command === "Get-ChildItem -Force | Select-Object Mode,Length,Name") return true;
  if (/^Get-ChildItem(?: -Force)?$/.test(command)) return true;
  if (/^Get-Content [A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return true;
  const file = command.match(/^\$p = Join-Path \(Get-Location\) '([A-Za-z0-9][A-Za-z0-9._-]*)'/)?.[1];
  if (!file) return false;
  return command === `$p = Join-Path (Get-Location) '${file}'; $s = Get-Content -Raw -LiteralPath $p; [pscustomobject]@{Exists=(Test-Path -LiteralPath $p); Bytes=(Get-Item -LiteralPath $p).Length; HtmlOpen=([regex]::Matches($s,'<html').Count); SvgOpen=([regex]::Matches($s,'<svg').Count); SvgClose=([regex]::Matches($s,'</svg>').Count); AnimationRules=([regex]::Matches($s,'@keyframes').Count); ToggleScript=($s -match 'toggleAnimation') } | Format-List`;
}

export function isSuccessfulCustomExecOutput(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const first: unknown = value[0];
  const second: unknown = value[1];
  return isRecord(first) && isRecord(second)
    && first.type === "input_text" && second.type === "input_text"
    && /^Script completed\r?\nWall time [^\r\n]+\r?\nOutput:\r?\n$/.test(text(first.text) ?? "")
    && (text(second.text) ?? "").trim() === "{}";
}

export function isFailedCustomExecOutput(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => isRecord(item) && typeof item.text === "string" && /^Script failed\b|^\[error\]/i.test(item.text));
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
