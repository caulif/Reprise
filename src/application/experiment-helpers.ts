import { readTaskCase, taskCaseOrigin } from '../products/shared/task-case-reader.js';
import { canonicalJson, validateTaskCase } from '../core/task-case-identity.js';
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../core/json.js";
import { SAFE_ID, sha256 } from "../core/identity.js";
import type { TaskCase } from "../core/schema.js";
import type { AgentAuditSink, StructuredAgentResult } from "../infrastructure/agent/host.js";
import { type ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { publishFrozenCase } from "../products/shared/freeze.js";
import { spillImageRefs, spillInlineBody, type ArtifactBodyResolver } from "../infrastructure/agent/model-input.js";

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
  validateTaskCase(taskCase);
  const caseDir = dirname(path);
  const casesRoot = dirname(caseDir);
  try {
    await stat(caseDir);
    const existing = await readTaskCase(path, { expectedCaseId: taskCase.caseId, requireComplete: true });
    const normalized = { ...existing, provenance: { ...existing.provenance, importedAt: taskCase.provenance.importedAt } };
    if (existing.schemaVersion === 2 ? existing.contentHash !== taskCase.contentHash : canonicalJson(normalized) !== canonicalJson(taskCase)) {
      throw new Error(`TaskCase ${taskCase.caseId} conflicts with existing immutable content.`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A missing target directory is creatable; missing files inside an existing case are preserved as incomplete evidence.
    try { await stat(caseDir); } catch (missingDirectory) {
      if (!isMissing(missingDirectory)) throw missingDirectory;
      const origin = taskCaseOrigin(taskCase);
      const files = (taskCase.freezeIdentity?.files ?? []).map((file) => {
        if (!origin) throw new Error('Frozen TaskCase files need a verified source directory before copying.');
        return { relativePath: file.relativePath, copyFrom: join(origin, file.relativePath) };
      });
      await publishFrozenCase({ taskCase, casesRoot, files, reuseExisting: true });
      return;
    }
    throw new Error(`TaskCase ${taskCase.caseId} is an unpublished incomplete freeze.`, { cause: error });
  }
}

export async function persistAgentAuditEvent(store: ExperimentStore, runId: string, event: Parameters<AgentAuditSink["append"]>[0]): Promise<void> {
  const write = modelInputWriter(store, runId);
  const payload: Record<string, unknown> = { role: event.role, sessionId: event.sessionId, ...event.payload };
  if ("body" in payload) payload.body = await spillInlineBody(payload.body, write);
  if ("retainedTail" in payload) payload.retainedTail = await spillInlineBody(payload.retainedTail, write);
  if ("compactionInput" in payload) payload.compactionInput = await spillInlineBody(payload.compactionInput, write);
  if ("generationInput" in payload) payload.generationInput = await spillInlineBody(payload.generationInput, write);
  if ("images" in payload) payload.images = await spillImageRefs(payload.images, write);
  await store.append({
    type: event.type,
    runId,
    payload,
  });
}

export function experimentModelInputResolver(store: Pick<ExperimentStore, 'experimentId' | 'readArtifact'>, runId?: string): ArtifactBodyResolver & { image: (ref: { artifactId: string }) => Promise<Uint8Array> } {
  const image = async (ref: { artifactId: string }) => {
    try {
      return await store.readArtifact({
        artifactId: ref.artifactId,
        experimentId: store.experimentId,
        ...(runId ? { runId } : {}),
      });
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
  const text: ArtifactBodyResolver = async (ref) => Buffer.from(await image(ref)).toString('utf8');
  return Object.assign(text, { image });
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
