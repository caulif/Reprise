import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";
import { sha256 } from "../../src/core/identity.js";
import { instrumentTools } from "../../src/infrastructure/agent/tools.js";
import type { RenderGeometrySample, ComparisonFindingsSubmission, ComparisonDraftSubmission } from "../../src/core/schema.js";
import type { EventEnvelope } from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { Type } from '@sinclair/typebox';
import { ComparisonFindingsSubmissionSchema } from '../../src/core/schema.js';
import { ComparisonDraftInspectionSchema } from "../../src/core/comparison-review-schema.js";
import { recoveryReviewBinding } from "../../src/application/comparison-recovery-review.js";
import { prunePiMessagesForBudget } from '../../src/infrastructure/agent/compaction.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { comparisonToolTextBytes } from '../../src/application/comparison-render-output.js';
import { readComparisonJsonPages } from './comparison-paged-json-reader.js';
import { comparisonToolFeedback } from '../../src/agents/comparison-tool-feedback.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import { toolDeliveryToken } from '../../src/infrastructure/agent/tool-delivery.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/host.js';

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

async function fixture(t: { after: (fn: () => Promise<void>) => void }, discoveryEnabled = false, candidateLink = false) {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [{ side: "baseline", inspectPath: "history/final.txt" }, ...(candidateLink ? [{ side: 'candidate' as const, inspectPath: 'candidate/final.txt' }] : [])], media: [] });
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

test("saved important limitations require a visible decision boundary only for the new submission contract", async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  assert.match(await f.draft.submit(submission), /status=accepted/);
  const current = await readFile(join(f.root, 'report.html'), 'utf8');
  for (const decisionBoundary of ['', ' \n\t']) {
    const rejected = await f.draft.submit({ ...submission, status: 'insufficient_evidence', conclusionScope: 'undetermined', decisionBasis: [], findingDispositions: [], decisionSummary: 'Cannot establish final usability.', decisionBoundary });
    assert.match(rejected, /code=decision_boundary_missing/);
    assert.match(rejected, /Missing final source/);
    assert.match(rejected, /unverified model-authored repair material/);
    assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), current);
  }
  assert.match(await f.draft.submit({ ...submission, status: 'insufficient_evidence', conclusionScope: 'undetermined', decisionBasis: [], findingDispositions: [], decisionSummary: 'Cannot establish final usability.',
    decisionBoundary: 'Final delivery remains unverified.' }), /status=accepted/);
  assert.match(await f.draft.submit({ ...submission, decisionSummary: 'Earlier typed summary.', decisionBoundary: 'Final delivery remains unverified.' }), /status=accepted/);
  assert.match(String((await f.inspect()).comparisonHtml), /Final delivery remains unverified/);
});

