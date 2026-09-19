import { freezeCodexSession } from "../../src/products/packs/codex/sessions.js";
import { extractCodexHistoricalArtifacts } from "../../src/products/packs/codex/historical-artifacts.js";
import { prepareHistoricalArtifacts } from "../../src/application/prepare-historical-artifacts.js";
import { assertSafeLogicalPath } from "../../src/products/shared/historical-artifact-files.js";
import {
  collectHistoricalDeliverableNames,
  discoverBaselineOpenableSources,
  historicalFinalSearchRoots,
  lookupBasenameResult,
  indexHistoricalRoots,
  resolveHistoricalFinalPath,
  sealedInspectPath,
} from "../../src/application/historical-final-discovery.js";
import { comparisonAttemptMounts } from "../../src/application/comparison-briefing.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { bundleIdForPath } from "../../src/products/shared/historical-artifact-apply.js";
import {
  HistoricalArtifactManifestSchema,
  type TaskCase,
} from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  addFilePatch,
  buildDirectApplyPatchRollout,
  HISTORICAL_ANIMATION_NAME,
  readHistoricalAnimationHtml,
} from "../fixtures/historical-svg-animation/support.js";

const timestamp = "2026-09-19T00:00:00.000Z";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

async function writeDirectRollout(root: string, sessionId: string): Promise<{
  sourcePath: string;
  html: string;
}> {
  const cwd = join(root, "historical-cwd");
  await mkdir(cwd, { recursive: true });
  const html = await readHistoricalAnimationHtml();
  const patch = addFilePatch(HISTORICAL_ANIMATION_NAME, html);
  const sourcePath = join(root, "rollout-direct.jsonl");
  await writeFile(
    sourcePath,
    buildDirectApplyPatchRollout({ sessionId, cwd, patch }),
    "utf8",
  );
  return { sourcePath, html };
}

test("assertSafeLogicalPath rejects traversal and absolute paths", () => {
  assert.throws(() => assertSafeLogicalPath("../x.html"));
  assert.throws(() => assertSafeLogicalPath("/tmp/x.html"));
  assert.throws(() => assertSafeLogicalPath("C:\\Windows\\x.html"));
  assert.doesNotThrow(() => assertSafeLogicalPath("anim/index.html"));
});

test("freezeCase with real Codex extract seals manifest and files under baseline-artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-freeze-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { sourcePath, html } = await writeDirectRollout(root, "b2-freeze-session");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    extractHistoricalArtifacts: extractCodexHistoricalArtifacts,
  });
  assert.equal(frozen.reused, false);
  assert.equal(frozen.taskCase.baseline.artifactRefs.length, 1);
  assert.equal(frozen.taskCase.baseline.artifactRefs[0]?.caseId, frozen.taskCase.caseId);
  assert.notEqual(frozen.taskCase.baseline.artifactRefs[0]?.caseId, "");
  const caseDir = join(root, "cases", frozen.taskCase.caseId);
  const parsed: unknown = JSON.parse(await readFile(join(caseDir, "baseline-artifacts", "manifest.json"), "utf8"));
  const manifest = Value.Parse(HistoricalArtifactManifestSchema, parsed);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts[0]?.logicalPath, HISTORICAL_ANIMATION_NAME);
  const sealed = await readFile(
    join(
      caseDir,
      "baseline-artifacts",
      "files",
      bundleIdForPath(HISTORICAL_ANIMATION_NAME),
      HISTORICAL_ANIMATION_NAME,
    ),
  );
  assert.equal(normalizeNewlines(sealed.toString("utf8")), normalizeNewlines(html));
});

test("reuseExisting freeze leaves old case hashes unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-reuse-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { sourcePath } = await writeDirectRollout(root, "b2-reuse-session");
  const first = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    extractHistoricalArtifacts: extractCodexHistoricalArtifacts,
  });
  const caseDir = join(root, "cases", first.taskCase.caseId);
  const sealedPath = join(
    caseDir,
    "baseline-artifacts",
    "files",
    bundleIdForPath(HISTORICAL_ANIMATION_NAME),
    HISTORICAL_ANIMATION_NAME,
  );
  const before = await readFile(sealedPath);
  const second = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: "2026-09-19T01:00:00.000Z",
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    extractHistoricalArtifacts: extractCodexHistoricalArtifacts,
  });
  assert.equal(second.reused, true);
  assert.equal(sha256(await readFile(sealedPath)), sha256(before));
});

