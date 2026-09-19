import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifact,
  type HistoricalArtifactExtraction,
  type HistoricalArtifactManifest,
} from "../../core/schemas/historical-artifacts.js";
import type { FrozenFile } from "./freeze.js";

export const BASELINE_ARTIFACTS_MANIFEST = "baseline-artifacts/manifest.json";
export const BASELINE_ARTIFACTS_FILES_PREFIX = "baseline-artifacts/files";

/** Reject path escape / absolute / ADS / UNC before sealing bytes. */
export function assertSafeLogicalPath(logicalPath: string): void {
  const normalized = logicalPath.replace(/\\/g, "/");
  if (!normalized || normalized.length > 512) {
    throw new Error(`Historical artifact logicalPath is invalid: ${logicalPath}`);
  }
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Historical artifact logicalPath must be relative: ${logicalPath}`);
  }
  if (normalized.includes("\0") || normalized.includes("..") || /[:*?"<>|]/.test(normalized)) {
    throw new Error(`Historical artifact logicalPath is unsafe: ${logicalPath}`);
  }
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment.includes(":"))) {
    throw new Error(`Historical artifact logicalPath has an unsafe segment: ${logicalPath}`);
  }
}

export function frozenRelativePathForArtifact(artifact: HistoricalArtifact): string {
  assertSafeLogicalPath(artifact.logicalPath);
  return `${BASELINE_ARTIFACTS_FILES_PREFIX}/${artifact.bundleId}/${artifact.logicalPath}`;
}

export function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateHistoricalExtraction(
  extraction: HistoricalArtifactExtraction,
  expectedSourceHash: string,
): HistoricalArtifactManifest {
  if (!Value.Check(HistoricalArtifactManifestSchema, extraction.manifest)) {
    throw new Error("Historical artifact manifest failed schema validation.");
  }
  if (extraction.manifest.sourceHash !== expectedSourceHash) {
    throw new Error("Historical artifact manifest sourceHash does not match the frozen session.");
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const artifact of extraction.manifest.artifacts) {
    if (seenIds.has(artifact.artifactId)) {
      throw new Error(`Duplicate historical artifactId: ${artifact.artifactId}`);
    }
    seenIds.add(artifact.artifactId);
    assertSafeLogicalPath(artifact.logicalPath);
    const pathKey = `${artifact.bundleId}\0${artifact.logicalPath.replace(/\\/g, "/").toLowerCase()}`;
    if (seenPaths.has(pathKey)) {
      throw new Error(`Conflicting historical logicalPath: ${artifact.logicalPath}`);
    }
    seenPaths.add(pathKey);
    const bytes = extraction.files.get(artifact.artifactId);
    if (!bytes) {
      throw new Error(`Historical extraction missing bytes for ${artifact.artifactId}`);
    }
    if (bytes.byteLength !== artifact.byteLength) {
      throw new Error(`Historical artifact byteLength mismatch for ${artifact.artifactId}`);
    }
    if (sha256Buffer(bytes) !== artifact.contentHash) {
      throw new Error(`Historical artifact contentHash mismatch for ${artifact.artifactId}`);
    }
  }
  for (const artifactId of extraction.files.keys()) {
    if (!seenIds.has(artifactId)) {
      throw new Error(`Historical extraction has orphan bytes for ${artifactId}`);
    }
  }
  return extraction.manifest;
}

export function frozenFilesFromExtraction(
  extraction: HistoricalArtifactExtraction,
  expectedSourceHash: string,
): { manifest: HistoricalArtifactManifest; files: FrozenFile[]; finalArtifacts: readonly HistoricalArtifact[] } {
  const manifest = validateHistoricalExtraction(extraction, expectedSourceHash);
  const finalArtifacts = manifest.artifacts.filter((artifact) => artifact.finality === "final");
  const files: FrozenFile[] = [
    {
      relativePath: BASELINE_ARTIFACTS_MANIFEST,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...finalArtifacts.map((artifact) => {
      const bytes = extraction.files.get(artifact.artifactId);
      if (!bytes) throw new Error(`Missing bytes for ${artifact.artifactId}`);
      return {
        relativePath: frozenRelativePathForArtifact(artifact),
        content: bytes,
      };
    }),
  ];
  return { manifest, files, finalArtifacts };
}

export function absolutePathForManifestArtifact(
  artifactsRoot: string,
  artifact: HistoricalArtifact,
): string {
  assertSafeLogicalPath(artifact.logicalPath);
  return `${artifactsRoot.replace(/[/\\]+$/, "")}/files/${artifact.bundleId}/${artifact.logicalPath}`.replace(/\\/g, "/");
}
