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
import type { ComparisonDraftSubmission } from "../../src/core/schema.js";

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
  await draft.submit({ ...submission, status: "completed" });
  await draft.submit(submission);
  assert.equal(bindings, 3, 'status changes persist a new acceptance even with identical HTML');
  assert.equal(await draft.completedResult(), undefined);
  draft.recordPreview(preview);
  assert.equal((await draft.completedResult())?.status, "insufficient_evidence");
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

for (const change of [
  { name: 'status only', initialScope: 'undetermined', status: 'insufficient_evidence' },
  { name: 'scope only', initialScope: 'conditional', status: 'completed' },
  { name: 'status and scope', initialScope: 'conditional', status: 'insufficient_evidence' },
] as const) {
  test(`same HTML with changed ${change.name} requires new inspection and preview`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "reprise-draft-identity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
    const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set() });
    const submission: ComparisonDraftSubmission = { status: 'completed', category: 'Results', headline: 'A scoped difference.',
      comparisonHtml: '<p>A concrete difference.</p>', decisionShape: 'single_difference', conclusionScope: change.initialScope,
      decisionSummary: 'Both outputs are usable.', decisionBoundary: '', decisionBasis: [], findingDispositions: [] };
    const signal = new AbortController().signal;
    const submit = draft.tool();
    const accepted = await submit.execute(submission, signal);
    assert.match(accepted.content, /status=accepted/);
    const html = await readFile(join(root, 'report.html'), 'utf8');
    const digest = sha256(html);
    const preview = { htmlPath: 'preview.html', html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest,
      catalogRevision: catalog.snapshot().revision, outputRoot: root };
    draft.beginReview();
    const inspect = draft.inspectTool();
    const inspected = await inspect.execute({}, signal);
    await inspect.onCompleted?.(inspected);
    draft.recordPreview(preview);
    assert.equal((await draft.completedResult())?.status, 'completed');
    const identical = await submit.execute(structuredClone(submission), signal);
    assert.deepEqual(identical.details, accepted.details);
    assert.equal(draft.hasCurrentReviewInspection(), true);
    assert.equal((await draft.completedResult())?.status, 'completed');
    const pending = await inspect.execute({}, signal);
    const revisedSubmission = { ...submission, status: change.status, conclusionScope: 'undetermined' as const };
    const revised = await submit.execute(revisedSubmission, signal);
    assert.match(revised.content, /status=accepted/);
    assert.equal(await readFile(join(root, 'report.html'), 'utf8'), html);
    assert.deepEqual(revised.details, { ...accepted.details as object, bindingRevision: 2 });
    await inspect.onCompleted?.(pending);
    assert.equal(draft.hasCurrentReviewInspection(), false, 'old delivery cannot certify the new claim');
    assert.equal(draft.hasReviewDraftMaterial(), false);
    assert.equal(await draft.completedResult(), undefined);
    const fresh = await inspect.execute({}, signal);
    assert.match(fresh.content, new RegExp(`"reportStatus":"${change.status}"`));
    await inspect.onCompleted?.(fresh);
    assert.equal(draft.hasCurrentReviewInspection(), true);
    assert.equal(await draft.completedResult(), undefined, 'new inspection alone cannot reuse the old preview');
    draft.recordPreview(preview);
    assert.equal((await draft.completedResult())?.status, change.status);
    const repeated = await submit.execute(structuredClone(revisedSubmission), signal);
    assert.deepEqual(repeated.details, revised.details);
    assert.equal((await draft.completedResult())?.status, change.status);
  });
}

test("Host draft submission validates content and publishes only the previewed digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set() });
  const tool = draft.tool();
  const signal = new AbortController().signal;
  const base = { decisionSummary: "Both outputs remain usable with a scoped difference.", decisionBoundary: "", decisionBasis: [], conclusionScope: "undetermined", findingDispositions: [], status: "completed", decisionShape: "single_difference", category: "Results", headline: "The candidate differs.", comparisonHtml: "<p>A concrete difference.</p>" };

  const unsafe = await tool.execute({ ...base, comparisonHtml: "<script>alert(1)</script>" }, signal);
  assert.match(unsafe.content, /status=rejected/);
  assert.equal(draft.hasAcceptedDraft(), false);
  await assert.rejects(readFile(join(root, "report.html"), "utf8"), { code: "ENOENT" });
  const unknown = await tool.execute({ ...base, comparisonHtml: '<p data-evidence-ref="ev-99">Claim</p>' }, signal);
  assert.match(unknown.content, /evidence_unresolved/);

  const accepted = await tool.execute(base, signal);
  assert.match(accepted.content, /status=accepted/);
  assert.equal(draft.hasAcceptedDraft(), true);
  assert.equal(await draft.completedResult(), undefined);
  const html = await readFile(join(root, "report.html"), "utf8");
  const digest = sha256(html);
  draft.recordPreview({ htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest, catalogRevision: catalog.snapshot().revision, outputRoot: root });
  assert.equal((await draft.completedResult())?.headline, base.headline);

  await writeFile(join(root, "report.html"), `${html}\n<!-- changed -->`);
  assert.equal(draft.hasAcceptedDraft(), true, 'existence alone cannot certify the changed report');
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
