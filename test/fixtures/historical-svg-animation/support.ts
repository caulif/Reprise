import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Checked-in historical deliverable (self-contained SVG animation HTML). */
export const HISTORICAL_ANIMATION_NAME = "animation.html";

/** Candidate openable HTML (different motion / color from historical). */
export const CANDIDATE_ANIMATION_NAME = "candidate-animation.html";

export const historicalAnimationPath = fileURLToPath(
  new URL("./animation.html", import.meta.url),
);

export const candidateAnimationPath = fileURLToPath(
  new URL("./candidate-animation.html", import.meta.url),
);

export async function readHistoricalAnimationHtml(): Promise<string> {
  return readFile(historicalAnimationPath, "utf8");
}

export async function readCandidateAnimationHtml(): Promise<string> {
  return readFile(candidateAnimationPath, "utf8");
}

/** Codex-style apply_patch body for a full Add File. */
export function addFilePatch(logicalPath: string, content: string): string {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `*** Begin Patch\n*** Add File: ${logicalPath}\n${body}\n*** End Patch\n`;
}

/**
 * Locate a static `const patch = "..."` string literal and decode it with JSON.parse.
 * Fixture contract for B1: product extractors must recover the same bytes without eval.
 */
export function extractStaticPatchLiteral(source: string): string | undefined {
  const marker = "const patch = ";
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  let i = start + marker.length;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  if (source[i] !== "\"") return undefined;
  let end = i + 1;
  let escaped = false;
  for (; end < source.length; end += 1) {
    const ch = source[end]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") break;
  }
  if (end >= source.length) return undefined;
  try {
    return JSON.parse(source.slice(i, end + 1)) as string;
  } catch {
    return undefined;
  }
}

function parseJsonlRows(rolloutText: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of rolloutText.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Fixture helper: skip malformed lines; product parsers have their own lenient path.
    }
  }
  return rows;
}

function toolArgumentsJson(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Decode exec-wrapped rollout → `node -e` source → static `const patch` literal. */
export function recoverExecWrappedPatchFromRollout(rolloutText: string): string | undefined {
  for (const row of parseJsonlRows(rolloutText)) {
    if (row.type !== "response_item") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "function_call" || payload.name !== "shell_command") continue;
    const argumentsJson = toolArgumentsJson(payload.arguments);
    if (argumentsJson === undefined) continue;
    let args: { command?: string };
    try {
      args = JSON.parse(argumentsJson) as { command?: string };
    } catch {
      continue;
    }
    const command = args.command ?? "";
    const prefix = "node -e ";
    if (!command.startsWith(prefix)) continue;
    let execSource: string;
    try {
      execSource = JSON.parse(command.slice(prefix.length)) as string;
    } catch {
      continue;
    }
    const patch = extractStaticPatchLiteral(execSource);
    if (patch) return patch;
  }
  return undefined;
}

/** Decode direct apply_patch rollout arguments.patch. */
export function recoverDirectApplyPatchFromRollout(rolloutText: string): string | undefined {
  for (const row of parseJsonlRows(rolloutText)) {
    if (row.type !== "response_item") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "function_call" || payload.name !== "apply_patch") continue;
    const argumentsJson = toolArgumentsJson(payload.arguments);
    if (argumentsJson === undefined) continue;
    try {
      const args = JSON.parse(argumentsJson) as { patch?: string };
      if (typeof args.patch === "string" && args.patch.length > 0) return args.patch;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function buildExecWrappedRollout(input: {
  sessionId: string;
  cwd: string;
  patch: string;
  commit?: string;
}): string {
  const commit = input.commit ?? "a".repeat(40);
  const patchLiteral = JSON.stringify(input.patch);
  const execSource = [
    "const { apply_patch } = require('codex');",
    `const patch = ${patchLiteral};`,
    "apply_patch(patch);",
  ].join("\n");
  const command = `node -e ${JSON.stringify(execSource)}`;
  const lines = [
    {
      timestamp: "2026-09-19T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: input.sessionId,
        cwd: input.cwd,
        cli_version: "0.1.0",
        git: { commit },
      },
    },
    {
      timestamp: "2026-09-19T00:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6" },
    },
    {
      timestamp: "2026-09-19T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Generate a self-contained SVG animation HTML file named animation.html. Start from an empty directory.",
      },
    },
    {
      timestamp: "2026-09-19T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-exec-1",
        name: "shell_command",
        arguments: JSON.stringify({ command }),
      },
    },
    {
      timestamp: "2026-09-19T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-exec-1",
        output: "Success. Updated the following files:\nM animation.html\n",
      },
    },
    {
      timestamp: "2026-09-19T00:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Delivered animation.html with a self-contained SVG bounce animation.",
      },
    },
    {
      timestamp: "2026-09-19T00:00:06.000Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export function buildDirectApplyPatchRollout(input: {
  sessionId: string;
  cwd: string;
  patch: string;
  commit?: string;
}): string {
  const commit = input.commit ?? "b".repeat(40);
  const lines = [
    {
      timestamp: "2026-09-19T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: input.sessionId,
        cwd: input.cwd,
        cli_version: "0.1.0",
        git: { commit },
      },
    },
    {
      timestamp: "2026-09-19T01:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6" },
    },
    {
      timestamp: "2026-09-19T01:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Generate a self-contained SVG animation HTML file named animation.html. Start from an empty directory.",
      },
    },
    {
      timestamp: "2026-09-19T01:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-patch-1",
        name: "apply_patch",
        arguments: JSON.stringify({ patch: input.patch }),
      },
    },
    {
      timestamp: "2026-09-19T01:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-patch-1",
        output: "Success. Updated the following files:\nA animation.html\n",
      },
    },
    {
      timestamp: "2026-09-19T01:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Delivered animation.html with a self-contained SVG bounce animation.",
      },
    },
    {
      timestamp: "2026-09-19T01:00:06.000Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** Two distinct 1×1 PNGs for fake renderer assertions. */
export const BASELINE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const CANDIDATE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
