import { record, text } from "../../core/json.js";
import type { PublicLiveActivity } from "../../core/schema.js";

type Verb = PublicLiveActivity["verb"];

export function liveFromClaudeToolUse(name: string, input: unknown, callId?: string): {
  live: PublicLiveActivity;
  callId?: string;
} {
  const live = publicLive(claudeVerb(name), leafFromInput(record(input)));
  return { live, ...(callId ? { callId } : {}) };
}

export function liveFromCodexItem(item: unknown): PublicLiveActivity | undefined {
  const body = record(item);
  const kind = text(body.type);
  if (!kind || kind === "reasoning" || kind === "agentMessage" || kind === "userMessage") return undefined;
  return publicLive(codexVerb(kind), leafFromInput(body) ?? leafFromInput(record(body.command)) ?? text(body.command));
}

function publicLive(verb: Verb, leaf?: string): PublicLiveActivity {
  const trimmed = leaf?.trim().slice(0, 80);
  return {
    schemaVersion: 1,
    verb,
    ...(trimmed ? { leaf: trimmed } : {}),
  };
}

function claudeVerb(name: string): Verb {
  if (name === "Read") return "read";
  if (name === "Bash") return "run";
  if (name === "Write") return "write";
  if (name === "Edit") return "edit";
  return "inspect";
}

function codexVerb(kind: string): Verb {
  if (kind === "command_execution" || kind === "commandExecution") return "run";
  if (kind === "file_change" || kind === "fileChange") return "edit";
  return "inspect";
}

function leafFromInput(input: Record<string, unknown>): string | undefined {
  const path = text(input.path) ?? text(input.file_path) ?? text(input.filePath);
  if (path) return leafName(path);
  const command = text(input.command);
  if (command) return leafName(command.trim().split(/\s+/)[0] ?? command);
  return undefined;
}

function leafName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return (base || path).slice(0, 80);
}
