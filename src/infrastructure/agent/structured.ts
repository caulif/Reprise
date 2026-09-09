import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { sha256 } from "../../core/identity.js";
import type { FreeformWorkRequest, StructuredWorkRequest } from "./types.js";

type PromptRequest<T> = ({ kind: "freeform" } & FreeformWorkRequest) | ({ kind: "structured" } & StructuredWorkRequest<T>);

export function promptBody<T>(request: PromptRequest<T>, attempts: number, lastError: string | undefined): string {
  if (request.kind === "freeform") return request.promptContent;
  const context = request.promptContent ?? JSON.stringify(request.context);
  const contract = request.outputContract ? `${request.outputContract.trim()}\n\n` : "";
  if (!attempts) return `${contract}${context}`;
  const reason = lastError ? ` (${lastError})` : "";
  const repair = request.repairInstruction ? ` ${request.repairInstruction.trim()}` : "";
  return `${contract}Your prior response was invalid${reason}. Return only JSON matching the contract.${repair}\n\n${context}`;
}

export function decodeStructured(
  schema: TSchema,
  text: string,
  normalize?: (value: unknown) => unknown,
): { value?: unknown; error?: string } {
  const parsed = parseStructuredJson(text);
  if (parsed === undefined) return { error: "invalid JSON" };
  const prepared = normalize ? normalize(parsed) : parsed;
  const cleaned = Value.Clean(schema, prepared);
  if (Value.Check(schema, cleaned)) return { value: cleaned };
  const first = Value.Errors(schema, cleaned).First();
  const path = first?.path || "/";
  const message = first?.message || "failed";
  return { error: `schema validation failed at ${path}: ${message}` };
}

export function invalidOutputCategory(error: string): string {
  if (/^RECOVERY_UNKNOWN_REF:/.test(error)) return "recovery_unknown_ref";
  if (/^RECOVERY_/.test(error)) return "recovery_contract";
  if (/^schema validation failed/.test(error)) return "schema_validation";
  if (error === "invalid JSON") return "invalid_json";
  return "validator_rejected";
}

export function invalidOutputAudit(error: string, attempts: number, value: unknown): Record<string, unknown> {
  const refs = value && typeof value === "object" && Array.isArray((value as { evidenceRefs?: unknown }).evidenceRefs)
    ? (value as { evidenceRefs: unknown[] }).evidenceRefs.filter((ref): ref is string => typeof ref === "string")
    : [];
  return {
    category: invalidOutputCategory(error),
    attempts,
    evidenceRefCount: refs.length,
    evidenceRefsHash: sha256([...refs].sort().join("\0")),
  };
}

function parseStructuredJson(text: string): unknown {
  const stripped = stripThinkBlocks(text.trim());
  const candidates = [stripJsonFence(stripped), ...balancedJsonObjects(stripped)];
  let last: unknown;
  let found = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      last = JSON.parse(candidate) as unknown;
      found = true;
    } catch {
      /* keep scanning; the last successful object wins */
    }
  }
  return found ? last : undefined;
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const span = sliceBalancedObject(text, index);
    if (span) objects.push(span);
  }
  return objects;
}

function sliceBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function stripJsonFence(text: string): string {
  const whole = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/.exec(text);
  if (whole?.[1]) return whole[1];
  const embedded = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```/.exec(text);
  return embedded?.[1] ?? text;
}