test("prepareHistoricalArtifacts derives into attempt without rewriting case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-prepare-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { sourcePath, html } = await writeDirectRollout(root, "b2-prepare-session");
  // Old Case path: freeze without extract (empty baseline-artifacts).
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  assert.equal(frozen.taskCase.baseline.artifactRefs.length, 0);
  const caseDir = join(root, "cases", frozen.taskCase.caseId);
  const attemptRoot = join(root, "comparison-attempts", "attempt-1");
  await mkdir(attemptRoot, { recursive: true });
  const prepared = await prepareHistoricalArtifacts({
    taskCase: frozen.taskCase,
    caseDir,
    attemptRoot,
    extract: extractCodexHistoricalArtifacts,
  });
  assert.equal(prepared.source, "derived");
  assert.ok(prepared.manifest);
  assert.ok(prepared.manifest.artifacts.some((item) => item.logicalPath === HISTORICAL_ANIMATION_NAME));
  assert.equal(prepared.finalsRoot, join(attemptRoot, "finals"));
  assert.ok(prepared.openableNames.includes(HISTORICAL_ANIMATION_NAME));
  const derivedFile = join(
    attemptRoot,
    "derived-history",
    "files",
    bundleIdForPath(HISTORICAL_ANIMATION_NAME),
    HISTORICAL_ANIMATION_NAME,
  );
  const finalsFile = join(attemptRoot, "finals", HISTORICAL_ANIMATION_NAME);
  assert.equal(
    normalizeNewlines((await readFile(derivedFile)).toString("utf8")),
    normalizeNewlines(html),
  );
  assert.equal(
    normalizeNewlines((await readFile(finalsFile)).toString("utf8")),
    normalizeNewlines(html),
  );
  await assert.rejects(readFile(join(caseDir, "baseline-artifacts", "manifest.json")));
});

test("prepare openableNames unlock discovery for empty-refs old cases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-openable-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { sourcePath } = await writeDirectRollout(root, "b2-openable-session");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  assert.equal(collectHistoricalDeliverableNames(frozen.taskCase, "openable-baseline").size, 0);
  const attemptRoot = join(root, "comparison-attempts", "a1");
  await mkdir(attemptRoot, { recursive: true });
  const prepared = await prepareHistoricalArtifacts({
    taskCase: frozen.taskCase,
    caseDir: join(root, "cases", frozen.taskCase.caseId),
    attemptRoot,
    extract: extractCodexHistoricalArtifacts,
  });
  assert.ok(prepared.openableNames.length > 0);
  const sources = await discoverBaselineOpenableSources({
    attemptRoot,
    experimentRoot: join(root, "experiment"),
    runId: "run-1",
    dataDir: root,
    caseId: frozen.taskCase.caseId,
    baselineArtifactNames: prepared.openableNames,
  });
  assert.ok(sources.length >= 1);
  const baseline = sources[0];
  assert.ok(baseline);
  assert.equal(baseline.inspectPath, `finals/${HISTORICAL_ANIMATION_NAME}`);
  assert.match(await readFile(baseline.absolutePath, "utf8"), /Synthetic SVG bounce/);
});