test('decision dependencies cover exact current findings and reject unsupported scope without replacing accepted bytes', async t => {
  const f = await fixture(t, true, true);
  const observation = (side: 'baseline' | 'candidate') => ({ side, method: 'source_inspection' as const, result: 'Final output inspected', scope: 'Final relation',
    evidenceRefs: [f.catalog.snapshot().links.find(link => link.side === side)!.shortRef!], timing: 'comparison_check' as const,
    supportBoundary: { relationship: 'Output relation', domain: 'Final result', supportStage: 'delivered_output' as const, coveredInstances: ['Both branches'], uncheckedInstances: [] as string[] } });
  const first = { id: 'f1', criterion: findings.criteria[0]!, difference: 'Difference', userConsequence: 'Task use', observations: [observation('baseline'), observation('candidate')], limitations: [], counterEvidenceRefs: [] };
  const snapshot: ComparisonFindingsSubmission = { ...findings, importantLimitations: [], findings: [first, { ...first, id: 'f2' }] };
  assert.match(await f.discovery!.update(snapshot), /status=accepted/);
  const modern: ComparisonDraftSubmission = { ...submission, headline: 'Task choice', comparisonHtml: '<p>Evidence.</p>', decisionSummary: 'Both usable with a scoped choice.', decisionBoundary: '',
    decisionShape: 'single_difference', decisionBasis: ['f1'], conclusionScope: 'supported_in_scope',
    findingDispositions: [{ findingId: 'f1', disposition: 'basis', explanation: 'Changes task use' }, { findingId: 'f2', disposition: 'not_decisive', explanation: 'Does not change this choice' }] };
  assert.match(await f.draft.submit(modern), /status=accepted/);
  const accepted = await readFile(join(f.root, 'report.html'), 'utf8');
  for (const findingDispositions of [modern.findingDispositions!.slice(0, 1), [...modern.findingDispositions!, modern.findingDispositions![0]!],
    [modern.findingDispositions![0]!, { ...modern.findingDispositions![1]!, findingId: 'unknown' }]]) {
    assert.match(await f.draft.submit({ ...modern, findingDispositions }), /decision_findings_invalid/);
  }
  for (const decisionBasis of [[], ['unknown'], ['f1', 'f1'], ['f2']]) assert.match(await f.draft.submit({ ...modern, decisionBasis }), /decision_basis_invalid/);
  assert.match(await f.draft.submit({ ...modern, decisionBasis: [], findingDispositions: modern.findingDispositions!.map(item => ({ ...item, disposition: 'not_decisive' })) }), /decision_basis_missing/);
  assert.match(await f.draft.submit({ ...modern, status: 'insufficient_evidence' }), /decision_scope_invalid/);
  assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), accepted);
  for (const supportBoundary of [undefined, { ...first.observations[1]!.supportBoundary, supportStage: 'intermediate_only' as const },
    { ...first.observations[1]!.supportBoundary, supportStage: 'unavailable' as const, coveredInstances: [] },
    { ...first.observations[1]!.supportBoundary, uncheckedInstances: ['Output branch'] }]) {
    const { supportBoundary: _prior, ...priorObservation } = first.observations[1]!;
    const current = { ...snapshot, findings: [{ ...first, observations: [first.observations[0]!, { ...priorObservation, ...(supportBoundary ? { supportBoundary } : {}) }] }, snapshot.findings[1]!] };
    assert.match(await f.discovery!.update(current), /status=accepted/);
    assert.match(await f.draft.submit(modern), /decision_scope_incomplete/);
    assert.match(await f.draft.submit({ ...modern, conclusionScope: 'conditional' }), /status=accepted/);
    const material = await f.inspect();
    const inspected = String(material.comparisonHtml);
    assert.match(inspected, /Basis 1: Current run: (delivered-output support unverified|limited delivered-output coverage)/);
    assert.match(String(material.detailsHtml), /Basis 1: Preserve meaning/);
    if (supportBoundary?.uncheckedInstances.length) {
      assert.doesNotMatch(inspected, /Output branch/);
      assert.match(String(material.detailsHtml), /Output branch/);
    }
    assert.match(await f.draft.submit({ ...modern, conclusionScope: 'conditional', decisionSummary: '用'.repeat(240) }), /draft_too_long/);
    const asBoundary = { ...modern, decisionBasis: ['f2'], findingDispositions: modern.findingDispositions!.map(item => ({ ...item, disposition: item.findingId === 'f1' ? 'boundary' as const : 'basis' as const })) };
    assert.match(await f.draft.submit(asBoundary), /decision_scope_incomplete/);
  }
  const longScope = { ...snapshot, findings: [{ ...first, observations: [first.observations[0]!, {
    ...first.observations[1]!, supportBoundary: { ...first.observations[1]!.supportBoundary,
      uncheckedInstances: Array.from({ length: 12 }, (_, index) => `Output branch ${index}: ${'x'.repeat(40)}`) },
  }] }, snapshot.findings[1]!] };
  assert.match(await f.discovery!.update(longScope), /status=accepted/);
  const beforeRejectedDetails = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.match(await f.draft.submit({ ...modern, conclusionScope: 'conditional', detailsHtml: '' }), /draft_details_too_long/);
  assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), beforeRejectedDetails);
});

