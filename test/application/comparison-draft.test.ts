import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { sha256 } from "../../src/core/identity.js";

const facts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { candidate: "candidate", baseline: "baseline" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "available" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

test("Host draft submission validates content and publishes only the previewed digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set() });
  const tool = draft.tool();
  const signal = new AbortController().signal;
  const base = { status: "completed", category: "Results", headline: "The candidate differs.", comparisonHtml: "<p>A concrete difference.</p>" };

  const unsafe = await tool.execute({ ...base, comparisonHtml: "<script>alert(1)</script>" }, signal);
  assert.match(unsafe.content, /status=rejected/);
  await assert.rejects(readFile(join(root, "report.html"), "utf8"), { code: "ENOENT" });
  const unknown = await tool.execute({ ...base, comparisonHtml: '<p data-evidence-ref="ev-99">Claim</p>' }, signal);
  assert.match(unknown.content, /evidence_unresolved/);

  const accepted = await tool.execute(base, signal);
  assert.match(accepted.content, /status=accepted/);
  assert.equal(await draft.completedResult(), undefined);
  const html = await readFile(join(root, "report.html"), "utf8");
  const digest = sha256(html);
  draft.recordPreview({ htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest, catalogRevision: catalog.snapshot().revision, outputRoot: root });
  assert.equal((await draft.completedResult())?.headline, base.headline);

  await writeFile(join(root, "report.html"), `${html}\n<!-- changed -->`);
  assert.equal(await draft.completedResult(), undefined);
  await tool.execute({ ...base, headline: "A revised difference." }, signal);
  assert.equal(await draft.completedResult(), undefined);
});

test("draft preview uses the Host-normalized report and digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-normalized-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set() });
  const submitted = await draft.submit({
    status: "completed", category: "Results", headline: "A concrete difference.",
    comparisonHtml: "<p>The candidate attempt-abcdefgh differs.</p>",
  });
  const saved = await readFile(join(root, "report.html"), "utf8");
  const digest = sha256(saved);
  assert.doesNotMatch(saved, /attempt-abcdefgh/);
  assert.match(submitted, new RegExp(`draftDigest=${digest}`));
  const preview = await materializeComparisonReportPreview({
    attemptRoot: root, media: catalog.snapshot().media, evidence: catalog.snapshot().links,
    catalogRevision: catalog.snapshot().revision,
  });
  assert.equal(preview.draftDigest, digest);
  assert.doesNotMatch(preview.html, /attempt-abcdefgh/);
  const published = await verifyAndRenderComparisonReport({
    html: saved, hostTask: "Compare outputs.", facts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [], headline: "A concrete difference." },
    attemptRoot: root, evidence: catalog.snapshot().links, media: catalog.snapshot().media,
    locale: "en", deliveredImageContentHashes: new Set(),
  });
  assert.ok("html" in published);
  assert.equal(published.html, saved);
  draft.recordPreview(preview);
  assert.equal((await draft.completedResult())?.status, "completed");
});
