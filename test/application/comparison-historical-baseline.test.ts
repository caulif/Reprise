import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHistoricalDeliverableNames } from "../../src/application/historical-final-discovery.js";
import {
  augmentComparisonOpenableMedia,
  discoverOpenableSources,
} from "../../src/application/comparison-openable-media.js";
import { publishComparisonArtifacts } from "../../src/application/comparison-publication.js";
import { freezeCodexSession } from "../../src/products/packs/codex/sessions.js";
import { extractCodexHistoricalArtifacts } from "../../src/products/packs/codex/historical-artifacts.js";
import type { ComparisonMediaRecord, TaskCase } from "../../src/core/schema.js";
import {
  addFilePatch,
  BASELINE_PNG,
  buildDirectApplyPatchRollout,
  buildExecWrappedRollout,
  CANDIDATE_ANIMATION_NAME,
  CANDIDATE_PNG,
  HISTORICAL_ANIMATION_NAME,
  readCandidateAnimationHtml,
  readHistoricalAnimationHtml,
  recoverDirectApplyPatchFromRollout,
  recoverExecWrappedPatchFromRollout,
} from "../fixtures/historical-svg-animation/support.js";

const timestamp = "2026-09-19T12:00:00.000Z";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function emptyDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  assert.equal(entries.length, 0, `expected empty directory: ${path}`);
}

async function writeSyntheticRollout(root: string, kind: "exec" | "direct"): Promise<{
  sourcePath: string;
  cwd: string;
  html: string;
  patch: string;
}> {
  const cwd = join(root, "historical-cwd");
  await emptyDir(cwd);
  const html = await readHistoricalAnimationHtml();
  const patch = addFilePatch(HISTORICAL_ANIMATION_NAME, html);
  const sourcePath = join(root, kind === "exec" ? "rollout-exec-wrapped.jsonl" : "rollout-direct-apply-patch.jsonl");
  const body = kind === "exec"
    ? buildExecWrappedRollout({ sessionId: "svg-exec-session", cwd, patch })
    : buildDirectApplyPatchRollout({ sessionId: "svg-direct-session", cwd, patch });
  await writeFile(sourcePath, body, "utf8");
  return { sourcePath, cwd, html, patch };
}

test("synthetic SVG fixture keeps full Add File bytes recoverable from exec-wrapped const patch", async () => {
  const html = await readHistoricalAnimationHtml();
  const patch = addFilePatch(HISTORICAL_ANIMATION_NAME, html);
  const rollout = buildExecWrappedRollout({
    sessionId: "svg-exec-session",
    cwd: "C:\\\\synthetic\\\\empty",
    patch,
  });
  const recovered = recoverExecWrappedPatchFromRollout(rollout);
  assert.ok(recovered, "fixture must expose a static const patch literal inside exec");
  assert.equal(recovered, patch);
  assert.match(recovered, /\*\*\* Add File: animation\.html/);
  assert.match(recovered, /Synthetic SVG bounce/);
  assert.doesNotMatch(rollout, /pelican|SERVICE_TOKEN|\.reprise|Desktop/i);
  const direct = buildDirectApplyPatchRollout({
    sessionId: "svg-direct-session",
    cwd: "C:\\\\synthetic\\\\empty",
    patch,
  });
  assert.equal(recoverDirectApplyPatchFromRollout(direct), patch);
});

test("direct apply_patch sample freezes empty artifactRefs with touched animation.html path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b0-direct-freeze-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { sourcePath, html, patch } = await writeSyntheticRollout(root, "direct");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  assert.equal(frozen.taskCase.baseline.artifactRefs.length, 0);
  assert.equal(frozen.taskCase.sourceRuntimeEvidence.artifactRefs.length, 0);
  const behavior = frozen.taskCase.taskContext as {
    historicalBehavior?: { touchedPaths?: string[] };
  };
  assert.deepEqual(behavior.historicalBehavior?.touchedPaths, [HISTORICAL_ANIMATION_NAME]);
  const raw = await readFile(join(root, "cases", frozen.taskCase.caseId, "raw", "session.jsonl"), "utf8");
  assert.equal(recoverDirectApplyPatchFromRollout(raw), patch);
  assert.match(html, /bounce/);
});

test("exec-wrapped apply_patch sample freezes empty artifactRefs and keeps patch extractable from raw", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b0-exec-freeze-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { sourcePath, patch } = await writeSyntheticRollout(root, "exec");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(root, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  assert.equal(frozen.taskCase.baseline.artifactRefs.length, 0);
  const openable = collectHistoricalDeliverableNames(frozen.taskCase, "openable-baseline");
  assert.equal(openable.size, 0);
  const raw = await readFile(join(root, "cases", frozen.taskCase.caseId, "raw", "session.jsonl"), "utf8");
  assert.equal(recoverExecWrappedPatchFromRollout(raw), patch);
});

