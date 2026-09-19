import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../../core/identity.js";
import {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifact,
  type HistoricalArtifactManifest,
} from "../../core/schemas/historical-artifacts.js";
import type { HistoricalArtifactExtractResult } from "../contract.js";
import { validateLogicalPath } from "./historical-artifact-apply.js";
import type { FrozenFile } from "./freeze.js";

export const BASELINE_ARTIFACTS_MANIFEST = "baseline-artifacts/manifest.json";
export const BASELINE_ARTIFACTS_FILES_PREFIX = "baseline-artifacts/files";

/** Reject path escape / absolute / ADS / UNC before sealing or joining bytes (B1 validator). */
export function assertSafeLogicalPath(logicalPath: string): void {
  const result = validateLogicalPath(logicalPath);
  if (!result.ok) {
    throw new Error(`Historical artifact logicalPath is unsafe (${result.reason}): ${logicalPath}`);
  }
}

export function frozenRelativePathForArtifact(artifact: HistoricalArtifact): string {
  assertSafeLogicalPath(artifact.logicalPath);
  return `${BASELINE_ARTIFACTS_FILES_PREFIX}/${artifact.bundleId}/${artifact.logicalPath}`;
}

function bytesForArtifact(
  extraction: HistoricalArtifactExtractResult,
  artifactId: string,
): Uint8Array | undefined {
  const match = extraction.files.find((file) => file.artifactId === artifactId);
  return match?.bytes;
}

/**
 * Validate Pack extract output before sealing. `sourceHash` on the manifest is the
 * extractor's transcript/events digest (see sourceHashForExtract), not the raw session file hash.
 */
export function validateHistoricalExtraction(
  extraction: HistoricalArtifactExtractResult,
): HistoricalArtifactManifest {
  if (!Value.Check(HistoricalArtifactManifestSchema, extraction.manifest)) {
    throw new Error("Historical artifact manifest failed schema validation.");
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
    const bytes = bytesForArtifact(extraction, artifact.artifactId);
    if (!bytes) {
      throw new Error(`Historical extraction missing bytes for ${artifact.artifactId}`);
    }
    if (bytes.byteLength !== artifact.byteLength) {
      throw new Error(`Historical artifact byteLength mismatch for ${artifact.artifactId}`);
    }
    if (sha256(bytes) !== artifact.contentHash) {
      throw new Error(`Historical artifact contentHash mismatch for ${artifact.artifactId}`);
    }
  }
  for (const file of extraction.files) {
    if (!seenIds.has(file.artifactId)) {
      throw new Error(`Historical extraction has orphan bytes for ${file.artifactId}`);
    }
  }
  return extraction.manifest;
}

export function frozenFilesFromExtraction(
  extraction: HistoricalArtifactExtractResult,
): { manifest: HistoricalArtifactManifest; files: FrozenFile[]; finalArtifacts: readonly HistoricalArtifact[] } {
  const manifest = validateHistoricalExtraction(extraction);
  const finalArtifacts = manifest.artifacts.filter((artifact) => artifact.finality === "final");
  const files: FrozenFile[] = [
    {
      relativePath: BASELINE_ARTIFACTS_MANIFEST,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...finalArtifacts.map((artifact) => {
      const bytes = bytesForArtifact(extraction, artifact.artifactId);
      if (!bytes) throw new Error(`Missing bytes for ${artifact.artifactId}`);
      return {
        relativePath: frozenRelativePathForArtifact(artifact),
        content: Buffer.from(bytes),
      };
    }),
  ];
  return { manifest, files, finalArtifacts };
}
