import { appendFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  ControllerExternalWritePayloadSchema,
  ControllerReadArtifactSchema,
  ControllerWorkspaceWritePayloadSchema,
  type RecoveryControlledWrite,
} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import { asPosixPath, isFsAbsolute, pathContainedBy } from "../core/paths.js";
import { CONTROLLER_NOTES_MOUNT, CONTROLLER_PROJECT_MOUNT } from "./controller-briefing.js";
import { observationReadRecord } from "./controller-request.js";
import type { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { workspaceTools } from "../infrastructure/recovery-tools.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

const SHELL_WRITE_LIKE =
  /\b(Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|rmdir|\brm\b|\bdel\b|\brd\b)\b|>>?/;

export type ControllerEvidenceSource = "briefing_read" | "workspace_read" | "external_read" | "shell_observation";

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
  return (parts[0] === CONTROLLER_PROJECT_MOUNT || parts[0] === CONTROLLER_NOTES_MOUNT) && parts.length > 1;
}

export function controllerReadEvidenceSource(
  path: string,
  bindings: ControllerToolBindings,
  replicaRoot?: string,
): ControllerEvidenceSource {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === CONTROLLER_PROJECT_MOUNT || normalized.startsWith(`${CONTROLLER_PROJECT_MOUNT}/`)) {
    return "workspace_read";
  }
  if (replicaRoot && isFsAbsolute(path) && pathContainedBy(replicaRoot, resolve(path))) return "workspace_read";
  const latest = `run/turns/${String(bindings.settledTurnCount).padStart(4, "0")}/`;
  if (normalized.startsWith(latest) && /\/(visible\.txt|events\.jsonl)$/.test(normalized)) {
    return "workspace_read";
  }
  if (isFsAbsolute(path) || normalized.startsWith("//")) return "external_read";
  return "briefing_read";
}

export function controllerDecisionTools(
  input: {
    store: ExperimentStore;
    runId: string;
    experimentRoot: string;
    environment: { root: string };
    sourceRoot?: string;
    taskCase: { privacy: { allowBinary: boolean } };
  },
  briefingRoot: string,
  bindings: ControllerToolBindings,
): readonly AgentToolDefinition[] {
  return workspaceTools(briefingRoot, {
    role: "controller",
    allowBinary: input.taskCase.privacy.allowBinary,
    allowShell: true,
    unrestrictedRead: true,
    shellCwd: input.environment.root,
    homeRoot: join(input.experimentRoot, ".reprise-controller-home"),
    mounts: { [CONTROLLER_PROJECT_MOUNT]: input.environment.root },
    writableMounts: [CONTROLLER_PROJECT_MOUNT],
    allowWrite: controllerProjectWriteAllowed,
    denyDestructiveOnPrefix: input.sourceRoot ? [input.sourceRoot] : [],
    onControlledWrite: (entry) => persistControllerWorkspaceWrite(input, briefingRoot, bindings, entry),
  }).map((tool) => {
    if (tool.name === "read") return wrapControllerRead(input, bindings, tool);
    if (tool.name === "shell_exec") return wrapControllerShell(input, briefingRoot, bindings, tool);
    return tool;
  });
}

function wrapControllerRead(
  input: { store: ExperimentStore; runId: string; environment: { root: string } },
  bindings: ControllerToolBindings,
  tool: AgentToolDefinition,
): AgentToolDefinition {
  return {
    ...tool,
    execute: async (params, signal) => {
      const result = await tool.execute(params, signal);
      await persistControllerRead(input, bindings, result);
      return result;
    },
  };
}

async function persistControllerRead(
  input: { store: ExperimentStore; runId: string; environment: { root: string } },
  bindings: ControllerToolBindings,
  result: AgentToolResult,
): Promise<void> {
  const details = result.details as { path?: string; available?: boolean; offset?: number } | undefined;
  if (!details?.available || !details.path || !result.content.length) return;
  const source = controllerReadEvidenceSource(details.path, bindings, input.environment.root);
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
  result.details = { ...details, runId: input.runId, evidenceRefs, resultHash: sha256(bytes) };
  await input.store.append(observationReadRecord({
    requestId: bindings.requestId,
    runId: input.runId,
    details: { runId: input.runId, source, evidenceRefs },
    allowedRefs: new Set(evidenceRefs),
  }));
}