test('current formal inspection getter requires complete successful delivery and exact current bindings', async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  await f.draft.submit(submission);
  f.draft.beginReview();
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  const tool = f.draft.inspectTool();
  const result = await tool.execute({}, new AbortController().signal);
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  await tool.onCompleted!({ ...result, content: JSON.stringify({ status: 'available', headline: submission.headline, comparisonHtml: '<p>Partial</p>', detailsHtml: submission.detailsHtml }) });
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  await f.inspect();
  assert.equal(f.draft.hasCurrentReviewInspection(), true);
  await f.discovery!.update({ ...findings, importantLimitations: ['Revised scope'] });
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  await f.draft.submit(submission);
  await f.inspect();
  assert.equal(f.draft.hasCurrentReviewInspection(), true);
  f.draft.beginReview();
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  await f.inspect();
  assert.equal(f.draft.hasCurrentReviewInspection(), true);
  const revision = f.catalog.snapshot().revision;
  await mkdir(join(f.root, 'scratch'), { recursive: true });
  await writeFile(join(f.root, 'scratch', 'new.txt'), 'New source');
  assert.equal((await f.catalog.registerEvidence({ relativePath: 'new.txt', sourceRefs: ['ev-01'], label: 'Revision' })).status, 'registered');
  assert.ok(f.catalog.snapshot().revision > revision);
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
});

test('a later failed preview invalidates prior success for the same accepted digest', async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  await preview(f);
  assert.ok(await f.draft.completedResult());
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  const digest = sha256(html);
  f.draft.recordPreviewOutcome({ htmlPath: 'preview.html', html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest,
    catalogRevision: f.catalog.snapshot().revision, outputRoot: f.root }, { status: 'timeout', message: 'Latest check timed out' });
  assert.equal(await f.draft.completedResult(), undefined);
  assert.match(f.draft.failureReason().message, /Latest check timed out/);
});

test('draft audit keeps delivered text but revokes checkpoint inspection, preview and pending delivery', async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  f.draft.beginReview();
  await f.inspect();
  await preview(f);
  assert.ok(await f.draft.completedResult());
  f.draft.beginDraftAudit();
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  assert.equal(await f.draft.completedResult(), undefined);
  const tool = f.draft.inspectTool();
  const delayed = await tool.execute({}, new AbortController().signal);
  f.draft.beginDraftAudit();
  await tool.onCompleted!(delayed);
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  await f.inspect();
  assert.equal(f.draft.hasCurrentReviewInspection(), true);
  assert.equal(await f.draft.completedResult(), undefined);
  await preview(f);
  assert.ok(await f.draft.completedResult());
  const inFlight = tool.execute({}, new AbortController().signal);
  f.draft.beginDraftAudit();
  await tool.onCompleted!(await inFlight);
  assert.equal(f.draft.hasCurrentReviewInspection(), false);
  assert.equal(await f.draft.completedResult(), undefined);
});

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
  assert.equal(Value.Check(ComparisonDraftInspectionSchema, raw.details), false);
  assert.equal(f.draft.hasReviewDraftMaterial(), true, 'stale actual text permits repair, not formal certification');
  assert.equal(Value.Check(ComparisonDraftInspectionSchema, stale), false);
  const context = stale.repairContext as { readyToCompose: boolean; decisionQuestions: unknown[]; findings?: unknown };
  assert.equal(context.readyToCompose, false);
  assert.deepEqual(context.decisionQuestions, [question]);
  assert.equal(context.findings, undefined);
  assert.ok(!raw.content.includes(f.root));
  assert.equal(await f.draft.completedResult(), undefined);
  assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined);
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
    renderCheckHistory: { origin: string; omitted: number; records: { status: string; frames: { actualTimeMs: number; geometrySample?: RenderGeometrySample; geometryWindow?: { startedAtMs: number; finishedAtMs: number }; nativeImageDeliveredToCurrentSession: boolean }[] }[] };
  };
  let history = (await inspect()).renderCheckHistory;
  assert.equal(history.origin, "this_comparison_attempt_not_candidate_runtime");
  assert.equal(history.omitted, 2);
  assert.equal(history.records[0]?.status, "motion_not_proven");
  assert.equal(history.records[0]?.frames[0]?.actualTimeMs, 537);
  assert.equal(history.records[0]?.frames[0]?.geometrySample, undefined);
  assert.equal(history.records[0]?.frames[0]?.geometryWindow?.startedAtMs, geometrySample.startedAtMs);
  assert.equal(history.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
  assert.equal(delivered.size, 0);
  delivered.add(hash);
  assert.equal((await inspect()).renderCheckHistory.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, true);
  delivered.clear();
  history = (await inspect()).renderCheckHistory;
  assert.equal(history.records[0]?.frames[0]?.geometryWindow?.finishedAtMs, geometrySample.finishedAtMs);
  assert.equal(history.records[0]?.frames[0]?.actualTimeMs, 537);
  assert.equal(history.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
  await mkdir(join(f.root, "scratch"));
  await writeFile(join(f.root, "scratch", "new-render.txt"), "Additional observed evidence");
  await f.catalog.registerEvidence({ relativePath: "new-render.txt", sourceRefs: ["ev-01"], label: "Additional evidence" });
  const staleResult = await draft.inspectTool().execute({}, new AbortController().signal);
  const stale = JSON.parse(staleResult.content) as { status: string; renderCheckHistory: typeof history };
  assert.equal(stale.status, "stale");
  assert.equal(staleResult.details, undefined);
  assert.equal(stale.renderCheckHistory.records[0]?.frames[0]?.geometryWindow?.startedAtMs, geometrySample.startedAtMs);
  assert.equal(stale.renderCheckHistory.records[0]?.frames[0]?.nativeImageDeliveredToCurrentSession, false);
});

