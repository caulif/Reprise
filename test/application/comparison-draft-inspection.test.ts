import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";
import { sha256 } from "../../src/core/identity.js";
import { instrumentTools } from "../../src/infrastructure/agent/tools.js";
import type { RenderGeometrySample } from "../../src/core/schema.js";
import type { EventEnvelope } from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { ComparisonDraftInspectionSchema } from "../../src/core/comparison-review-schema.js";
import { recoveryReviewBinding } from "../../src/application/comparison-recovery-review.js";

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
  const inspect = async () => {
    const tool = instrumentTools([draft.inspectTool()], "review", "comparison", { requestIndex: 0 })[0]!;
    const result = await tool.execute({}, new AbortController().signal);
    return JSON.parse(result.content) as Record<string, unknown>;
  };
  return { root, catalog, discovery, draft, inspect };
}

async function preview(f: Awaited<ReturnType<typeof fixture>>) {
  const html = await readFile(join(f.root, "report.html"), "utf8");
  const digest = sha256(html);
  f.draft.recordPreview({ htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest,
    catalogRevision: f.catalog.snapshot().revision, outputRoot: f.root });
}

test("fresh review clears compose inspection and requires actual final text delivery after every correction", async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  await f.inspect();
  await preview(f);
  assert.ok(await f.draft.completedResult());
  f.draft.beginReview();
  assert.equal(await f.draft.completedResult(), undefined);
  assert.match(f.draft.failureReason().message, /final_inspection_required/);
  const inspected = await f.inspect();
  assert.equal(inspected.reviewInspectionRequired, true);
  assert.equal(inspected.semanticValidation, "not_performed");
  assert.ok(await f.draft.completedResult());
  await f.draft.submit({ ...submission, detailsHtml: '<details><summary>Method</summary><p>Corrected limitation.</p></details>' });
  await preview(f);
  assert.equal(await f.draft.completedResult(), undefined);
  assert.match(String((await f.inspect()).detailsHtml), /Corrected limitation/);
  assert.ok(await f.draft.completedResult());
  await f.draft.submit({ ...submission, detailsHtml: '<details><summary>Method</summary><p>Corrected limitation.</p></details>' });
  assert.ok(await f.draft.completedResult());
  f.draft.beginReview();
  assert.equal(await f.draft.completedResult(), undefined);
});

test("failed audit and aborted tool delivery cannot satisfy the final inspection contract", async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  await preview(f);
  f.draft.beginReview();
  const failing = instrumentTools([f.draft.inspectTool()], "review", "comparison", { requestIndex: 0 }, {
    append: async event => { if (event.type === "agent.tool_completed") throw new Error("Audit write failed"); },
  })[0]!;
  await assert.rejects(failing.execute({}, new AbortController().signal), /tool execution failed/);
  assert.equal(await f.draft.completedResult(), undefined);
  const controller = new AbortController();
  const raw = f.draft.inspectTool();
  const aborting = instrumentTools([{ ...raw, execute: async (params, signal) => {
    const result = await raw.execute(params, signal);
    controller.abort();
    return result;
  } }], "review", "comparison", { requestIndex: 0 })[0]!;
  await assert.rejects(aborting.execute({}, controller.signal), /tool execution failed/);
  assert.equal(await f.draft.completedResult(), undefined);
  const pending = await raw.execute({}, new AbortController().signal);
  f.draft.beginReview();
  await raw.onCompleted!(pending);
  assert.equal(await f.draft.completedResult(), undefined);
  await f.inspect();
  assert.ok(await f.draft.completedResult());
});

test("inspection binding invalidates on decision declaration, findings or catalog even for unchanged HTML", async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  await f.draft.submit({ ...submission, decisionShape: "single_difference" });
  f.draft.beginReview();
  await f.inspect();
  await preview(f);
  assert.ok(await f.draft.completedResult());
  const originalHash = sha256(await readFile(join(f.root, "report.html"), "utf8"));
  await f.draft.submit({ ...submission, decisionShape: "multiple_differences" });
  assert.equal(sha256(await readFile(join(f.root, "report.html"), "utf8")), originalHash);
  await preview(f);
  assert.equal(await f.draft.completedResult(), undefined);
  await f.inspect();
  assert.ok(await f.draft.completedResult());
  await f.discovery!.update({ ...findings, importantLimitations: ["A corrected scope"] });
  assert.equal(await f.draft.completedResult(), undefined);
  await f.draft.submit({ ...submission, decisionShape: "multiple_differences" });
  await preview(f);
  assert.equal(await f.draft.completedResult(), undefined);
  await f.inspect();
  assert.ok(await f.draft.completedResult());
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "note.txt"), "Derived note");
  await f.catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "Derived note" });
  assert.equal(await f.draft.completedResult(), undefined);
  assert.equal((await f.inspect()).status, "stale");
});