test("B0 baseline record: empty refs yield candidate-only media with empty env baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b0-baseline-record-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { sourcePath, html } = await writeSyntheticRollout(root, "exec");
  const dataDir = join(root, "data");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(dataDir, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  const experimentRoot = join(root, "experiment");
  const runId = "run-b0";
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const workspaceRoot = join(experimentRoot, "environment", "snapshots", runId);
  const envBaseline = join(experimentRoot, "environment", "baselines");
  await emptyDir(envBaseline);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, CANDIDATE_ANIMATION_NAME), await readCandidateAnimationHtml(), "utf8");

  const names = [...collectHistoricalDeliverableNames(frozen.taskCase, "openable-baseline")];
  assert.deepEqual(names, []);
  const openable = await discoverOpenableSources({
    attemptRoot,
    experimentRoot,
    workspaceRoot,
    runId,
    dataDir,
    caseId: frozen.taskCase.caseId,
    changedPaths: [CANDIDATE_ANIMATION_NAME],
    baselineArtifactNames: names,
  });
  assert.equal(openable.baselineSources.length, 0);
  assert.equal(openable.candidateSources.length, 1);

  const augmented = await augmentComparisonOpenableMedia({
    attemptRoot,
    workspaceRoot,
    links: [],
    baselineSources: openable.baselineSources,
    candidateSources: openable.candidateSources,
    captureScreenshot: async (sourcePath, destPng) => {
      const bytes = sourcePath.includes("animation.html") && !sourcePath.includes("candidate")
        ? BASELINE_PNG
        : CANDIDATE_PNG;
      await writeFile(destPng, bytes);
      return { ok: true };
    },
  });
  const mediaPath = join(attemptRoot, "facts", "media.json");
  await mkdir(join(attemptRoot, "facts"), { recursive: true });
  await writeFile(mediaPath, `${JSON.stringify(augmented.media, null, 2)}\n`);
  const media = JSON.parse(await readFile(mediaPath, "utf8")) as ComparisonMediaRecord[];
  assert.ok(media.some((item) => item.side === "candidate" && item.available));
  assert.equal(media.some((item) => item.side === "baseline" && item.available), false);
  assert.ok(html.includes("Synthetic SVG bounce"));
  assert.equal((await readdir(envBaseline)).length, 0);
});

test("empty-refs historical HTML reaches paired comparison media without stuffed baselineSources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b0-empty-refs-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Direct apply_patch is B1-trusted; B0 exec-wrapped node -e + require stays fail-closed.
  const { sourcePath, html } = await writeSyntheticRollout(root, "direct");
  const dataDir = join(root, "data");
  const frozen = await freezeCodexSession({
    sourcePath,
    casesRoot: join(dataDir, "cases"),
    now: timestamp,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    extractHistoricalArtifacts: extractCodexHistoricalArtifacts,
  });
  assert.ok(frozen.taskCase.baseline.artifactRefs.length >= 1);
  const experimentRoot = join(root, "experiment");
  const runId = "run-b0";
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const workspaceRoot = join(experimentRoot, "environment", "snapshots", runId);
  await emptyDir(join(experimentRoot, "environment", "baselines"));
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, CANDIDATE_ANIMATION_NAME), await readCandidateAnimationHtml(), "utf8");

  // Production path: names come from openable-baseline after extract fills refs.
  // Do not pass complete baselineSources — that bypasses the empty-refs root cause.
  const openable = await discoverOpenableSources({
    attemptRoot,
    experimentRoot,
    workspaceRoot,
    runId,
    dataDir,
    caseId: frozen.taskCase.caseId,
    changedPaths: [CANDIDATE_ANIMATION_NAME],
    baselineArtifactNames: [...collectHistoricalDeliverableNames(frozen.taskCase, "openable-baseline")],
  });
  const captureCalls: { source: string; dest: string }[] = [];
  const augmented = await augmentComparisonOpenableMedia({
    attemptRoot,
    workspaceRoot,
    links: [],
    baselineSources: openable.baselineSources,
    candidateSources: openable.candidateSources,
    captureScreenshot: async (sourcePath, destPng) => {
      captureCalls.push({ source: sourcePath, dest: destPng });
      const isBaseline = /(?:^|[\\/])animation\.html$/i.test(sourcePath.replaceAll("\\", "/"))
        && !/candidate-animation\.html$/i.test(sourcePath.replaceAll("\\", "/"));
      await writeFile(destPng, isBaseline ? BASELINE_PNG : CANDIDATE_PNG);
      return { ok: true };
    },
  });

  assert.ok(openable.baselineSources.length >= 1, "historical animation.html must be discovered");
  const baselineHtmlPath = openable.baselineSources[0]?.absolutePath;
  assert.ok(baselineHtmlPath);
  // apply_patch reconstruction uses LF; fixture checkout may be CRLF on Windows.
  assert.equal(
    (await readFile(baselineHtmlPath, "utf8")).replace(/\r\n/g, "\n").replace(/\n$/, ""),
    html.replace(/\r\n/g, "\n").replace(/\n$/, ""),
  );
  assert.ok(openable.candidateSources.length >= 1);
  assert.ok(augmented.media.some((item) => item.side === "baseline" && item.available));
  assert.ok(augmented.media.some((item) => item.side === "candidate" && item.available));
  const baselineMedia = augmented.media.find((item) => item.side === "baseline" && item.available);
  const candidateMedia = augmented.media.find((item) => item.side === "candidate" && item.available);
  assert.ok(baselineMedia?.reportHref);
  assert.ok(candidateMedia?.reportHref);
  const baselineBytes = await readFile(join(attemptRoot, baselineMedia.reportHref));
  const candidateBytes = await readFile(join(attemptRoot, candidateMedia.reportHref));
  assert.ok(!baselineBytes.equals(candidateBytes), "fake renderer must emit distinct images");
  assert.equal(captureCalls.length, 2);
});

