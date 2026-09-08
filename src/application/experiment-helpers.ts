import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isRecord } from "../core/json.js";
import { SAFE_ID, sha256 } from "../core/identity.js";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import type { AgentAuditSink, StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import { type ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { isFrozenCase, publishFrozenCase } from "../products/shared/freeze.js";
import { spillImageRefs, spillInlineBody, type ArtifactBodyResolver } from "../infrastructure/agent-model-input.js";

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
      ...(result.invocationId ? { invocationId: result.invocationId } : {}),
      value: result.value,
    };
  return {
    status: result.status,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.invocationId ? { invocationId: result.invocationId } : {}),
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

export async function sourceDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function persistTaskCase(path: string, taskCase: TaskCase): Promise<void> {
  const caseDir = dirname(path);
  const casesRoot = dirname(caseDir);
  if (await isFrozenCase(caseDir)) {
    const persisted = JSON.parse(await readFile(path, "utf8")) as Partial<TaskCase>;
    if (persisted.caseId !== taskCase.caseId || persisted.contentHash !== taskCase.contentHash)
      throw new Error(`TaskCase ${taskCase.caseId} conflicts with existing immutable content.`);
    return;
  }
  try {
    await stat(caseDir);
  } catch (error) {
    if (isMissing(error)) {
      await publishFrozenCase({ taskCase, casesRoot, files: [] });
      return;
    }
    throw error;
  }
  throw new Error(`TaskCase ${taskCase.caseId} is an unpublished incomplete freeze.`);
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

export async function persistAgentAuditEvent(store: ExperimentStore, runId: string, event: Parameters<AgentAuditSink["append"]>[0]): Promise<void> {
  const write = modelInputWriter(store, runId);
  const payload: Record<string, unknown> = { role: event.role, sessionId: event.sessionId, ...event.payload };
  if ("body" in payload) payload.body = await spillInlineBody(payload.body, write);
  if ("retainedTail" in payload) payload.retainedTail = await spillInlineBody(payload.retainedTail, write);
  if ("images" in payload) payload.images = await spillImageRefs(payload.images, write);
  await store.append({
    type: event.type,
    runId,
    payload,
  });
}

export function experimentModelInputResolver(store: ExperimentStore, runId: string): ArtifactBodyResolver {
  return async (ref) => {
    try {
      return Buffer.from(await store.readArtifact({
        artifactId: ref.artifactId,
        experimentId: store.experimentId,
        runId,
      })).toString("utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Model input artifact is missing.";
      const missing = isMissing(error);
      throw Object.assign(new Error(message), {
        diagnostic: {
          code: missing ? "missing_attachment" as const : "attachment_checksum" as const,
          message,
          artifactId: ref.artifactId,
        },
      });
    }
  };
}

export function experimentAgentAuditSink(store: ExperimentStore, runId: string): AgentAuditSink {
  return {
    append: async (event) => persistAgentAuditEvent(store, runId, event),
    commitModelInput: modelInputWriter(store, runId),
  };
}

function modelInputWriter(store: ExperimentStore, runId: string) {
  return async (bytes: Uint8Array) => store.commitArtifact({
    artifactId: `mi${sha256(bytes).slice(0, 16)}`,
    runId,
    kind: "agent_model_input",
    bytes,
  });
}