test("assertSafeLogicalPath rejects traversal that schema alone may accept", () => {
  assert.throws(() => assertSafeLogicalPath("../etc/passwd"));
  assert.throws(() => assertSafeLogicalPath("/tmp/x.html"));
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

test("nested same-basename finals seal without flattening abort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b2-nested-seal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caseId = "case-nested";
  const caseDir = join(root, "cases", caseId);
  const attemptRoot = join(root, "comparison-attempts", "a1");
  const experimentRoot = join(root, "experiment");
  await mkdir(attemptRoot, { recursive: true });
  const htmlA = "<!doctype html><title>a</title>\n";
  const htmlB = "<!doctype html><title>b</title>\n";
  const artifactA = {
    artifactId: "ha-aaaaaaaaaaaaaaaaaaaaaaaa",
    bundleId: bundleIdForPath("a/index.html"),
    logicalPath: "a/index.html",
    contentHash: sha256(Buffer.from(htmlA)),
    byteLength: Buffer.byteLength(htmlA),
    mediaType: "text/html",
    origin: "reconstructed_from_history" as const,
    finality: "final" as const,
    sourceRefs: ["ref:a"],
  };
  const artifactB = {
    artifactId: "ha-bbbbbbbbbbbbbbbbbbbbbbbb",
    bundleId: bundleIdForPath("b/index.html"),
    logicalPath: "b/index.html",
    contentHash: sha256(Buffer.from(htmlB)),
    byteLength: Buffer.byteLength(htmlB),
    mediaType: "text/html",
    origin: "reconstructed_from_history" as const,
    finality: "final" as const,
    sourceRefs: ["ref:b"],
  };
  const manifest = {
    schemaVersion: 1 as const,
    sourceHash: "c".repeat(64),
    extractorVersion: "test-1",
    artifacts: [artifactA, artifactB],
    issues: [],
  };
  assert.ok(Value.Check(HistoricalArtifactManifestSchema, manifest));
  await mkdir(join(caseDir, "baseline-artifacts"), { recursive: true });
  await writeFile(join(caseDir, "baseline-artifacts", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const artifact of [artifactA, artifactB]) {
    const body = artifact.logicalPath.startsWith("a/") ? htmlA : htmlB;
    const filePath = join(caseDir, "baseline-artifacts", "files", artifact.bundleId, ...artifact.logicalPath.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body, "utf8");
  }
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId,
    source: { productId: "codex", sessionId: "nested" },
    initialInput: { id: "m1", role: "user", text: "task" },
    transcript: [],
    historicalEvents: [],
    baseline: {
      status: "available",
      artifactRefs: [
        { artifactId: artifactA.artifactId, caseId },
        { artifactId: artifactB.artifactId, caseId },
      ],
      evidenceRefs: [],
    },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  const prepared = await prepareHistoricalArtifacts({ taskCase, caseDir, attemptRoot });
  assert.equal(prepared.source, "case-manifest");
  assert.equal(prepared.finalsRoot, join(attemptRoot, "finals"));
  assert.ok(await readFile(join(prepared.finalsRoot, "a", "index.html"), "utf8").then((body) => body.includes("<title>a</title>")));
  assert.ok(await readFile(join(prepared.finalsRoot, "b", "index.html"), "utf8").then((body) => body.includes("<title>b</title>")));
  const sources = await discoverBaselineOpenableSources({
    attemptRoot,
    experimentRoot,
    runId: "run-1",
    dataDir: root,
    caseId,
    baselineArtifactNames: prepared.openableNames,
  });
  const openable = sources.filter((source) => /finals\/[ab]\/index\.html$/.test(source.inspectPath.replace(/\\/g, "/")));
  assert.equal(openable.length, 2);
  const { augmentComparisonOpenableMedia } = await import("../../src/application/comparison-openable-media.js");
  await assert.doesNotReject(() =>
    augmentComparisonOpenableMedia({
      attemptRoot,
      workspaceRoot: attemptRoot,
      links: [],
      baselineSources: openable,
      candidateSources: [],
    }),
  );
  assert.equal(sealedInspectPath(join(prepared.finalsRoot, "a", "index.html"), "a/index.html"), "finals/a/index.html");
  const mounts = comparisonAttemptMounts({
    experimentRoot,
    runId: "run-1",
    attemptRoot,
    candidateSnapshotStatus: "missing",
    candidateSnapshotRoot: join(attemptRoot, "candidate-missing"),
  });
  const tools = workspaceTools(attemptRoot, {
    mounts,
    denyDestructiveOnPrefix: ["candidate", "evidence", "history", "finals", "turns", "run", "observations"],
  });
  const reader = tools.find((tool) => tool.name === "read");
  assert.ok(reader);
  const signal = new AbortController().signal;
  const bodyA = await reader.execute({ path: "finals/a/index.html" }, signal);
  const bodyB = await reader.execute({ path: "finals/b/index.html" }, signal);
  assert.match(bodyA.content, /<title>a<\/title>/);
  assert.match(bodyB.content, /<title>b<\/title>/);
  // Flat basename must not appear as a second layout.
  await assert.rejects(readFile(join(prepared.finalsRoot, "index.html")));
});

test("historicalFinalSearchRoots lists attempt finals once via context", () => {
  const roots = historicalFinalSearchRoots({
    experimentRoot: "/exp",
    runId: "run-1",
    caseId: "case-1",
    attemptRoot: "/exp/comparison-attempts/a1",
  });
  const finals = roots.filter((root) => root.root.replace(/\\/g, "/") === "/exp/comparison-attempts/a1/finals");
  assert.equal(finals.length, 1);
  assert.equal(finals[0]?.mode, "recursive-basename");
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
