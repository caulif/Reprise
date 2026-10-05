import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";
import { sha256 } from "../../src/core/identity.js";

const facts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { candidate: "candidate", baseline: "baseline" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "available" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};
const submission = { status: "completed" as const, category: "Result", headline: "A scoped difference", comparisonHtml: "<p>Candidate preserves meaning.</p>", detailsHtml: "<p>Source inspection only.</p>" };
const findings = {
  criteria: ["Preserve meaning"], finals: [
    { side: "baseline" as const, status: "unavailable" as const, sourceRefs: [], description: "No final" },
    { side: "candidate" as const, status: "unavailable" as const, sourceRefs: [], description: "No final" },
  ], findings: [], decisionQuestions: [], importantLimitations: ["Missing final source"],
};

async function fixture(t: { after: (fn: () => Promise<void>) => void }, discoveryEnabled = false) {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [{ side: "baseline", inspectPath: "history/final.txt" }], media: [] });
  const discovery = discoveryEnabled ? new ComparisonDiscovery({ catalog, attemptId: "attempt-1", persist: async () => undefined }) : undefined;
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs", facts, locale: "en", catalog, deliveredImages: new Set(), ...(discovery ? { discovery } : {}) });
  const inspect = async () => JSON.parse((await draft.inspectTool().execute({}, new AbortController().signal)).content) as Record<string, unknown>;
  return { root, catalog, discovery, draft, inspect };
}

test("inspection reads the latest accepted actual content without CSS and does not preview it", async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).status, "unavailable");
  const receipt = await f.draft.submit(submission);
  assert.match(receipt, /Length below 600/);
  assert.match(receipt, /routine provenance.*may go in details/);
  const first = await f.inspect();
  assert.equal(first.status, "available");
  assert.equal(first.headline, submission.headline);
  assert.equal(first.category, submission.category);
  assert.equal(first.reportStatus, submission.status);
  assert.equal(first.comparisonHtml, submission.comparisonHtml);
  assert.equal(first.detailsHtml, submission.detailsHtml);
  assert.equal(first.draftDigest, sha256(await readFile(join(f.root, "report.html"), "utf8")));
  assert.equal(first.catalogRevision, f.catalog.snapshot().revision);
  assert.equal(first.semanticValidation, "not_performed");
  assert.doesNotMatch(JSON.stringify(first), /data-host-zone|font-family/);
  assert.ok(!JSON.stringify(first).includes(f.root));
  assert.equal(await f.draft.completedResult(), undefined);
  await f.draft.submit({ ...submission, headline: "A revised difference", comparisonHtml: "<p>A changed result.</p>" });
  const revised = await f.inspect();
  assert.notEqual(revised.draftDigest, first.draftDigest);
  assert.equal(revised.headline, "A revised difference");
  assert.equal(revised.comparisonHtml, "<p>A changed result.</p>");
  await assert.rejects(f.draft.inspectTool().execute({ unexpected: true }, new AbortController().signal), /Invalid draft inspection parameters/);
});

test("inspection fails closed for tampered or deleted files and propagates other IO errors", async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  await writeFile(join(f.root, "report.html"), "<p>Unaccepted content</p>");
  assert.equal((await f.inspect()).status, "unavailable");
  await rm(join(f.root, "report.html"));
  assert.equal((await f.inspect()).status, "unavailable");
  await mkdir(join(f.root, "report.html"));
  await assert.rejects(f.inspect());
});

test("inspection requires current findings and catalog bindings", async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  await f.draft.submit(submission);
  assert.equal((await f.inspect()).findingsRevision, 1);
  await f.discovery!.update({ ...findings, importantLimitations: ["Revised limitation"] });
  assert.equal((await f.inspect()).status, "unavailable");
  await f.draft.submit(submission);
  assert.equal((await f.inspect()).findingsRevision, 2);
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "note.txt"), "Derived note");
  assert.equal((await f.catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "Derived note" })).status, "registered");
  assert.equal((await f.inspect()).status, "unavailable");
});
