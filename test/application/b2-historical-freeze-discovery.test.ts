import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { freezeCase, type HistoricalArtifactExtractFn } from "../../src/products/shared/freeze.js";
import { assertSafeLogicalPath } from "../../src/products/shared/historical-artifact-files.js";
import {
  HistoricalArtifactManifestSchema,
  type TaskCase,
} from "../../src/core/schema.js";
import type { HistoricalArtifactExtractResult, ImportedSession, SessionMessage } from "../../src/products/contract.js";
import { prepareHistoricalArtifacts } from "../../src/application/prepare-historical-artifacts.js";
import {
  collectHistoricalDeliverableNames,
  historicalFinalSearchRoots,
  lookupBasenameResult,
  indexHistoricalRoots,
  resolveHistoricalFinalPath,
  sealedInspectPath,
} from "../../src/application/historical-final-discovery.js";
import { comparisonAttemptMounts } from "../../src/application/comparison-briefing.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { artifactIdForPath, bundleIdForPath } from "../../src/products/shared/historical-artifact-apply.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function message(id: string, role: SessionMessage["role"], text: string): SessionMessage {
  return { id, role, text };
}

function imported(transcript: readonly SessionMessage[]): ImportedSession {
  const initial = transcript.find((item) => item.role === "user");
  if (!initial) throw new Error("fixture has no user message");
  return {
    source: { productId: "codex", sessionId: "session-b2", sourcePath: "session.jsonl" },
    initialInput: initial,
    transcript,
    historicalEvents: [],
    baseline: { status: "available", finalMessage: "Delivered anim/index.html", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test" },
    raw: { relativePath: "raw/session.jsonl", text: JSON.stringify(transcript) },
    diagnostics: [],
    signals: {
      userMessages: transcript.filter((item) => item.role === "user").length,
      assistantMessages: transcript.filter((item) => item.role === "assistant").length,
      toolCalls: 0,
      completedTurns: 1,
    },
  };
}

function stubExtractor(bytes: Buffer, logicalPath = "anim/index.html"): HistoricalArtifactExtractFn {
  const contentHash = sha256(bytes);
  const artifactId = artifactIdForPath(logicalPath);
  const bundleId = bundleIdForPath(logicalPath);
  return (): HistoricalArtifactExtractResult => ({
    manifest: {
      schemaVersion: 1,
      sourceHash: "c".repeat(64),
      extractorVersion: "stub-1",
      artifacts: [{
        artifactId,
        logicalPath,
        bundleId,
        mediaType: "text/html",
        contentHash,
        byteLength: bytes.byteLength,
        origin: "reconstructed_from_history",
        sourceRefs: ["message:a1"],
        finality: "final",
      }],
      issues: [],
    },
    files: [{ artifactId, bytes }],
  });
}

test("assertSafeLogicalPath rejects traversal and absolute paths", () => {
  assert.throws(() => assertSafeLogicalPath("../x.html"));
  assert.throws(() => assertSafeLogicalPath("/tmp/x.html"));
  assert.throws(() => assertSafeLogicalPath("C:\\Windows\\x.html"));
  assert.doesNotThrow(() => assertSafeLogicalPath("anim/index.html"));
});

test("freezeCase with extractor seals manifest and files under baseline-artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-freeze-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const html = Buffer.from("<!doctype html><title>history</title>\n", "utf8");
  const logicalPath = "anim/index.html";
  const session = imported([
    message("u1", "user", "make anim/index.html"),
    message("a1", "assistant", "Delivered anim/index.html"),
  ]);
  const frozen = await freezeCase(
    session,
    root,
    { allowModelText: true, allowBinary: false, redactions: [] },
    "2026-09-19T00:00:00.000Z",
    { extractHistoricalArtifacts: stubExtractor(html, logicalPath), reuseExisting: false },
  );
  assert.equal(frozen.reused, false);
  assert.equal(frozen.taskCase.baseline.artifactRefs.length, 1);
  assert.equal(frozen.taskCase.baseline.artifactRefs[0]?.caseId, frozen.taskCase.caseId);
  assert.notEqual(frozen.taskCase.baseline.artifactRefs[0]?.caseId, "");
  const caseDir = join(root, frozen.taskCase.caseId);
  const parsed: unknown = JSON.parse(await readFile(join(caseDir, "baseline-artifacts", "manifest.json"), "utf8"));
  const manifest = Value.Parse(HistoricalArtifactManifestSchema, parsed);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts[0]?.logicalPath, logicalPath);
  const sealed = await readFile(
    join(caseDir, "baseline-artifacts", "files", bundleIdForPath(logicalPath), "anim", "index.html"),
  );
  assert.equal(sha256(sealed), sha256(html));
});

