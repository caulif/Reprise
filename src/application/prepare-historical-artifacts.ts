import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifactExtractor,
  type HistoricalArtifactIssue,
  type HistoricalArtifactManifest,
  type TaskCase,
} from "../core/schema.js";
import {
  frozenRelativePathForArtifact,
  sha256Buffer,
  validateHistoricalExtraction,
} from "../products/shared/historical-artifact-files.js";

export const DERIVED_HISTORY_DIR = "derived-history";
export const CASE_BASELINE_ARTIFACTS_DIR = "baseline-artifacts";

export type PrepareHistoricalArtifactsInput = {
  readonly taskCase: TaskCase;
  readonly caseDir: string;
  readonly attemptRoot: string;
  readonly extract?: HistoricalArtifactExtractor;
};

export type PrepareHistoricalArtifactsResult = {
  /** Root that Comparison/TUI should mount as finals (case sealed or attempt-derived). */
  readonly finalsRoot: string;
  readonly manifest: HistoricalArtifactManifest | undefined;
  readonly issues: readonly HistoricalArtifactIssue[];
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
): Promise<HistoricalArtifactIssue[]> {
  const issues: HistoricalArtifactIssue[] = [];
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

async function writeDerivedHistory(
  attemptRoot: string,
  extraction: Awaited<ReturnType<HistoricalArtifactExtractor>>,
  sourceHash: string,
): Promise<{ root: string; manifest: HistoricalArtifactManifest }> {
  const manifest = validateHistoricalExtraction(extraction, sourceHash);
  const root = join(attemptRoot, DERIVED_HISTORY_DIR);
  await mkdir(join(root, "files"), { recursive: true });
  await writeAtomic(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const artifact of manifest.artifacts) {
    if (artifact.finality !== "final") continue;
    const bytes = extraction.files.get(artifact.artifactId);
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
 */
export async function prepareHistoricalArtifacts(
  input: PrepareHistoricalArtifactsInput,
): Promise<PrepareHistoricalArtifactsResult> {
  const caseArtifactsRoot = join(input.caseDir, CASE_BASELINE_ARTIFACTS_DIR);
  const caseManifest = await readCaseManifest(input.caseDir);
  if (caseManifest && caseManifest.sourceHash === input.taskCase.provenance.sourceHash) {
    const issues = await verifyManifestFiles(caseArtifactsRoot, caseManifest);
    if (issues.length === 0) {
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
    const extraction = await input.extract({
      transcript: input.taskCase.transcript,
      historicalEvents: input.taskCase.historicalEvents,
      sourceHash: input.taskCase.provenance.sourceHash,
      privacy: { allowBinary: input.taskCase.privacy.allowBinary },
      ...(input.taskCase.taskContext ? { taskContext: input.taskCase.taskContext as Record<string, unknown> } : {}),
    });
    const derived = await writeDerivedHistory(
      input.attemptRoot,
      extraction,
      input.taskCase.provenance.sourceHash,
    );
    return {
      finalsRoot: derived.root,
      manifest: derived.manifest,
      issues: derived.manifest.issues,
      source: "derived",
    };
  } catch (error) {
    return {
      finalsRoot: join(input.attemptRoot, "finals"),
      manifest: undefined,
      issues: [{ code: "extraction_failed", sourceRefs: [] }],
      source: "unavailable",
    };
  }
}