test('large render inventories cannot stub the complete final inspection or turn it into a false receipt', async t => {
  const f = await fixture(t);
  const draft = new ComparisonDraft({ attemptRoot: f.root, task: 'Compare outputs', facts, locale: 'en', catalog: f.catalog,
    deliveredImages: new Set(), renderCheckHistory: () => ({ omitted: 0, records: Array.from({ length: 12 }, () => ({
      sourceRef: 'ev-01', side: 'baseline' as const, sourceHash: 'a'.repeat(64), status: 'ok' as const,
      requestedSampleTimesMs: [0], viewport: { width: 1000, height: 700, scale: 1 },
      frames: Array.from({ length: 8 }, (_, i) => ({ sampleTimeMs: i * 500, actualTimeMs: i * 500 + 7, contentHash: 'b'.repeat(64) })),
    })) }) });
  await draft.submit(submission);
  const result = await draft.inspectTool().execute({}, new AbortController().signal);
  const content: unknown = JSON.parse(result.content);
  assert.ok(Value.Check(Type.Object({ status: Type.String(), headline: Type.String(), comparisonHtml: Type.String(), detailsHtml: Type.String(),
    renderCheckHistory: Type.Object({ omitted: Type.Number() }) }), content));
  assert.equal(content.status, 'available');
  assert.equal(content.headline, submission.headline);
  assert.equal(content.comparisonHtml, submission.comparisonHtml);
  assert.equal(content.detailsHtml, submission.detailsHtml);
  assert.ok(content.renderCheckHistory.omitted > 0);
  assert.ok(comparisonToolTextBytes(content) <= 12_288);
  const messages: AgentMessage[] = [{ role: 'toolResult', toolName: 'inspect_comparison_draft', toolCallId: 'call', timestamp: 0, isError: false,
    content: [{ type: 'text', text: result.content }] }];
  assert.equal(prunePiMessagesForBudget(messages).changed, false);
  await draft.submit({ ...submission, comparisonHtml: `<p>Meaning.</p>${'<span></span>'.repeat(2000)}` });
  const large = await draft.inspectTool().execute({}, new AbortController().signal);
  const unavailable: unknown = JSON.parse(large.content);
  assert.ok(Value.Check(Type.Object({ status: Type.Literal('unavailable') }), unavailable));
  assert.equal(large.details, undefined);
  assert.match(large.content, /no partial text/);
});

