import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifact,
  type HistoricalArtifactIssue,
  type HistoricalArtifactIssueCode,
  type HistoricalArtifactManifest,
  type TaskCase,
} from "../core/schema.js";
import type { HistoricalArtifactExtractResult } from "../products/contract.js";
import type { HistoricalArtifactExtractFn } from "../products/shared/freeze.js";
import {
  assertSafeLogicalPath,
  frozenRelativePathForArtifact,
  validateHistoricalExtraction,
} from "../products/shared/historical-artifact-files.js";
import { historicalCwdOf } from "./replay-conditions.js";

export const DERIVED_HISTORY_DIR = "derived-history";
export const CASE_BASELINE_ARTIFACTS_DIR = "baseline-artifacts";
/** Attempt-local tool mount root: always `attemptRoot/finals` (flat logicalPath layout). */
export const ATTEMPT_FINALS_DIR = "finals";

/** Host prepare diagnostics; pack manifest issues stay on HistoricalArtifactIssueCode. */
export type PrepareHistoricalIssueCode =
  | HistoricalArtifactIssueCode
  | "hash_mismatch"
  | "missing_file"
  | "extractor_unavailable"
  | "extraction_failed"
  | "path_rejected";

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
  /** Always `attemptRoot/finals` — mount, seal, and inspectPath share this tree. */
  readonly finalsRoot: string;
  readonly manifest: HistoricalArtifactManifest | undefined;
  /** Names for openable-baseline discovery (artifactId, logicalPath, basename). */
  readonly openableNames: readonly string[];
  readonly issues: readonly PrepareHistoricalIssue[];
  readonly source: "case-manifest" | "derived" | "unavailable";
};

export function attemptFinalsRoot(attemptRoot: string): string {
  return join(attemptRoot, ATTEMPT_FINALS_DIR);
}

/** Openable discovery keys from a prepared/sealed manifest. */
function openableNamesFromManifest(manifest: HistoricalArtifactManifest): string[] {
  const names = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    names.add(artifact.artifactId);
    names.add(artifact.logicalPath.replace(/\\/g, "/"));
    const base = artifact.logicalPath.replace(/\\/g, "/").split("/").pop();
    if (base) names.add(base);
  }
  return [...names];
}

async function readHistoricalManifest(path: string): Promise<HistoricalArtifactManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Value.Check(HistoricalArtifactManifestSchema, raw)) return undefined;
    return raw;
  } catch {
    // Missing or unreadable manifest is a normal old-case / empty-finals path.
    return undefined;
  }
}

function nestedArtifactPath(artifactsRoot: string, artifact: HistoricalArtifact): string | undefined {
  try {
    assertSafeLogicalPath(artifact.logicalPath);
  } catch {
    return undefined;
  }
  return join(artifactsRoot, "files", artifact.bundleId, ...artifact.logicalPath.replace(/\\/g, "/").split("/"));
}

function flatFinalsPath(finalsRoot: string, artifact: HistoricalArtifact): string {
  assertSafeLogicalPath(artifact.logicalPath);
  return join(finalsRoot, ...artifact.logicalPath.replace(/\\/g, "/").split("/"));
}

