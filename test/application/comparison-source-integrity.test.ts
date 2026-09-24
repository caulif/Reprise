import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/identity.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { createComparisonRenderCatalogPort } from "../../src/application/comparison-render-catalog.js";
import { publishComparisonArtifacts, readRegisteredMediaBytes, verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { loadComparisonContentSnapshot } from "../../src/application/comparison-report-content.js";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const FACTS: ComparisonReportFacts = {
  run: { runId: "run-integrity", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { baseline: "historical-model", candidate: "current-model" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
  metrics: {},
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reprise-comparison-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const finals = join(root, "finals");
  await mkdir(finals);
  const html = "<!doctype html><title>Frozen result</title><p>Original output</p>";
  await writeFile(join(finals, "result.html"), html);
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptRoot: root,
    attemptId: "attempt-integrity",
    links: [{ side: "baseline", inspectPath: "finals/result.html", evidenceRef: "event:frozen", contentHash: sha256(html), origin: "historical_artifact" }],
    media: [],
  });
  const port = createComparisonRenderCatalogPort({
    catalog,
    attemptRoot: root,
    mounts: { finals, candidate: join(root, "candidate"), history: join(root, "history"), evidence: join(root, "evidence") },
  });
  return { root, finals, catalog, port, html };
}

test("registered source cannot silently change bytes while retaining its old identity", async (t) => {
  const { finals, catalog, port, html } = await fixture(t);
  const ref = catalog.snapshot().links[0]!.shortRef!;
  const initial = await port.resolveSource(ref);
  assert.equal(initial?.side, "baseline");
  assert.equal(initial?.contentHash, sha256(html));
  await writeFile(join(finals, "result.html"), "<!doctype html><p>A different delivery</p>");
  assert.equal(await port.resolveSource(ref), undefined);
  assert.equal(catalog.snapshot().links[0]!.contentHash, sha256(html));
});

test("registering report review media does not invalidate the comparison evidence revision", async (t) => {
  const { root, catalog, port } = await fixture(t);
  const pngPath = join(root, "review-frame.png");
  await writeFile(pngPath, PNG);
  const before = catalog.snapshot();
  const review = await port.registerDerivedMedia({
    side: "host", sourceRef: "report.html", pngPath, contentHash: sha256(PNG), label: "report-review", kind: "report_review",
    derivation: { rendererVersion: "review-test/v1", viewport: { width: 800, height: 600, scale: 1 }, sampleTimeMs: 0, actualTimeMs: 0, capturedAt: "2026-09-24T00:00:00.000Z" },
  });
  assert.equal(review.ok, true);
  if (!review.ok) return;
  assert.match(review.shortRef, /^review-/);
  assert.equal(port.revision(), before.revision);
  assert.deepEqual(catalog.snapshot(), before);
});

test("changed registered media cannot replace the previous successful report or its asset", async (t) => {
  const { root } = await fixture(t);
  const published = join(root, "published");
  await mkdir(join(root, "media"));
  await mkdir(join(published, "media"), { recursive: true });
  const oldHtml = '<!doctype html><img src="media/old.png" alt="previous result">';
  await writeFile(join(published, "report.html"), oldHtml);
  await writeFile(join(published, "media", "old.png"), PNG);
  await writeFile(join(root, "media", "new.png"), Buffer.from("changed after registration"));
  await assert.rejects(publishComparisonArtifacts({
    attemptRoot: root,
    experimentRoot: published,
    html: '<!doctype html><img src="media/new.png" alt="new result">',
    media: [{ ref: "media:new", shortRef: "media-01", side: "candidate", inspectPath: "media/new.png", reportHref: "media/new.png", mediaType: "image/png", contentHash: sha256(PNG), available: true }],
  }), /changed after registration|hash|integrity/i);
  assert.equal(await readFile(join(published, "report.html"), "utf8"), oldHtml);
  assert.deepEqual(await readFile(join(published, "media", "old.png")), PNG);
});

test("fragment references and claims are checked using HTML attribute semantics", async (t) => {
  const { root } = await fixture(t);
  const reportRoot = join(root, "work", "report");
  await mkdir(reportRoot, { recursive: true });
  await writeFile(join(reportRoot, "content.json"), JSON.stringify({ schemaVersion: 1, headline: "Evidence is unavailable", criticalLimitations: [], evidenceRefs: [] }));
  const cases = [
    ["<p data-evidence-ref=ev-999>Unsupported citation</p>", "evidence_unresolved"],
    ['<p data-evidence-ref="ev&#45;999">Encoded unsupported citation</p>', "evidence_unresolved"],
    ["<img data-media-ref=media-999 alt=Unknown>", "media_unavailable"],
    ['<img data-media-ref="media&#45;999" alt="Encoded unknown">', "media_unavailable"],
    ["<p data-claim=visual>Observed appearance</p>", "media_unavailable"],
    ['<p data-claim="vis&#117;al">Encoded visual claim</p>', "media_unavailable"],
    ["<p data-claim=verified>Verified correctness</p>", "evidence_unresolved"],
  ] as const;
  for (const [body, code] of cases) {
    await writeFile(join(reportRoot, "body.html"), body);
    const content = await loadComparisonContentSnapshot(root);
    const result = await verifyAndRenderComparisonReport({ content, hostTask: "Compare the outputs", facts: FACTS, attemptRoot: root, media: [], evidence: [], deliveredImageContentHashes: new Set() });
    assert.equal("failureClass" in result, true, body);
    if ("failureClass" in result) assert.equal(result.code, code, body);
  }
});

test("media staging rejects a directory junction outside the attempt even with matching bytes", async (t) => {
  const { root } = await fixture(t);
  const attempt = join(root, "attempt");
  const outside = join(root, "outside");
  await mkdir(attempt);
  await mkdir(outside);
  await writeFile(join(outside, "frame.png"), PNG);
  await symlink(outside, join(attempt, "media"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readRegisteredMediaBytes(attempt, "media/frame.png", {
    ref: "media:junction", shortRef: "media-01", side: "candidate", inspectPath: "media/frame.png", reportHref: "media/frame.png", mediaType: "image/png", contentHash: sha256(PNG), available: true,
  }), /escape|outside|contain|symlink|junction/i);
});

test("publication refuses a media destination junction and preserves the last report", async (t) => {
  const { root } = await fixture(t);
  const published = join(root, "published");
  const outside = join(root, "outside");
  await mkdir(join(root, "media"));
  await mkdir(published);
  await mkdir(outside);
  await writeFile(join(root, "media", "frame.png"), PNG);
  await writeFile(join(published, "report.html"), "previous successful report");
  await symlink(outside, join(published, "media"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishComparisonArtifacts({
    attemptRoot: root, experimentRoot: published,
    html: '<!doctype html><img src="media/frame.png" alt="result">',
    media: [{ ref: "media:frame", shortRef: "media-01", side: "candidate", inspectPath: "media/frame.png", reportHref: "media/frame.png", mediaType: "image/png", contentHash: sha256(PNG), available: true }],
  }), /escape|outside|contain|symlink|junction/i);
  assert.equal(await readFile(join(published, "report.html"), "utf8"), "previous successful report");
  await assert.rejects(readFile(join(outside, `${sha256(PNG).slice(0, 24)}.png`)), { code: "ENOENT" });
});