test('oversized historical repair questions are readable in bounded pages without injecting author findings', async t => {
  const f = await fixture(t, true);
  const record = { ...findings, decisionQuestions: Array.from({ length: 16 }, (_, i) => ({ id: `q${i}`, question: '问题🚲'.repeat(300),
    decisionImpact: '结论🌍'.repeat(300), status: 'unavailable' as const, resolution: '观察🔍'.repeat(300), evidenceRefs: [] })) };
  await f.discovery!.update(record);
  await f.draft.submit(submission);
  await f.discovery!.update({ ...record, importantLimitations: ['Updated scope'] });
  const result = await f.draft.inspectTool().execute({}, new AbortController().signal);
  const content: unknown = JSON.parse(result.content);
  assert.ok(Value.Check(Type.Object({ status: Type.String(), repairContext: Type.Object({ fullHistory: Type.Object({ path: Type.String() }) }) }), content));
  assert.equal(content.status, 'stale');
  assert.ok(comparisonToolTextBytes(content) <= 12_288);
  const pages = await readComparisonJsonPages(f.root, content.repairContext.fullHistory.path);
  const full: unknown = JSON.parse(pages);
  assert.ok(Value.Check(Type.Pick(ComparisonFindingsSubmissionSchema, ['decisionQuestions']), full));
  assert.deepEqual(full.decisionQuestions, record.decisionQuestions);
  assert.equal('findings' in full, false);
  assert.equal(result.details, undefined);
  const relativePath = content.repairContext.fullHistory.path;
  const originalBytes = await readFile(join(f.root, relativePath));
  const allowed = { path: relativePath, offset: 4096, maxBytes: 4096, format: 'text' };
  assert.equal(await f.draft.isRepairRead(allowed), true);
  assert.equal(await f.draft.isRepairRead({ path: relativePath, maxBytes: 1 }), true);
  for (const params of [{ ...allowed, path: `./${relativePath}` }, { ...allowed, path: 'report.html' },
    { ...allowed, path: 'scratch' }, { ...allowed, maxBytes: 4097 }, { ...allowed, maxBytes: 0 },
    { ...allowed, maxBytes: undefined }, { ...allowed, offset: -1 }, { ...allowed, offset: 0.5 },
    { ...allowed, offset: Number.MAX_SAFE_INTEGER + 1 }, { ...allowed, offset: originalBytes.byteLength + 1 },
    { ...allowed, format: 'image' }, { ...allowed, mimeType: 'image/png' }]) {
    assert.equal(await f.draft.isRepairRead(params), false);
  }
  await writeFile(join(f.root, 'scratch', 'uncertified-history.json'), originalBytes);
  assert.equal(await f.draft.isRepairRead({ path: 'scratch/uncertified-history.json', maxBytes: 4096 }), false);
  await writeFile(join(f.root, relativePath), '{broken');
  assert.equal(await f.draft.isRepairRead(allowed), false);
  await rm(join(f.root, relativePath));
  assert.equal(await f.draft.isRepairRead(allowed), false);
  await mkdir(join(f.root, relativePath));
  assert.equal(await f.draft.isRepairRead(allowed), false);
  await rm(join(f.root, relativePath), { recursive: true });
  await writeFile(join(f.root, relativePath), originalBytes);
  const external = await mkdtemp(join(tmpdir(), 'reprise-repair-read-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, basename(relativePath)), originalBytes);
  await rename(join(f.root, 'scratch'), join(f.root, 'scratch-original'));
  await symlink(external, join(f.root, 'scratch'), 'junction');
  assert.equal(await f.draft.isRepairRead(allowed), false, 'same-hash file behind an external parent junction must not be read');
  await unlink(join(f.root, 'scratch'));
  await rename(join(f.root, 'scratch-original'), join(f.root, 'scratch'));
  assert.equal(await f.draft.isRepairRead(allowed), true);
});

test('review material requires actual current tool completion and never inherits author inspection', async t => {
  const f = await fixture(t);
  await f.draft.submit(submission);
  await f.inspect();
  assert.equal(f.draft.hasReviewDraftMaterial(), false, 'author-session text is not review delivery');
  f.draft.beginReview();
  const raw = f.draft.inspectTool();
  const pending = await raw.execute({}, new AbortController().signal);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await raw.onCompleted!({ content: JSON.stringify({ status: 'available', headline: submission.headline }), details: { ...(pending.details as object) } });
  assert.equal(f.draft.hasReviewDraftMaterial(), false, 'partial or synthesized material cannot match the complete inspected body');
  await raw.onCompleted!(pending);
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
  f.draft.beginReview();
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
});

for (const change of ['epoch', 'catalog', 'findings', 'accepted'] as const) test(`pending material delivery cannot cross a changed ${change} binding`, async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings);
  await f.draft.submit(submission);
  f.draft.beginReview();
  const tool = f.draft.inspectTool();
  const pending = await tool.execute({}, new AbortController().signal);
  if (change === 'epoch') f.draft.beginReview();
  if (change === 'findings') await f.discovery!.update({ ...findings, importantLimitations: ['Changed finding scope'] });
  if (change === 'accepted') await f.draft.submit({ ...submission, headline: 'Changed accepted headline' });
  if (change === 'catalog') {
    await mkdir(join(f.root, 'scratch')); await writeFile(join(f.root, 'scratch', 'note.txt'), 'New evidence');
    await f.catalog.registerEvidence({ relativePath: 'note.txt', sourceRefs: ['ev-01'], label: 'New evidence' });
  }
  await tool.onCompleted!(pending);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined, 'outdated completion does not satisfy formal inspection either');
  await f.inspect();
  assert.equal(f.draft.hasReviewDraftMaterial(), true, 'a new actual complete current or stale read restores only the current binding');
  if (change === 'catalog' || change === 'findings') assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined);
});