async function verifyNestedManifestFiles(
  artifactsRoot: string,
  manifest: HistoricalArtifactManifest,
): Promise<PrepareHistoricalIssue[]> {
  const issues: PrepareHistoricalIssue[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    const filePath = nestedArtifactPath(artifactsRoot, artifact);
    if (!filePath) {
      issues.push({
        code: "path_rejected",
        logicalPath: artifact.logicalPath,
        sourceRefs: [...artifact.sourceRefs],
      });
      continue;
    }
    try {
      const bytes = await readFile(filePath);
      if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.contentHash) {
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

/**
 * Materialize finals for Comparison tools: `finals/manifest.json` + `finals/<logicalPath>`.
 * Nested case/derived trees stay provenance; mount always points here.
 */
async function materializeAttemptFinals(
  finalsRoot: string,
  manifest: HistoricalArtifactManifest,
  readBytes: (artifact: HistoricalArtifact) => Promise<Uint8Array | undefined>,
): Promise<PrepareHistoricalIssue[]> {
  const issues: PrepareHistoricalIssue[] = [];
  await mkdir(finalsRoot, { recursive: true });
  await writeAtomic(join(finalsRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    let destination: string;
    try {
      destination = flatFinalsPath(finalsRoot, artifact);
    } catch {
      issues.push({
        code: "path_rejected",
        logicalPath: artifact.logicalPath,
        sourceRefs: [...artifact.sourceRefs],
      });
      continue;
    }
    const bytes = await readBytes(artifact);
    if (!bytes) {
      issues.push({
        code: "missing_file",
        logicalPath: artifact.logicalPath,
        sourceRefs: [...artifact.sourceRefs],
      });
      continue;
    }
    if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.contentHash) {
      issues.push({
        code: "hash_mismatch",
        logicalPath: artifact.logicalPath,
        sourceRefs: [...artifact.sourceRefs],
      });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
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
 * attempt's derived-history/ from the frozen transcript. Always materializes
 * tool-facing bytes into attemptRoot/finals/. Never rewrites the published case.
 */
export async function prepareHistoricalArtifacts(
  input: PrepareHistoricalArtifactsInput,
): Promise<PrepareHistoricalArtifactsResult> {
  const finalsRoot = attemptFinalsRoot(input.attemptRoot);
  const caseArtifactsRoot = join(input.caseDir, CASE_BASELINE_ARTIFACTS_DIR);
  const caseManifest = await readHistoricalManifest(join(caseArtifactsRoot, "manifest.json"));

  if (caseManifest) {
    const fileIssues = await verifyNestedManifestFiles(caseArtifactsRoot, caseManifest);
    if (fileIssues.length === 0) {
      const materializeIssues = await materializeAttemptFinals(finalsRoot, caseManifest, async (artifact) => {
        const path = nestedArtifactPath(caseArtifactsRoot, artifact);
        if (!path) return undefined;
        try {
          return await readFile(path);
        } catch {
          return undefined;
        }
      });
      if (materializeIssues.length === 0) {
        return {
          finalsRoot,
          manifest: caseManifest,
          openableNames: openableNamesFromManifest(caseManifest),
          issues: caseManifest.issues,
          source: "case-manifest",
        };
      }
    }
  }

  if (!input.extract) {
    await mkdir(finalsRoot, { recursive: true });
    return {
      finalsRoot,
      manifest: undefined,
      openableNames: [],
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
    const materializeIssues = await materializeAttemptFinals(finalsRoot, derived.manifest, async (artifact) =>
      bytesForArtifact(extraction, artifact.artifactId),
    );
    if (materializeIssues.length > 0) {
      return {
        finalsRoot,
        manifest: derived.manifest,
        openableNames: openableNamesFromManifest(derived.manifest),
        issues: [...derived.manifest.issues, ...materializeIssues],
        source: "derived",
      };
    }
    return {
      finalsRoot,
      manifest: derived.manifest,
      openableNames: openableNamesFromManifest(derived.manifest),
      issues: derived.manifest.issues,
      source: "derived",
    };
  } catch {
    // Pack extract throw, validateHistoricalExtraction, or derived-history write failure.
    // Soften to unavailable so comparison can continue on other evidence; unexpected
    // programming errors in Host helpers are not expected to reach here after validate.
    await mkdir(finalsRoot, { recursive: true });
    return {
      finalsRoot,
      manifest: undefined,
      openableNames: [],
      issues: [{ code: "extraction_failed", sourceRefs: [] }],
      source: "unavailable",
    };
  }
}

/** Re-export pack issue shape for callers that only need sealed manifest rows. */
export type { HistoricalArtifactIssue };