test("reuseExisting freeze leaves old case hashes unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-reuse-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const html = Buffer.from("<!doctype html><title>v1</title>\n", "utf8");
  const logicalPath = "anim/index.html";
  const session = imported([
    message("u1", "user", "make anim/index.html"),
    message("a1", "assistant", "Delivered anim/index.html"),
  ]);
  const first = await freezeCase(
    session,
    root,
    { allowModelText: true, allowBinary: false, redactions: [] },
    "2026-09-19T00:00:00.000Z",
    { extractHistoricalArtifacts: stubExtractor(html, logicalPath) },
  );
  const caseDir = join(root, first.taskCase.caseId);
  const before = await readFile(
    join(caseDir, "baseline-artifacts", "files", bundleIdForPath(logicalPath), "anim", "index.html"),
  );
  const second = await freezeCase(
    session,
    root,
    { allowModelText: true, allowBinary: false, redactions: [] },
    "2026-09-19T01:00:00.000Z",
    { extractHistoricalArtifacts: stubExtractor(Buffer.from("<!doctype html><title>v2</title>\n", "utf8"), logicalPath) },
  );
  assert.equal(second.reused, true);
  const after = await readFile(
    join(caseDir, "baseline-artifacts", "files", bundleIdForPath(logicalPath), "anim", "index.html"),
  );
  assert.equal(sha256(after), sha256(before));
});

test("prepareHistoricalArtifacts derives into attempt without rewriting case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-prepare-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caseDir = join(root, "cases", "case-old");
  const attemptRoot = join(root, "comparison-attempts", "attempt-1");
  await mkdir(caseDir, { recursive: true });
  await mkdir(attemptRoot, { recursive: true });
  const html = Buffer.from("<!doctype html><title>derived</title>\n", "utf8");
  const logicalPath = "anim/index.html";
  const sourceHash = "a".repeat(64);
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId: "case-old",
    source: { productId: "codex", sessionId: "s1" },
    initialInput: { id: "u1", role: "user", text: "make anim/index.html" },
    transcript: [
      { id: "u1", role: "user", text: "make anim/index.html" },
      { id: "a1", role: "assistant", text: "Delivered anim/index.html" },
    ],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [], finalMessage: "Delivered anim/index.html" },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: "2026-09-19T00:00:00.000Z", sourceHash },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: sourceHash,
  };
  await writeFile(join(caseDir, "case.json"), `${JSON.stringify(taskCase)}\n`);
  const prepared = await prepareHistoricalArtifacts({
    taskCase,
    caseDir,
    attemptRoot,
    extract: stubExtractor(html, logicalPath),
  });
  assert.equal(prepared.source, "derived");
  assert.ok(prepared.manifest);
  const derivedFile = join(
    attemptRoot,
    "derived-history",
    "files",
    bundleIdForPath(logicalPath),
    "anim",
    "index.html",
  );
  assert.equal(sha256(await readFile(derivedFile)), sha256(html));
  // Case dir still has no baseline-artifacts rewrite.
  await assert.rejects(readFile(join(caseDir, "baseline-artifacts", "manifest.json")));
});

test("env baselines alone do not resolve as historical finals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-baseline-demote-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experimentRoot = join(root, "experiment");
  await mkdir(join(experimentRoot, "environment", "baselines"), { recursive: true });
  await writeFile(join(experimentRoot, "environment", "baselines", "deck.html"), "<!doctype html><title>start</title>", "utf8");
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId: "case-1",
    source: { productId: "codex", sessionId: "s1" },
    initialInput: { id: "m1", role: "user", text: "做 deck.html" },
    transcript: [{ id: "m2", role: "assistant", text: "见 deck.html" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [{ artifactId: "deck.html", caseId: "case-1" }], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: "2026-09-19T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  const resolved = await resolveHistoricalFinalPath({
    experimentRoot,
    runId: "run-1",
    taskCase,
  });
  assert.equal(resolved, undefined);
});

