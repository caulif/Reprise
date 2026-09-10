import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ControllerReadArtifactSchema, ControllerWorkspaceWritePayloadSchema, type RecoveryControlledWrite } from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import { CONTROLLER_PROJECT_MOUNT } from "./controller-briefing.js";
import { observationReadRecord } from "./controller-request.js";
import type { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

const BRIEFING_READ_FILES = new Set([
  "INDEX.md",
  "permissions.txt",
  "replay.txt",
  "current-user-view.md",
  "project-root.txt",
  "manifest.json",
  "THIS-TURN.txt",
  "run/sent-user-messages.jsonl",
]);

export type ControllerToolBindings = {
  requestId: string;
  phase: "opening" | "steering";
  changedPaths: readonly string[];
  settledTurnCount: number;
};

export function createControllerToolBindings(): ControllerToolBindings {
  return { requestId: "", phase: "opening", changedPaths: [], settledTurnCount: 0 };
}

export function controllerProjectWriteAllowed(relativePath: string): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts[0] === CONTROLLER_PROJECT_MOUNT && parts.length > 1;
}

export function controllerReadEvidenceSource(
  path: string,
  bindings: ControllerToolBindings,
): "briefing_read" | "workspace_read" | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("history/") || BRIEFING_READ_FILES.has(normalized)) return "briefing_read";
  if (bindings.phase === "opening") return undefined;
  const projectPrefix = `${CONTROLLER_PROJECT_MOUNT}/`;
  const changed = bindings.changedPaths.some((entry) => normalized === `${projectPrefix}${entry.replaceAll("\\", "/")}`);
  const latest = `run/turns/${String(bindings.settledTurnCount).padStart(4, "0")}/`;
  const turnFile = normalized.startsWith(latest) && /\/(visible\.txt|events\.jsonl)$/.test(normalized);
  if (changed || turnFile) return "workspace_read";
  return undefined;
}

export function controllerDecisionTools(
  input: {
    store: ExperimentStore;
    runId: string;
    experimentRoot: string;
    environment: { root: string };
    taskCase: { privacy: { allowBinary: boolean } };
  },
  briefingRoot: string,
  bindings: ControllerToolBindings,
): readonly AgentToolDefinition[] {
  return recoveryTools(briefingRoot, {
    allowBinary: input.taskCase.privacy.allowBinary,
    homeRoot: join(input.experimentRoot, ".reprise-controller-home"),
    mounts: { [CONTROLLER_PROJECT_MOUNT]: input.environment.root },
    writableMounts: [CONTROLLER_PROJECT_MOUNT],
    allowWrite: controllerProjectWriteAllowed,
    onControlledWrite: (entry) => persistControllerWorkspaceWrite(input, briefingRoot, bindings, entry),
  }).map((tool) => (tool.name === "read" ? wrapControllerRead(input, bindings, tool) : tool));
}

function wrapControllerRead(
  input: { store: ExperimentStore; runId: string },
  bindings: ControllerToolBindings,
  tool: AgentToolDefinition,
): AgentToolDefinition {
  return {
    ...tool,
    onCompleted: async (result: AgentToolResult) => {
      const details = result.details as { path?: string; available?: boolean; offset?: number } | undefined;
      if (!details?.available || !details.path || !result.content.length) return;
      const source = controllerReadEvidenceSource(details.path, bindings);
      if (!source) return;
      const observation = {
        path: details.path,
        offset: details.offset ?? 0,
        content: result.content,
        ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
      };
      if (!Value.Check(ControllerReadArtifactSchema, observation)) throw new Error("Controller read artifact is malformed.");
      const bytes = Buffer.from(JSON.stringify(observation));
      const artifactId = `controller-read-${sha256(bytes).slice(0, 32)}`;
      await input.store.commitArtifact({ artifactId, runId: input.runId, kind: "controller_observation", mediaType: "application/json", bytes });
      const evidenceRefs = [`artifact:${artifactId}`];
      result.details = { ...details, runId: input.runId, evidenceRefs };
      await input.store.append(observationReadRecord({
        requestId: bindings.requestId,
        runId: input.runId,
        details: { runId: input.runId, source, evidenceRefs },
        allowedRefs: new Set(evidenceRefs),
      }));
    },
  };
}

async function persistControllerWorkspaceWrite(
  input: { store: ExperimentStore; runId: string },
  briefingRoot: string,
  bindings: ControllerToolBindings,
  entry: RecoveryControlledWrite,
): Promise<void> {
  if (entry.phase !== "after") return;
  const tool = entry.tool === "edit" || entry.tool === "write" ? entry.tool : undefined;
  if (!tool) return;
  const payload = { schemaVersion: 1 as const, requestId: bindings.requestId, runId: input.runId, tool, path: entry.path };
  if (!Value.Check(ControllerWorkspaceWritePayloadSchema, payload)) throw new Error("Controller workspace write payload is malformed.");
  await input.store.append({
    type: "controller.workspace_write",
    runId: input.runId,
    operationId: `${bindings.requestId}-write-${sha256(JSON.stringify(payload)).slice(0, 16)}`,
    payload,
  });
  await appendFile(join(briefingRoot, "run", "controller-writes.jsonl"), `${JSON.stringify(payload)}\n`);
}