test("inspection reads the latest accepted actual content without CSS and does not preview it", async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).status, "unavailable");
  const receipt = await f.draft.submit(submission);
  assert.match(receipt, /Length below 600/);
  assert.match(receipt, /Omit routine provenance.*already supplied by the Host/);
  assert.match(receipt, /Details are optional/);
  const first = await f.inspect();
  assert.equal(first.status, "available");
  assert.equal(first.headline, submission.headline);
  assert.equal(first.category, submission.category);
  assert.equal(first.reportStatus, submission.status);
  assert.equal(first.decisionShape, "unknown");
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
  assert.equal((await f.inspect()).status, "stale");
  await f.draft.submit(submission);
  assert.equal((await f.inspect()).findingsRevision, 2);
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "note.txt"), "Derived note");
  assert.equal((await f.catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "Derived note" })).status, "registered");
  assert.equal((await f.inspect()).status, "stale");
});

test("stale actual draft and question identities aid repair without certifying final or recovery inspection", async t => {
  const f = await fixture(t, true);
  const question = { id: "alignment", question: "Do final elements align?", decisionImpact: "Changes the guarantee",
    status: "unavailable" as const, evidenceRefs: [], resolution: "No paired sample yet" };
  const record = { ...findings, decisionQuestions: [question] };
  await f.discovery!.update(record);
  const absent = await f.inspect();
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.headline, undefined);
  assert.deepEqual((absent.repairContext as { decisionQuestions: unknown[] }).decisionQuestions, [question]);
  await f.draft.submit(submission);
  await preview(f);
  f.draft.beginReview();
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "note.txt"), "New evidence");
  await f.catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "New evidence" });
  const events: EventEnvelope[] = [];
  const append = (type: string, payload: Record<string, unknown>) => {
    const body = { schemaVersion: 1, sequence: events.length + 1, eventId: `e-${events.length}`, occurredAt: "2026-10-05T00:00:00.000Z", type, payload };
    events.push({ ...body, checksum: sha256(JSON.stringify(body)) });
  };
  append("comparison.review_started", { schemaVersion: 1, attemptId: "attempt", sessionId: "review", inspectionRequired: true });
  const tool = instrumentTools([f.draft.inspectTool()], "review", "comparison", { requestIndex: 0 }, {
    append: async event => { append(event.type, { ...event.payload, sessionId: event.sessionId, role: event.role, attemptId: "attempt" }); },
  })[0]!;
  const raw = await tool.execute({}, new AbortController().signal);
  const stale = JSON.parse(raw.content) as Record<string, unknown>;
  assert.equal(stale.status, "stale");
  assert.equal(stale.headline, submission.headline);
  assert.equal(stale.comparisonHtml, submission.comparisonHtml);
  assert.equal(stale.detailsHtml, submission.detailsHtml);
  assert.equal(raw.details, undefined);
  assert.equal(Value.Check(ComparisonDraftInspectionSchema, stale), false);
  const context = stale.repairContext as { readyToCompose: boolean; decisionQuestions: unknown[]; findings?: unknown };
  assert.equal(context.readyToCompose, false);
  assert.deepEqual(context.decisionQuestions, [question]);
  assert.equal(context.findings, undefined);
  assert.ok(!raw.content.includes(f.root));
  assert.equal(await f.draft.completedResult(), undefined);
  const recovered = await recoveryReviewBinding({ events, attemptId: "attempt", draftDigest: String(stale.draftDigest),
    catalogRevision: f.catalog.snapshot().revision, previewSessionId: "review", acceptedAfterSequence: 1,
    store: { experimentId: "exp", readArtifact: async () => { throw new Error("Should not resolve an uncertified inspection"); } },
    content: { headline: submission.headline, comparisonHtml: submission.comparisonHtml, detailsHtml: submission.detailsHtml } });
  assert.match(String(recovered), /No inspection/);
  await f.discovery!.update(record);
  await f.draft.submit({ ...submission, headline: "A corrected scoped difference" });
  await preview(f);
  assert.equal(await f.draft.completedResult(), undefined);
  assert.equal((await f.inspect()).status, "available");
  assert.ok(await f.draft.completedResult());
});