test("ambiguous basename within one root does not pick the first match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-ambiguous-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const nestedA = join(root, "a");
  const nestedB = join(root, "b");
  await mkdir(nestedA, { recursive: true });
  await mkdir(nestedB, { recursive: true });
  await writeFile(join(nestedA, "index.html"), "one", "utf8");
  await writeFile(join(nestedB, "index.html"), "two", "utf8");
  const index = await indexHistoricalRoots([
    { root, mode: "recursive-basename" },
  ]);
  const result = lookupBasenameResult(index, "index.html");
  assert.equal(result.status, "ambiguous");
});

test("earlier search root wins over later root for the same basename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-priority-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "index.html"), "one", "utf8");
  await writeFile(join(second, "index.html"), "two", "utf8");
  const index = await indexHistoricalRoots([
    { root: first, mode: "direct-basename" },
    { root: second, mode: "direct-basename" },
  ]);
  const result = lookupBasenameResult(index, "index.html");
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" ? result.path : "", join(first, "index.html"));
});

test("comparison finals mount exposes sealed deliverables; history stays process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-mounts-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experimentRoot = join(root, "experiment");
  const runId = "run-1";
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const controllerHistory = join(experimentRoot, "runs", runId, "controller-briefing", "history");
  const finalsRoot = join(attemptRoot, "finals");
  await mkdir(controllerHistory, { recursive: true });
  await mkdir(finalsRoot, { recursive: true });
  await writeFile(join(controllerHistory, "outline.tsv"), "id\trole\n", "utf8");
  const html = "<!doctype html><title>final</title>\n";
  await writeFile(join(finalsRoot, "index.html"), html, "utf8");
  const mounts = comparisonAttemptMounts({
    experimentRoot,
    runId,
    attemptRoot,
    candidateSnapshotStatus: "missing",
    candidateSnapshotRoot: join(attemptRoot, "candidate-missing"),
    finalsRoot,
  });
  assert.equal(mounts.finals, finalsRoot);
  assert.equal(mounts.history, controllerHistory);
  assert.equal(sealedInspectPath(join(finalsRoot, "index.html")), "finals/index.html");
  const tools = workspaceTools(attemptRoot, {
    mounts,
    denyDestructiveOnPrefix: ["candidate", "evidence", "history", "finals", "turns", "run", "observations"],
  });
  const reader = tools.find((tool) => tool.name === "read");
  assert.ok(reader);
  const signal = new AbortController().signal;
  const finalsBody = await reader.execute({ path: "finals/index.html" }, signal);
  assert.match(finalsBody.content, /<title>final<\/title>/);
  const historyBody = await reader.execute({ path: "history/outline.tsv" }, signal);
  assert.match(historyBody.content, /id\trole/);
});

test("openable-baseline names stay empty without artifact refs even when transcript names exist", () => {
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId: "case-1",
    source: { productId: "codex", sessionId: "s1" },
    initialInput: { id: "m1", role: "user", text: "做" },
    transcript: [{ id: "m2", role: "assistant", text: "见 pelican.html" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [], finalMessage: "见 pelican.html" },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: "2026-09-19T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  const openable = collectHistoricalDeliverableNames(taskCase, "openable-baseline");
  const finalNames = collectHistoricalDeliverableNames(taskCase, "final");
  assert.equal(openable.size, 0);
  assert.ok(finalNames.has("pelican.html"));
});

test("historicalFinalSearchRoots marks environment baselines as start-state-only", () => {
  const roots = historicalFinalSearchRoots({
    experimentRoot: "/exp",
    runId: "run-1",
    caseId: "case-1",
    attemptRoot: "/exp/comparison-attempts/a1",
  });
  const baseline = roots.find((root) => root.root.includes("environment") && root.root.includes("baselines"));
  assert.ok(baseline?.startStateOnly);
});
