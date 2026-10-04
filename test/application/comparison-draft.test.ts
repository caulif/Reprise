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
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";

const facts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { candidate: "candidate", baseline: "baseline" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "available" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

test("production drafts require settled findings and invalidate preview after findings change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-findings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: "attempt-1", persist: async () => undefined });
  let bindings = 0;
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set(), discovery, persistAccepted: async () => { bindings++; } });
  const submission = { status: "insufficient_evidence" as const, category: "Limited comparison", headline: "Final artifacts unavailable", comparisonHtml: "<p>Both finals unavailable.</p>" };
  assert.match(await draft.submit(submission), /findings_not_ready/);
  assert.match(draft.failureReason().message, /findings_not_ready/);
  const findings = {
    criteria: ["Preserve meaning"], finals: [
      { side: "baseline" as const, status: "unavailable" as const, sourceRefs: [], description: "No final source" },
      { side: "candidate" as const, status: "unavailable" as const, sourceRefs: [], description: "No final source" },
    ], findings: [], decisionQuestions: [], importantLimitations: ["Missing final sources"],
  };
  await discovery.update(findings);
  assert.match(await draft.submit(submission), /importantLimitations=.*Missing final sources/);
  const html = await readFile(join(root, "report.html"), "utf8");
  const digest = sha256(html);
  const preview = { htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest, catalogRevision: catalog.snapshot().revision, outputRoot: root };
  draft.recordPreview(preview);
  assert.ok(await draft.completedResult());
  await draft.submit(submission);
  assert.equal(bindings, 1);
  assert.ok(await draft.completedResult());
  await discovery.update({ ...findings, importantLimitations: ["New evidence gap"] });
  assert.equal(await draft.completedResult(), undefined);
  assert.match(draft.submissionState(), /discoveryRevision/);
  await draft.submit(submission);
  assert.equal(await draft.completedResult(), undefined);
  draft.recordPreview(preview);
  assert.ok(await draft.completedResult());
  const long = await draft.submit({ ...submission, comparisonHtml: `<p>${"Detail ".repeat(110)}</p><details><summary>Methods</summary>${"method ".repeat(500)}</details>` });
  assert.match(long, /advisory, not a word-limit gate/);
  assert.match(long, /mainTextCharacters=805/);
});

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