test("stale binding cannot expose tampered or missing draft text", async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  await f.draft.submit(submission);
  await f.discovery!.update({ ...findings, importantLimitations: ["New scope"] });
  await writeFile(join(f.root, "report.html"), "<p>Unaccepted injected text</p>");
  const tampered = await f.inspect();
  assert.equal(tampered.status, "unavailable");
  assert.equal(tampered.comparisonHtml, undefined);
  await rm(join(f.root, "report.html"));
  assert.equal((await f.inspect()).status, "unavailable");
});

test("inspection preserves actual render outcomes separately from current-session image delivery", async t => {
  const f = await fixture(t);
  const delivered = new Set<string>();
  const hash = "a".repeat(64);
  const geometrySample: RenderGeometrySample = { schemaVersion: 1, coordinateDomain: "viewport_css_pixels", startedAtMs: 538, finishedAtMs: 539,
    observations: [{ name: "wheel", selector: "#wheel", kind: "dom_rect", status: "ok",
      bounds: { x: 1, y: 2, width: 10, height: 10 }, screenPoints: [{ name: "center", x: 6, y: 7 }] }] };
  const draft = new ComparisonDraft({ attemptRoot: f.root, task: "Compare outputs", facts, locale: "en",
    catalog: f.catalog, deliveredImages: delivered,
    renderCheckHistory: () => ({ omitted: 2, records: [{ sourceRef: "ev-01", side: "baseline", sourceHash: hash,
      status: "motion_not_proven", requestedSampleTimesMs: [0, 500], viewport: { width: 300, height: 100, scale: 1 },
      frames: [{ sampleTimeMs: 500, actualTimeMs: 537, contentHash: hash, geometrySample }],
    }] }),
  });
  await draft.submit(submission);
  const inspect = async () => JSON.parse((await draft.inspectTool().execute({}, new AbortController().signal)).content) as {
    renderCheckHistory: { origin: string; omitted: number; records: { status: string; frames: { actualTimeMs: number; geometrySample?: RenderGeometrySample; nativeImageDeliveredToCurrentSession: boolean }[] }[] };
  };
  let history = (await inspect()).renderCheckHistory;
  assert.equal(history.origin, "this_comparison_attempt_not_candidate_runtime");
  assert.equal(history.omitted, 2);
  assert.equal(history.records[0]?.status, "motion_not_proven");
  assert.equal(history.records[0]?.frames[0]?.actualTimeMs, 537);
  assert.deepEqual(history.records[0]?.frames[0]?.geometrySample, geometrySample);
  assert.equal(history.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
  assert.equal(delivered.size, 0);
  delivered.add(hash);
  assert.equal((await inspect()).renderCheckHistory.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, true);
  delivered.clear();
  history = (await inspect()).renderCheckHistory;
  assert.deepEqual(history.records[0]?.frames[0]?.geometrySample, geometrySample);
  assert.equal(history.records[0]?.frames[0]?.actualTimeMs, 537);
  assert.equal(history.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "new-render.txt"), "Additional observed evidence");
  await f.catalog.registerEvidence({ relativePath: "new-render.txt", sourceRefs: ["ev-01"], label: "Additional evidence" });
  const staleResult = await draft.inspectTool().execute({}, new AbortController().signal);
  const stale = JSON.parse(staleResult.content) as { status: string; renderCheckHistory: typeof history };
  assert.equal(stale.status, "stale");
  assert.equal(staleResult.details, undefined);
  assert.deepEqual(stale.renderCheckHistory.records[0]?.frames[0]?.geometrySample, geometrySample);
  assert.equal(stale.renderCheckHistory.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
});