test('already completed material invalidates when findings, catalog or accepted draft changes', async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings); await f.draft.submit(submission); f.draft.beginReview();
  await f.inspect(); assert.equal(f.draft.hasReviewDraftMaterial(), true);
  await f.discovery!.update({ ...findings, importantLimitations: ['New scope'] });
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  assert.equal((await f.inspect()).status, 'stale'); assert.equal(f.draft.hasReviewDraftMaterial(), true);
  await mkdir(join(f.root, 'scratch')); await writeFile(join(f.root, 'scratch', 'note.txt'), 'New evidence');
  await f.catalog.registerEvidence({ relativePath: 'note.txt', sourceRefs: ['ev-01'], label: 'New evidence' });
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await f.inspect(); assert.equal(f.draft.hasReviewDraftMaterial(), true);
  await f.discovery!.update({ ...findings, importantLimitations: ['New scope'] }); await f.draft.submit(submission);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
});

test('unavailable, damaged and oversized inspection results never provide review material', async t => {
  const f = await fixture(t);
  f.draft.beginReview();
  assert.equal((await f.inspect()).status, 'unavailable'); assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await f.draft.submit(submission); await f.inspect(); assert.equal(f.draft.hasReviewDraftMaterial(), true);
  await writeFile(join(f.root, 'report.html'), '<p>Damaged unaccepted text</p>');
  assert.equal((await f.inspect()).status, 'unavailable'); assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await rm(join(f.root, 'report.html'));
  assert.equal((await f.inspect()).status, 'unavailable'); assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await f.draft.submit({ ...submission, comparisonHtml: `<p>Meaning.</p>${'<span></span>'.repeat(2000)}` });
  assert.equal((await f.inspect()).status, 'unavailable'); assert.equal(f.draft.hasReviewDraftMaterial(), false);
});

