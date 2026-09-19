import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifactIssue,
  type HistoricalArtifactIssueCode,
  type HistoricalArtifactManifest,
  type TaskCase,
} from "../core/schema.js";
import type { HistoricalArtifactExtractResult } from "../products/contract.js";
import type { HistoricalArtifactExtractFn } from "../products/shared/freeze.js";
import {
  frozenRelativePathForArtifact,
  sha256Buffer,
  validateHistoricalExtraction,
} from "../products/shared/historical-artifact-files.js";
import { historicalCwdOf } from "./replay-conditions.js";

export const DERIVED_HISTORY_DIR = "derived-history";
export const CASE_BASELINE_ARTIFACTS_DIR = "baseline-artifacts";

/** Host prepare diagnostics; pack manifest issues stay on HistoricalArtifactIssueCode. */
export type PrepareHistoricalIssueCode =
  | HistoricalArtifactIssueCode
  | "hash_mismatch"
  | "missing_file"
  | "extractor_unavailable"
  | "extraction_failed";

export type PrepareHistoricalIssue = {
  readonly code: PrepareHistoricalIssueCode;
  readonly logicalPath?: string;
  readonly sourceRefs: readonly string[];
  readonly message?: string;
};

export type PrepareHistoricalArtifactsInput = {
  readonly taskCase: TaskCase;
  readonly caseDir: string;
  readonly attemptRoot: string;
  readonly extract?: HistoricalArtifactExtractFn;
};

export type PrepareHistoricalArtifactsResult = {
  /** Root that Comparison/TUI should mount as finals (case sealed or attempt-derived). */
  readonly finalsRoot: string;
  readonly manifest: HistoricalArtifactManifest | undefined;
  readonly issues: readonly PrepareHistoricalIssue[];
  readonly source: "case-manifest" | "derived" | "unavailable";
};

async function readCaseManifest(caseDir: string): Promise<HistoricalArtifactManifest | undefined> {
  const path = join(caseDir, CASE_BASELINE_ARTIFACTS_DIR, "manifest.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Value.Check(HistoricalArtifactManifestSchema, raw)) return undefined;
    return raw;
  } catch {
    // Missing or unreadable case manifest is a normal old-case path.
    return undefined;
  }
}

async function verifyManifestFiles(
  artifactsRoot: string,
  manifest: HistoricalArtifactManifest,
): Promise<PrepareHistoricalIssue[]> {
  const issues: PrepareHistoricalIssue[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    const filePath = join(artifactsRoot, "files", artifact.bundleId, ...artifact.logicalPath.split("/"));
    try {
      const bytes = await readFile(filePath);
      if (bytes.byteLength !== artifact.byteLength || sha256Buffer(bytes) !== artifact.contentHash) {
        issues.push({
          code: "hash_mismatch",
          logicalPath: artifact.logicalPath,
          sourceRefs: [...artifact.sourceRefs],
        });
      }
    } catch {
      issues.push({
        code: "missing_file",
        logicalPath: artifact.logicalPath,
        sourceRefs: [...artifact.sourceRefs],
      });
    }
  }
  return issues;
}

function bytesForArtifact(
  extraction: HistoricalArtifactExtractResult,
  artifactId: string,
): Uint8Array | undefined {
  return extraction.files.find((file) => file.artifactId === artifactId)?.bytes;
}

async function writeDerivedHistory(
  attemptRoot: string,
  extraction: HistoricalArtifactExtractResult,
): Promise<{ root: string; manifest: HistoricalArtifactManifest }> {
  const manifest = validateHistoricalExtraction(extraction);
  const root = join(attemptRoot, DERIVED_HISTORY_DIR);
  await mkdir(join(root, "files"), { recursive: true });
  await writeAtomic(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    const bytes = bytesForArtifact(extraction, artifact.artifactId);
    if (!bytes) continue;
    const relative = frozenRelativePathForArtifact(artifact).replace(/^baseline-artifacts\//, "");
    const destination = join(root, ...relative.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return { root, manifest };
}

/**
 * Prefer a valid case-level historical manifest; otherwise derive into this
 * attempt's derived-history/ from the frozen transcript. Never rewrites the
 * published case and never re-imports a live product session.
 *
 * Manifest `sourceHash` is the extractor transcript digest, not case provenance.sourceHash.
 */
export async function prepareHistoricalArtifacts(
  input: PrepareHistoricalArtifactsInput,
): Promise<PrepareHistoricalArtifactsResult> {
  const caseArtifactsRoot = join(input.caseDir, CASE_BASELINE_ARTIFACTS_DIR);
  const caseManifest = await readCaseManifest(input.caseDir);
  if (caseManifest) {
    const fileIssues = await verifyManifestFiles(caseArtifactsRoot, caseManifest);
    if (fileIssues.length === 0) {
      return {
        finalsRoot: caseArtifactsRoot,
        manifest: caseManifest,
        issues: caseManifest.issues,
        source: "case-manifest",
      };
    }
  }

  if (!input.extract) {
    return {
      finalsRoot: join(input.attemptRoot, "finals"),
      manifest: undefined,
      issues: [{ code: "extractor_unavailable", sourceRefs: [] }],
      source: "unavailable",
    };
  }

  try {
    const historicalCwd = historicalCwdOf(input.taskCase);
    const extraction = input.extract({
      transcript: input.taskCase.transcript,
      historicalEvents: input.taskCase.historicalEvents,
      ...(historicalCwd ? { historicalCwd } : {}),
    });
    const derived = await writeDerivedHistory(input.attemptRoot, extraction);
    return {
      finalsRoot: derived.root,
      manifest: derived.manifest,
      issues: derived.manifest.issues,
      source: "derived",
    };
  } catch {
    return {
      finalsRoot: join(input.attemptRoot, "finals"),
      manifest: undefined,
      issues: [{ code: "extraction_failed", sourceRefs: [] }],
      source: "unavailable",
    };
  }
}

/** Re-export pack issue shape for callers that only need sealed manifest rows. */
export type { HistoricalArtifactIssue };