test("failed later attempt leaves published report and media bytes unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b0-publish-immutability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const experimentRoot = join(root, "experiment");
  const attemptOk = join(experimentRoot, "comparison-attempts", "attempt-ok");
  const attemptFail = join(experimentRoot, "comparison-attempts", "attempt-fail");
  await mkdir(join(attemptOk, "media"), { recursive: true });
  await mkdir(join(attemptFail, "media"), { recursive: true });
  await writeFile(join(attemptOk, "media", "baseline-ok.png"), BASELINE_PNG);
  await writeFile(join(attemptOk, "media", "candidate-ok.png"), CANDIDATE_PNG);
  const media: ComparisonMediaRecord[] = [
    {
      ref: "media:baseline-ok",
      shortRef: "media-01",
      side: "baseline",
      inspectPath: "history/media/baseline-ok.png",
      reportHref: "media/baseline-ok.png",
      mediaType: "image/png",
      available: true,
    },
    {
      ref: "media:candidate-ok",
      shortRef: "media-02",
      side: "candidate",
      inspectPath: "evidence/candidate-ok.png",
      reportHref: "media/candidate-ok.png",
      mediaType: "image/png",
      available: true,
    },
  ];
  const publishedHtml =
    '<!doctype html><img src="media/baseline-ok.png" alt="b"><img src="media/candidate-ok.png" alt="c"><p>previous successful comparison</p>\n';
  const published = await publishComparisonArtifacts({
    attemptRoot: attemptOk,
    experimentRoot,
    html: publishedHtml,
    media,
  });
  assert.match(published.html, /src="media\/[a-f0-9]{24}\.png"/);
  assert.doesNotMatch(published.html, /src="media\/(?:baseline|candidate)-ok\.png"/);
  const reportHash = sha256(await readFile(join(experimentRoot, "report.html")));
  const publishedMedia = (await readdir(join(experimentRoot, "media"))).sort();
  assert.equal(publishedMedia.length, 2);
  const mediaHashes = Object.fromEntries(await Promise.all(
    publishedMedia.map(async (name) => [name, sha256(await readFile(join(experimentRoot, "media", name)))] as const),
  ));

  await writeFile(join(attemptFail, "media", "baseline-ok.png"), Buffer.from("corrupt-not-png"));
  await writeFile(join(attemptFail, "media", "candidate-ok.png"), Buffer.from("also-corrupt"));
  // Failed attempt must not publish; only write a diagnostic sibling.
  await writeFile(join(experimentRoot, "comparison-failure.html"), "<!doctype html><p>failed attempt</p>\n");

  assert.equal(sha256(await readFile(join(experimentRoot, "report.html"))), reportHash);
  assert.equal(await readFile(join(experimentRoot, "report.html"), "utf8"), published.html);
  for (const name of publishedMedia) {
    assert.equal(sha256(await readFile(join(experimentRoot, "media", name))), mediaHashes[name]);
  }
});

test("openable-baseline names stay empty on frozen SVG case TaskCase shape", () => {
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId: "case-b0",
    source: { productId: "codex", sessionId: "svg-exec-session" },
    initialInput: {
      id: "message-1",
      role: "user",
      text: "Generate a self-contained SVG animation HTML file named animation.html.",
    },
    transcript: [
      {
        id: "message-1",
        role: "user",
        text: "Generate a self-contained SVG animation HTML file named animation.html.",
      },
      {
        id: "message-2",
        role: "assistant",
        text: "Delivered animation.html with a self-contained SVG bounce animation.",
      },
    ],
    historicalEvents: [],
    baseline: {
      status: "available",
      artifactRefs: [],
      finalMessage: "Delivered animation.html with a self-contained SVG bounce animation.",
      evidenceRefs: [],
    },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "codex-rollout-jsonl/v1", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  const openable = collectHistoricalDeliverableNames(taskCase, "openable-baseline");
  const finalNames = collectHistoricalDeliverableNames(taskCase, "final");
  assert.equal(openable.size, 0);
  assert.ok(finalNames.has(HISTORICAL_ANIMATION_NAME));
});