for (const stale of [false, true]) test(`audit failure and aborted delivery cannot satisfy ${stale ? 'stale' : 'current'} review material`, async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings); await f.draft.submit(submission); f.draft.beginReview();
  if (stale) await f.discovery!.update({ ...findings, importantLimitations: ['Changed scope'] });
  const failed = instrumentTools([f.draft.inspectTool()], 'review', 'comparison', { requestIndex: 0 }, {
    append: async event => { if (event.type === 'agent.tool_completed') throw new Error('Audit write failed'); },
  })[0]!;
  await assert.rejects(failed.execute({}, new AbortController().signal), /tool execution failed/);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  const controller = new AbortController(), raw = f.draft.inspectTool();
  const aborted = instrumentTools([{ ...raw, execute: async (params, signal) => { const result = await raw.execute(params, signal); controller.abort(); return result; } }], 'review', 'comparison', { requestIndex: 0 })[0]!;
  await assert.rejects(aborted.execute({}, controller.signal), /tool execution failed/);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  await f.inspect(); assert.equal(f.draft.hasReviewDraftMaterial(), true);
  if (stale) assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined);
});

test('same-body completion from an old review epoch cannot unlock a newly pending inspection', async t => {
  const f = await fixture(t);
  await f.draft.submit(submission); f.draft.beginReview();
  const tool = f.draft.inspectTool();
  const old = await tool.execute({}, new AbortController().signal);
  f.draft.beginReview();
  const current = await tool.execute({}, new AbortController().signal);
  assert.equal(old.content, current.content, 'the unchanged body alone cannot identify delivery');
  assert.notEqual(toolDeliveryToken(old), toolDeliveryToken(current));
  await tool.onCompleted!(old);
  assert.equal(f.draft.hasReviewDraftMaterial(), false);
  assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined);
  await tool.onCompleted!(current);
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
});

test('real progress, text-only filtering and redaction preserve only internal delivery identity without persisting a stale receipt', async t => {
  const f = await fixture(t, true);
  await f.discovery!.update(findings); await f.draft.submit(submission); f.draft.beginReview();
  await f.discovery!.update({ ...findings, importantLimitations: ['Changed scope'] });
  const raw = f.draft.inspectTool(), events: AgentAuditEvent[] = [];
  const resources = new ComparisonResourceTracker({}); resources.phase('review');
  let token: object | undefined;
  const tool = instrumentTools([{ ...raw, execute: async (params, signal) => {
    const result = await raw.execute(params, signal);
    token = toolDeliveryToken(result);
    assert.ok(token); assert.equal(f.draft.hasReviewDraftMaterial(), false);
    const augmented = { ...result, contentBlocks: [{ type: 'text' as const, text: result.content }, { type: 'image' as const, data: 'fixture', mimeType: 'image/png' }] };
    return comparisonToolFeedback(augmented, resources, undefined, raw.name);
  } }], 'review', 'comparison', { requestIndex: 0 }, { append: async event => { events.push(event); } })[0]!;
  const visible = await tool.execute({}, new AbortController().signal);
  assert.equal(toolDeliveryToken(visible), token);
  assert.deepEqual(visible.details, { imageDelivery: 'unsupported_model' });
  assert.equal(Value.Check(ComparisonDraftInspectionSchema, visible.details), false);
  assert.equal(visible.contentBlocks?.some(block => block.type === 'image'), false);
  assert.match(visible.content, /Image content omitted/);
  assert.match(visible.content, /hostProgress/);
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
  assert.equal((JSON.parse(f.draft.submissionState()) as { inspected?: unknown }).inspected, undefined);
  assert.equal(await f.draft.completedResult(), undefined);
  const completed = events.find(event => event.type === 'agent.tool_completed')!;
  assert.deepEqual(completed.payload.details, { imageDelivery: 'unsupported_model' }, 'the pre-existing image-omission diagnostic is not a stale inspection receipt');
  assert.equal(Value.Check(ComparisonDraftInspectionSchema, completed.payload.details), false);
  assert.equal(Object.getOwnPropertySymbols(completed.payload).length, 0);
  assert.doesNotMatch(JSON.stringify(events), /agent-tool-delivery/);
  assert.doesNotMatch(JSON.stringify(visible), /agent-tool-delivery/);
});