function wrapControllerShell(
  input: { store: ExperimentStore; runId: string; environment: { root: string } },
  briefingRoot: string,
  bindings: ControllerToolBindings,
  tool: AgentToolDefinition,
): AgentToolDefinition {
  return {
    ...tool,
    execute: async (params, signal) => {
      const command = typeof (params as { command?: unknown }).command === "string"
        ? (params as { command: string }).command
        : "";
      const result = await tool.execute(params, signal);
      await persistShellObservation(input, bindings, result);
      await persistControllerExternalWrites(input, briefingRoot, bindings, command);
      return result;
    },
  };
}

async function persistShellObservation(
  input: { store: ExperimentStore; runId: string },
  bindings: ControllerToolBindings,
  result: AgentToolResult,
): Promise<void> {
  const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const observation = {
    command: typeof details.command === "string" ? details.command : "[REDACTED]",
    cwd: ".",
    exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
    stdoutBytes: typeof details.stdoutBytes === "number" ? details.stdoutBytes : 0,
    stderrBytes: typeof details.stderrBytes === "number" ? details.stderrBytes : 0,
    truncated: details.truncated === true,
    resultHash: sha256(result.content),
  };
  const bytes = Buffer.from(JSON.stringify(observation));
  const artifactId = `controller-shell-${sha256(bytes).slice(0, 32)}`;
  await input.store.commitArtifact({ artifactId, runId: input.runId, kind: "controller_observation", mediaType: "application/json", bytes });
  const evidenceRefs = [`artifact:${artifactId}`];
  result.details = { ...details, runId: input.runId, evidenceRefs, resultHash: observation.resultHash };
  await input.store.append(observationReadRecord({
    requestId: bindings.requestId,
    runId: input.runId,
    details: { runId: input.runId, source: "shell_observation", evidenceRefs },
    allowedRefs: new Set(evidenceRefs),
  }));
}

async function persistControllerExternalWrites(
  input: { store: ExperimentStore; runId: string; environment: { root: string } },
  briefingRoot: string,
  bindings: ControllerToolBindings,
  command: string,
): Promise<void> {
  if (!SHELL_WRITE_LIKE.test(command)) return;
  const commandDigest = sha256(command);
  for (const entry of shellExternalWriteRefs(command, input.environment.root, briefingRoot)) {
    const payload = {
      schemaVersion: 1 as const,
      requestId: bindings.requestId,
      runId: input.runId,
      tool: "shell_exec" as const,
      pathClass: entry.pathClass,
      pathRef: entry.pathRef,
      commandDigest,
    };
    if (!Value.Check(ControllerExternalWritePayloadSchema, payload)) throw new Error("Controller external write payload is malformed.");
    await input.store.append({
      type: "controller.external_write",
      runId: input.runId,
      operationId: `${bindings.requestId}-ext-${sha256(JSON.stringify(payload)).slice(0, 16)}`,
      payload,
    });
  }
}

export function shellExternalWriteRefs(
  command: string,
  replicaRoot: string,
  briefingRoot: string,
): { pathClass: "absolute" | "unc" | "wsl"; pathRef: string }[] {
  const refs: { pathClass: "absolute" | "unc" | "wsl"; pathRef: string }[] = [];
  const seen = new Set<string>();
  for (const token of shellPathTokens(command)) {
    if (!isFsAbsolute(token) && !asPosixPath(token).startsWith("//")) continue;
    const absolute = resolve(token);
    if (pathContainedBy(replicaRoot, absolute) || pathContainedBy(briefingRoot, absolute)) continue;
    const pathRef = redactPathRef(token);
    if (seen.has(pathRef)) continue;
    seen.add(pathRef);
    refs.push({ pathClass: classifyExternalPath(token), pathRef });
  }
  return refs;
}

function shellPathTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const inner = match[1] ?? match[2];
    if (inner) tokens.push(inner);
  }
  for (const match of command.matchAll(/[A-Za-z]:\\[^\s"'`]+|\\\\[^\s"'`]+/g)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function classifyExternalPath(path: string): "absolute" | "unc" | "wsl" {
  const posix = asPosixPath(path);
  if (/^\/\/wsl/i.test(posix) || /^\/mnt\/[a-zA-Z](\/|$)/.test(posix)) return "wsl";
  if (posix.startsWith("//")) return "unc";
  return "absolute";
}

function redactPathRef(path: string): string {
  const name = basename(path).toLowerCase();
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "auth.json" ||
    name.includes("credential") ||
    /\.(pem|key|p12|pfx)$/.test(name)
  ) {
    return "<credential-file>";
  }
  return path.slice(0, 512);
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
