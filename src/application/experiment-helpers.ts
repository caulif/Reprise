import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRecord } from "../core/json.js";
import { SAFE_ID } from "../core/identity.js";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import type { AgentAuditSink, StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import { writeImmutableJson, type ExperimentStore } from "../infrastructure/store/experiment-store.js";

export function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function invocationFact<T>(
  result: StructuredAgentResult<T>,
): Record<string, unknown> {
  if (result.status === "completed")
    return {
      status: result.status,
      sessionId: result.sessionId,
      value: result.value,
    };
  return {
    status: result.status,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" && result.factRef
      ? { factRef: result.factRef }
      : {}),
  };
}

export function assertPaths(dataDir: string, sourceRoot: string): void {
  if (!isAbsolute(dataDir) || !isAbsolute(sourceRoot))
    throw new Error(
      "Codex experiments require absolute data and source paths.",
    );
}

export function assertIds(input: {
  caseId: string;
  experimentId: string;
  runId: string;
}): void {
  for (const [label, value] of [
    ["caseId", input.caseId],
    ["experimentId", input.experimentId],
    ["runId", input.runId],
  ] as const) {
    if (!SAFE_ID.test(value))
      throw new Error(`${label} must be a safe identifier.`);
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function persistTaskCase(path: string, taskCase: TaskCase): Promise<void> {
  try {
    const persisted = JSON.parse(await readFile(path, "utf8")) as Partial<TaskCase>;
    if (persisted.caseId !== taskCase.caseId || persisted.contentHash !== taskCase.contentHash)
      throw new Error(`TaskCase ${taskCase.caseId} conflicts with existing immutable content.`);
  } catch (error) {
    if (isMissing(error)) await writeImmutableJson(path, taskCase);
    else throw error;
  }
}

export function totalTokenCount(
  events: readonly EventEnvelope[],
): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (!event.type.includes("token_count")) continue;
    const value = tokenValue(event.payload);
    if (value !== undefined) latest = value;
  }
  return latest;
}

function tokenValue(value: unknown): number | undefined {
  const payload = recordValue(value);
  const containers = [
    payload,
    recordValue(payload.info),
    recordValue(payload.usage),
    recordValue(recordValue(payload.info).total_token_usage),
  ];
  for (const container of containers)
    for (const key of [
      "totalTokens",
      "total_tokens",
      "tokenCount",
      "token_count",
    ])
      if (
        Number.isSafeInteger(container[key]) &&
        (container[key] as number) >= 0
      )
        return container[key] as number;
  return undefined;
}

export function experimentAgentAuditSink(store: ExperimentStore, runId: string): AgentAuditSink {
  return {
    append: async (event) => {
      await store.append({
        type: event.type,
        runId,
        payload: { role: event.role, sessionId: event.sessionId, ...event.payload },
      });
    },
  };
}