for (const missing of ['headline', 'comparisonHtml', 'detailsHtml', 'truncated', 'malformed', 'stub']) test(`a valid identity token cannot certify ${missing} material`, async t => {
  const f = await fixture(t);
  await f.draft.submit(submission); f.draft.beginReview();
  const raw = f.draft.inspectTool();
  const tool = instrumentTools([{ ...raw, execute: async (params, signal) => {
    const result = await raw.execute(params, signal);
    const body = JSON.parse(result.content) as Record<string, unknown>;
    if (missing === 'truncated') body.truncated = true;
    else delete body[missing];
    const content = missing === 'malformed' ? '{' : missing === 'stub' ? JSON.stringify({ status: 'available', reason: 'Inspection omitted' }) : JSON.stringify(body);
    const wrapped = { ...result, content };
    assert.equal(toolDeliveryToken(wrapped), toolDeliveryToken(result));
    return wrapped;
  } }], 'review', 'comparison', { requestIndex: 0 })[0]!;
  await tool.execute({}, new AbortController().signal);
  assert.equal(f.draft.hasReviewDraftMaterial(), false, 'real completion and identity do not substitute for complete actual text delivery');
});

test('complete standard-redacted slots with Host progress satisfy real material delivery', async t => {
  const f = await fixture(t);
  const secretMarker = 'synthetic_review_secret';
  await f.draft.submit({ ...submission, detailsHtml: `<p>Authorization: Bearer ${secretMarker}</p>` }); f.draft.beginReview();
  const raw = f.draft.inspectTool(), resources = new ComparisonResourceTracker({}); resources.phase('review');
  const tool = instrumentTools([{ ...raw, execute: async (params, signal) => comparisonToolFeedback(await raw.execute(params, signal), resources, undefined, raw.name) }], 'review', 'comparison', { requestIndex: 0 })[0]!;
  const visible = await tool.execute({}, new AbortController().signal);
  assert.equal(visible.content.includes(secretMarker), false);
  assert.match(visible.content, /hostProgress/);
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
});

for (const empty of [false, true]) test(`complete root content cannot substitute for ${empty ? 'empty' : 'stub'} actual contentBlocks`, async t => {
  const f = await fixture(t);
  await f.draft.submit(submission); f.draft.beginReview();
  const raw = f.draft.inspectTool();
  const tool = instrumentTools([{ ...raw, execute: async (params, signal) => {
    const result = await raw.execute(params, signal);
    return { ...result, contentBlocks: empty ? [] : [{ type: 'text' as const, text: 'Inspection omitted' }] };
  } }], 'review', 'comparison', { requestIndex: 0 })[0]!;
  const visible = await tool.execute({}, new AbortController().signal);
  assert.ok(visible.content.includes(submission.headline));
  assert.equal(f.draft.hasReviewDraftMaterial(), false, 'Provider uses contentBlocks when present, including an empty array');
});

test('full actual contentBlocks satisfy material even when root content is only a wrapper note', async t => {
  const f = await fixture(t);
  await f.draft.submit(submission); f.draft.beginReview();
  const raw = f.draft.inspectTool();
  const tool = instrumentTools([{ ...raw, execute: async (params, signal) => {
    const result = await raw.execute(params, signal);
    return { ...result, content: 'Actual inspection follows in contentBlocks', contentBlocks: [{ type: 'text' as const, text: result.content }] };
  } }], 'review', 'comparison', { requestIndex: 0 })[0]!;
  await tool.execute({}, new AbortController().signal);
  assert.equal(f.draft.hasReviewDraftMaterial(), true);
});
