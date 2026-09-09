import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { join, resolve } from "node:path";
import { RecoveryControlledWriteSchema, type RecoveryControlledWrite } from "../../core/schema.js";
import { sha256 } from "../../core/identity.js";
import { relativeInside } from "../../core/paths.js";
import type { RecoveryStaging } from "../../environment/local-workspace-provider.js";
import { ExperimentStore } from "../../infrastructure/store/experiment-store.js";

/** Stores direct-write postimages as immutable artifacts; journal events only carry their content address. */
export async function persistRecoveryControlledWriteBlob(
  store: ExperimentStore,
  candidateRoot: string,
  entry: RecoveryControlledWrite,
  binding: { checkpointId?: string; baseDigest: string },
): Promise<RecoveryControlledWrite> {
  const origin = entry.tool === "rename_file"
    ? "agent_direct_move"
    : entry.tool === "delete_file"
      ? "agent_direct_delete"
      : "agent_direct_write";
  const attributedEntry = { ...entry, ...binding, origin } as RecoveryControlledWrite;
  if (entry.phase !== "after" || !entry.after) {
    if (!Value.Check(RecoveryControlledWriteSchema, attributedEntry))
      throw new Error("Recovery controlled-write attribution is invalid.");
    return attributedEntry;
  }
  const absolutePath = recoveryCandidatePath(candidateRoot, entry.path);
  const bytes = await readFile(absolutePath);
  if (
    bytes.byteLength !== entry.after.size ||
    sha256(bytes) !== entry.after.contentHash
  )
    throw new Error(
      `Recovery controlled-write postimage changed before artifact capture: ${entry.path}.`,
    );
  const artifactId = `recovery-blob-${entry.after.contentHash}`;
  const artifact = await store.commitArtifact({
    artifactId,
    kind: "recovery_controlled_write_blob",
    mediaType: "application/octet-stream",
    bytes,
    operationId: `recovery-blob-${entry.after.contentHash.slice(0, 16)}`,
  });
  if (
    artifact.contentHash !== entry.after.contentHash ||
    artifact.byteLength !== entry.after.size
  )
    throw new Error("Recovery controlled-write blob artifact integrity mismatch.");
  const persisted = {
    ...attributedEntry,
    after: { ...entry.after, artifactId },
  };
  if (!Value.Check(RecoveryControlledWriteSchema, persisted))
    throw new Error("Persisted Recovery controlled-write blob entry is invalid.");
  return persisted;
}

function recoveryCandidatePath(candidateRoot: string, relativePath: string): string {
  const absolutePath = resolve(candidateRoot, relativePath);
  const pathFromRoot = relativeInside(candidateRoot, absolutePath);
  if (pathFromRoot === undefined || pathFromRoot === "")
    throw new Error("Recovery controlled-write artifact path escapes candidate root.");
  return absolutePath;
}

/** Preserves known verifier failures while keeping unknown provider errors as crashes. */
export async function persistRecoveryValidationArtifacts(store: ExperimentStore, staging: RecoveryStaging): Promise<void> {
  const files = ["recovery.md", "recovery-manifest.json"] as const;
  for (const file of files) {
    try {
      const bytes = await readFile(join(staging.root, file));
      await store.commitArtifact({
        artifactId: `recovery-validation-${file.replaceAll(".", "-")}`,
        kind: file === "recovery.md" ? "recovery_report" : "recovery_manifest",
        mediaType: file.endsWith(".md") ? "text/markdown" : "application/json",
        bytes,
        operationId: `recovery-validation-${file}-preserved`,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  await store.append({
    type: "recovery.validation_artifacts_preserved",
    runId: staging.caseId,
    operationId: "recovery-validation-artifacts-preserved",
    payload: { files: files.map((file) => file) },
  });
}

