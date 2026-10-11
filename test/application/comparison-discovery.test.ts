import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import type { ComparisonDiscoveryRecord, ComparisonFindingsSubmission } from "../../src/core/schema.js";
import { ComparisonFindingsSubmissionSchema, ComparisonFindingsToolSubmissionSchema, ComparisonDiscoveryRecordSchema } from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, persist?: (record: ComparisonDiscoveryRecord) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "reprise-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [
    { side: "baseline", inspectPath: "baseline.txt", evidenceRef: "artifact:baseline" },
    { side: "candidate", inspectPath: "candidate.txt", evidenceRef: "artifact:candidate" },
  ], media: [] });
  const saved: ComparisonDiscoveryRecord[] = [];
  const discovery = new ComparisonDiscovery({ catalog, attemptId: "attempt-1", persist: persist ?? (async (record) => { saved.push(record); }) });
  const [baseline, candidate] = catalog.snapshot().links.map((item) => item.shortRef!);
  const submission: ComparisonFindingsSubmission = {
    criteria: ["Preserve meaning"],
    finals: [
      { side: "baseline", status: "located", sourceRefs: [baseline!], description: "Frozen original" },
      { side: "candidate", status: "located", sourceRefs: [candidate!], description: "Frozen candidate" },
    ],
    findings: [{ id: "meaning", criterion: "Preserve meaning", difference: "Candidate omits a qualifier", userConsequence: "Meaning changes", observations: [
      { side: "baseline", method: "source_inspection", result: "Qualifier retained", scope: "Final paragraph", supportBoundary: { relationship: "Qualifier applicability", domain: "Final paragraph", supportStage: "delivered_output", coveredInstances: ["Final qualifier"], uncheckedInstances: [] }, evidenceRefs: [baseline!], timing: "comparison_check" },
      { side: "candidate", method: "self_report", result: "Claims all content retained", scope: "Visible narrative only", supportBoundary: { relationship: "Qualifier applicability", domain: "Final paragraph", supportStage: "intermediate_only", coveredInstances: ["Visible final claim"], uncheckedInstances: ["Actual final qualifier"] }, evidenceRefs: [candidate!], timing: "original_run" },
    ], limitations: ["Narrative is not independent verification"], counterEvidenceRefs: [candidate!] }],
    decisionQuestions: [{ id: "qualifier", question: "Does qualifier change meaning?", decisionImpact: "Could change preference", status: "pending", nextCheck: "Compare the sentence", evidenceRefs: [] }],
    importantLimitations: ["Different tools; task-specific comparison"],
  };
  return { discovery, submission, saved, catalog, root };
}

test("findings preserve scoped evidence and question transitions, with immutable revisions", async (t) => {
  const { discovery, submission, saved } = await fixture(t);
  assert.equal(discovery.snapshot(), undefined);
  assert.equal(discovery.readyToCompose(), false);
  const signal = new AbortController().signal;
  const invalid = (await discovery.tool().execute({ bad: 'private-raw-value' }, signal)).content;
  assert.match(invalid, /invalid_findings/);
  assert.match(invalid, /errors=.*path.*message/);
  assert.doesNotMatch(invalid, /private-raw-value/);
  const receipt = (await discovery.tool().execute(submission, signal)).content;
  assert.match(receipt, /status=accepted/);
  assert.match(receipt, /pendingQuestions.*qualifier/);
  assert.doesNotMatch(receipt, /Qualifier retained|findings.*observations/);
  assert.equal(discovery.readyToCompose(), false);
  assert.equal(saved.length, 1);
  assert.match(await discovery.update({ ...submission, decisionQuestions: [] }), /question_history_missing/);
  const changedQuestion = structuredClone(submission);
  changedQuestion.decisionQuestions[0]!.question = 'Different question under the old ID';
  assert.match(await discovery.update(changedQuestion), /question_identity_changed/);
  assert.equal(await discovery.update(submission), receipt);
  assert.equal(saved.length, 1);
  const resolved = structuredClone(submission);
  resolved.decisionQuestions[0]!.status = "resolved";
  resolved.decisionQuestions[0]!.resolution = "Qualifier affects applicability";
  await discovery.update(resolved);
  assert.equal(discovery.readyToCompose(), true);
  assert.match(await discovery.update({ ...resolved, decisionQuestions: [] }), /question_history_missing/);
  const snapshot = discovery.snapshot()!;
  snapshot.submission.criteria[0] = "Mutated";
  saved[1]!.submission.criteria[0] = "Mutated callback";
  assert.equal(discovery.snapshot()!.submission.criteria[0], "Preserve meaning");
  assert.match(await discovery.update(submission), /reopen_reason_missing/);
  submission.decisionQuestions[0]!.reopenReason = "New counterexample";
  assert.match(await discovery.update(submission), /accepted/);
  assert.equal(discovery.snapshot()!.revision, 3);
  submission.decisionQuestions[0]!.status = "unavailable";
  submission.decisionQuestions[0]!.resolution = "Original source inaccessible";
  assert.match(await discovery.update(submission), /accepted/);
  assert.equal(discovery.readyToCompose(), true);
});

test('Host deadline closure preserves every saved observation and question identity without semantic answers', async t => {
  const { discovery, submission, saved } = await fixture(t);
  submission.decisionQuestions.push({ id: 'settled', question: 'Was the source located?', decisionImpact: 'Restricts scope', status: 'resolved', evidenceRefs: [], resolution: 'Previously checked, provisional finding' });
  await discovery.tool().execute(submission, new AbortController().signal);
  const before = discovery.snapshot()!;
  const closure = await discovery.closeAtInvestigationDeadline(new AbortController().signal);
  const after = discovery.snapshot()!;
  assert.equal(after.revision, 2); assert.equal(saved.length, 2); assert.equal(discovery.readyToCompose(), true);
  assert.deepEqual(closure.questionIds, ['qualifier']); assert.equal(closure.previous.digest, before.digest); assert.equal(closure.current.digest, after.digest);
  assert.deepEqual(after.submission.findings, before.submission.findings); assert.deepEqual(after.submission.finals, before.submission.finals);
  assert.deepEqual(after.submission.criteria, before.submission.criteria); assert.deepEqual(after.submission.importantLimitations, before.submission.importantLimitations);
  assert.deepEqual(after.submission.decisionQuestions[1], before.submission.decisionQuestions[1]);
  const { status, resolution, ...identity } = after.submission.decisionQuestions[0]!;
  const { status: previousStatus, resolution: previousResolution, ...previousIdentity } = before.submission.decisionQuestions[0]!;
  assert.equal(status, 'unavailable'); assert.equal(previousStatus, 'pending'); assert.equal(previousResolution, undefined);
  assert.deepEqual(identity, previousIdentity); assert.match(resolution!, /actual investigation deadline[\s\S]*not a semantic answer/);
  await discovery.closeAtInvestigationDeadline(new AbortController().signal); assert.equal(saved.length, 2, 'same current snapshot is idempotent');
});

for (const mode of ['missing', 'invalid_refs', 'persist', 'cancel'] as const) test(`Host deadline closure preserves the accepted record on ${mode} failure`, async t => {
  let failPersistence = false;
  const { discovery, submission, catalog } = await fixture(t, async () => { if (failPersistence) throw new Error('Actual persistence failure'); });
  if (mode !== 'missing') await discovery.update(submission);
  const before = discovery.snapshot();
  if (mode === 'invalid_refs') { const original = catalog.snapshot.bind(catalog); catalog.snapshot = () => ({ ...original(), links: [] }); }
  failPersistence = mode === 'persist';
  const controller = new AbortController(); if (mode === 'cancel') controller.abort();
  await assert.rejects(discovery.closeAtInvestigationDeadline(controller.signal));
  assert.deepEqual(discovery.snapshot(), before); assert.equal(discovery.readyToCompose(), false);
});

for (const repeatedSide of ['baseline', 'candidate'] as const) test(`same-side observations supply bounded shape repair without changing accepted history: ${repeatedSide}`, async t => {
  const { discovery, submission, saved } = await fixture(t);
  const signal = new AbortController().signal;
  await discovery.tool().execute(submission, signal);
  const accepted = discovery.snapshot();
  const invalid = structuredClone(submission);
  invalid.findings[0]!.observations = [
    structuredClone(submission.findings[0]!.observations.find(item => item.side === repeatedSide)!),
    structuredClone(submission.findings[0]!.observations.find(item => item.side === repeatedSide)!),
  ];
  assert.equal(Value.Check(ComparisonFindingsSubmissionSchema, invalid), true, 'schema-valid length alone does not ensure both sides');
  const rejection = (await discovery.tool().execute(invalid, signal)).content;
  assert.match(rejection, /status=rejected\ncode=observation_sides/);
  const repair = JSON.parse(rejection.split('\nrepair=')[1]!) as {
    findingId: string; actualSideCounts: { baseline: number; candidate: number }; requiredSides: string[]; expectedCount: number; repairRequirement: string;
  };
  assert.equal(repair.findingId, 'meaning');
  assert.deepEqual(repair.actualSideCounts, repeatedSide === 'baseline' ? { baseline: 2, candidate: 0 } : { baseline: 0, candidate: 2 });
  assert.deepEqual(repair.requiredSides, ['baseline', 'candidate']);
  assert.equal(repair.expectedCount, 2);
  assert.match(repair.repairRequirement, /complete snapshot.*preserving all question history/);
  assert.match(repair.repairRequirement, /method=unavailable.*do not invent evidence/);
  assert.doesNotMatch(rejection, /Qualifier retained|Claims all content retained/, 'shape feedback supplies no known observations or answers');
  assert.equal(saved.length, 1);
  assert.deepEqual(discovery.snapshot(), accepted);
  assert.equal(discovery.readyToCompose(), false);
  const corrected = structuredClone(submission);
  corrected.findings[0]!.observations[0]!.scope = 'Final paragraph and same-side qualifier check combined';
  assert.match((await discovery.tool().execute(corrected, signal)).content, /status=accepted/);
  assert.equal(saved.length, 2);
  assert.deepEqual(discovery.snapshot()!.submission.decisionQuestions, accepted!.submission.decisionQuestions);
  const unavailable = structuredClone(corrected);
  const missingSide = unavailable.findings[0]!.observations.find(item => item.side !== repeatedSide)!;
  missingSide.method = 'unavailable';
  missingSide.supportBoundary = { relationship: "Qualifier applicability", domain: "Final paragraph", supportStage: "unavailable", coveredInstances: [], uncheckedInstances: ["Actual final qualifier"] };
  missingSide.result = 'Unable to verify this side from retained evidence';
  missingSide.scope = 'No independent observation available';
  missingSide.evidenceRefs = [];
  assert.equal(Value.Check(ComparisonFindingsSubmissionSchema, unavailable), true);
  assert.match((await discovery.tool().execute(unavailable, signal)).content, /status=accepted/);
  assert.equal(saved.length, 3);
  assert.equal(discovery.snapshot()!.submission.findings[0]!.observations.length, 2);
});

test('new catalog evidence invalidates findings until they are resubmitted against that revision', async (t) => {
  const { discovery, submission, catalog, root } = await fixture(t);
  const settled = { ...submission, decisionQuestions: [] };
  await discovery.update(settled);
  assert.equal(discovery.readyToCompose(), true);
  const rejected = await catalog.registerMedia({ record: { ref: 'media:later', side: 'host', inspectPath: 'later.png', reportHref: 'later.png', mediaType: 'image/png', available: false }, origin: 'host_review' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(discovery.readyToCompose(), true);
  await mkdir(join(root, 'scratch'));
  await writeFile(join(root, 'scratch', 'analysis.txt'), 'Independent check of the original qualifier');
  const registered = await catalog.registerEvidence({ relativePath: 'scratch/analysis.txt', sourceRefs: [catalog.snapshot().links[0]!.shortRef!], label: 'Independent check' });
  assert.equal(registered.status, 'registered');
  assert.equal(discovery.readyToCompose(), false);
  await discovery.update(settled);
  assert.equal(discovery.readyToCompose(), true);
  assert.equal(discovery.snapshot()!.revision, 2);
});

test('history rejection supplies bounded complete repair material after catalog changes without accepting or resolving it', async t => {
  const { discovery, submission, saved, catalog, root } = await fixture(t);
  submission.decisionQuestions[0]!.status = 'resolved';
  submission.decisionQuestions[0]!.resolution = 'Prior model-authored interpretation, still subject to review';
  submission.decisionQuestions.push({ id: 'scope', question: 'Is the difference task-relevant?', decisionImpact: 'Could limit the recommendation', status: 'unavailable', resolution: 'Original independent check absent', evidenceRefs: [] });
  await discovery.update(submission);
  const accepted = discovery.snapshot();
  await mkdir(join(root, 'scratch'));
  await writeFile(join(root, 'scratch', 'fresh.txt'), 'New source review');
  await catalog.registerEvidence({ relativePath: 'scratch/fresh.txt', sourceRefs: [catalog.snapshot().links[0]!.shortRef!], label: 'Fresh source' });
  assert.equal(discovery.readyToCompose(), false);
  const replacement = structuredClone(submission);
  replacement.decisionQuestions = [replacement.decisionQuestions[1]!];
  const rejection = await discovery.update(replacement);
  assert.match(rejection, /status=rejected\ncode=question_history_missing/);
  const repair = JSON.parse(rejection.split('\nrepair=')[1]!) as { requiredQuestionIds: string[]; missingQuestionIds: string[]; existingQuestions: ComparisonFindingsSubmission['decisionQuestions']; semanticAssessment: string; repairRequirement: string };
  assert.deepEqual(repair.requiredQuestionIds, ['qualifier', 'scope']);
  assert.deepEqual(repair.missingQuestionIds, ['qualifier']);
  assert.deepEqual(repair.existingQuestions, submission.decisionQuestions);
  assert.equal(repair.semanticAssessment, 'not_certified');
  assert.match(repair.repairRequirement, /do not automatically resolve/);
  assert.equal(saved.length, 1);
  assert.deepEqual(discovery.snapshot(), accepted);
  assert.equal(discovery.readyToCompose(), false);
  replacement.decisionQuestions = repair.existingQuestions;
  assert.match(await discovery.update(replacement), /status=accepted/);
  assert.equal(discovery.readyToCompose(), true);
  assert.equal(saved.length, 2);
  const reopened = structuredClone(replacement);
  reopened.decisionQuestions[0]!.status = 'pending';
  reopened.decisionQuestions[0]!.nextCheck = 'Check the new source';
  const reopenRejection = await discovery.update(reopened);
  assert.match(reopenRejection, /code=reopen_reason_missing[\s\S]*"questionId":"qualifier"[\s\S]*"previousStatus":"resolved"/);
  assert.equal(saved.length, 2);
  assert.equal(discovery.snapshot()!.submission.decisionQuestions[0]!.status, 'resolved');
  reopened.decisionQuestions[0]!.reopenReason = 'Fresh evidence contradicts the earlier interpretation';
  assert.match(await discovery.update(reopened), /status=accepted/);
  assert.equal(discovery.readyToCompose(), false);
});

test('identity and decision-state rejections identify the question and requirements without mutating saved history', async t => {
  const { discovery, submission, saved } = await fixture(t);
  await discovery.update(submission);
  const before = discovery.snapshot();
  const changed = structuredClone(submission);
  changed.decisionQuestions[0]!.question = 'Replacement question';
  changed.decisionQuestions[0]!.decisionImpact = 'Replacement impact';
  const identity = await discovery.update(changed);
  assert.match(identity, /code=question_identity_changed/);
  assert.match(identity, /"questionId":"qualifier"/);
  assert.match(identity, /"previousIdentity":\{"id":"qualifier","question":"Does qualifier change meaning\?","decisionImpact":"Could change preference"\}/);
  assert.match(identity, /"semanticAssessment":"not_certified"/);
  const pending = structuredClone(submission);
  delete pending.decisionQuestions[0]!.nextCheck;
  assert.match(await discovery.update(pending), /code=next_check_missing[\s\S]*"questionId":"qualifier"[\s\S]*nonempty nextCheck/);
  const resolved = structuredClone(submission);
  resolved.decisionQuestions[0]!.status = 'resolved';
  assert.match(await discovery.update(resolved), /code=resolution_missing[\s\S]*"questionId":"qualifier"[\s\S]*nonempty evidence-grounded resolution/);
  assert.equal(saved.length, 1);
  assert.deepEqual(discovery.snapshot(), before);
});

test("findings reject invalid ownership and incomplete decision states", async (t) => {
  const { discovery, submission } = await fixture(t);
  async function reject(code: string, mutate: (data: ComparisonFindingsSubmission) => void) {
    const data = structuredClone(submission);
    mutate(data);
    assert.match(await discovery.update(data), new RegExp(code));
  }
  await reject("duplicate_id", (data) => data.findings.push(data.findings[0]!));
  await reject("duplicate_id", (data) => data.decisionQuestions.push(data.decisionQuestions[0]!));
  await reject("final_sides", (data) => { data.finals[1]!.side = "baseline"; });
  await reject("final_source_mismatch", (data) => { data.finals[0]!.sourceRefs = data.finals[1]!.sourceRefs; });
  await reject("final_source_missing", (data) => { data.finals[0]!.sourceRefs = []; });
  await reject("criterion_unresolved", (data) => { data.findings[0]!.criterion = "Unspecified"; });
  const unresolved = structuredClone(submission);
  unresolved.findings[0]!.criterion = 'paraphrased';
  assert.match(await discovery.update(unresolved), /findingId=meaning[\s\S]*allowedCriteria=.*Preserve meaning/);
  await reject("observation_sides", (data) => { data.findings[0]!.observations[1]!.side = "baseline"; });
  await reject("evidence_unresolved", (data) => { data.findings[0]!.counterEvidenceRefs = ["ev-99"]; });
  await reject("evidence_unresolved", (data) => { data.findings[0]!.observations[0]!.evidenceRefs = ["ev-99"]; });
  await reject("observation_evidence_missing", (data) => { data.findings[0]!.observations[0]!.evidenceRefs = []; });
  await reject("observation_source_mismatch", (data) => { data.findings[0]!.observations[0]!.evidenceRefs = data.finals[1]!.sourceRefs; });
  await reject("evidence_unresolved", (data) => { data.decisionQuestions[0]!.evidenceRefs = ["ev-99"]; });
  await reject("next_check_missing", (data) => { delete data.decisionQuestions[0]!.nextCheck; });
  await reject("resolution_missing", (data) => { data.decisionQuestions[0]!.status = "unavailable"; });
  const unavailable = structuredClone(submission);
  unavailable.finals[0]!.status = "unavailable";
  unavailable.finals[0]!.sourceRefs = [];
  unavailable.findings[0]!.observations[0]!.method = "unavailable";
  unavailable.findings[0]!.observations[0]!.supportBoundary = { relationship: "Qualifier applicability", domain: "Final paragraph", supportStage: "unavailable", coveredInstances: [], uncheckedInstances: ["Actual final qualifier"] };
  unavailable.findings[0]!.observations[0]!.evidenceRefs = [];
  assert.match(await discovery.update(unavailable), /accepted/);
});

test("persistence failure never accepts findings, cancelled tools never save", async (t) => {
  let failed = true;
  const { discovery, submission } = await fixture(t, async () => { if (failed) throw new Error("Store failed"); });
  await assert.rejects(discovery.tool().execute(submission, new AbortController().signal), /Store failed/);
  assert.equal(discovery.snapshot(), undefined);
  failed = false;
  assert.match((await discovery.tool().execute(submission, new AbortController().signal)).content, /accepted/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(discovery.tool().execute(submission, abort.signal), { name: "AbortError" });
});


test("live findings require explicit support boundaries while legacy direct and persisted records remain valid", async t => {
  const { discovery, submission } = await fixture(t);
  const legacy = structuredClone(submission);
  for (const observation of legacy.findings[0]!.observations) delete observation.supportBoundary;
  assert.equal(Value.Check(ComparisonFindingsSubmissionSchema, legacy), true);
  assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, legacy), false);
  const rejected = await discovery.tool().execute(legacy, new AbortController().signal);
  assert.match(rejected.content, /invalid_findings/);
  assert.equal(discovery.snapshot(), undefined);
  assert.match(await discovery.update(legacy), /accepted/);
  assert.equal(Value.Check(ComparisonDiscoveryRecordSchema, discovery.snapshot()), true);
  assert.match((await discovery.tool().execute(submission, new AbortController().signal)).content, /accepted/);
  const empty = { ...submission, findings: [] };
  assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, empty), true);
});

test("support stages reject missing output coverage, unavailable coverage and fabricated output observation", async t => {
  const { discovery, submission } = await fixture(t);
  const signal = new AbortController().signal;
  const missingCoverage = structuredClone(submission);
  missingCoverage.findings[0]!.observations[0]!.supportBoundary!.coveredInstances = [];
  assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, missingCoverage), false);
  assert.match((await discovery.tool().execute(missingCoverage, signal)).content, /invalid_findings/);
  const unavailableCoverage = structuredClone(submission);
  unavailableCoverage.findings[0]!.observations[0]!.supportBoundary!.supportStage = "unavailable";
  assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, unavailableCoverage), false);
  for (const method of ["self_report", "unavailable"] as const) {
    const unsupported = structuredClone(submission);
    unsupported.findings[0]!.observations[0]!.method = method;
    assert.match((await discovery.tool().execute(unsupported, signal)).content, /support_method_mismatch/);
  }
  const unchecked = structuredClone(submission);
  unchecked.findings[0]!.observations[0]!.supportBoundary!.supportStage = "intermediate_only";
  unchecked.findings[0]!.observations[0]!.supportBoundary!.coveredInstances = [];
  unchecked.findings[0]!.observations[0]!.supportBoundary!.uncheckedInstances = ["Downstream delivered return value"];
  assert.match((await discovery.tool().execute(unchecked, signal)).content, /accepted/);
  const scopedSample = structuredClone(submission);
  scopedSample.findings[0]!.observations[0]!.method = "sample";
  scopedSample.findings[0]!.observations[0]!.supportBoundary!.uncheckedInstances = ["Unsampled output instance"];
  assert.match((await discovery.tool().execute(scopedSample, signal)).content, /accepted/);
});

test("support boundary strings and instance lists are bounded plain declarations", async t => {
  const { submission } = await fixture(t);
  for (const change of [
    (boundary: NonNullable<typeof submission.findings[number]["observations"][number]["supportBoundary"]>) => { boundary.relationship = " "; },
    (boundary: NonNullable<typeof submission.findings[number]["observations"][number]["supportBoundary"]>) => { boundary.domain = "output\nsecond line"; },
    (boundary: NonNullable<typeof submission.findings[number]["observations"][number]["supportBoundary"]>) => { boundary.uncheckedInstances = Array.from({ length: 13 }, (_, i) => `instance ${i}`); },
  ]) {
    const invalid = structuredClone(submission);
    change(invalid.findings[0]!.observations[0]!.supportBoundary!);
    assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, invalid), false);
  }
});

type ReferenceRepair = {
  location: string; side?: string; findingId?: string; questionId?: string; submittedRefs: string[];
  submittedRefMetadata: { side?: string; status: string }[];
  catalogEntries: { ref: string }[]; omittedCatalogEntries: number;
  semanticAssessment: string; repairRequirement: string; completeCatalogPath?: string;
};

test("reference rejection identifies wrong side, unknown and missing refs without changing accepted findings", async t => {
  const { discovery, submission, saved } = await fixture(t);
  assert.match(await discovery.update(submission), /accepted/);
  const accepted = discovery.snapshot();
  const baseline = submission.finals[0]!.sourceRefs[0]!;
  const candidate = submission.finals[1]!.sourceRefs[0]!;
  const cases = [
    { code: "final_source_mismatch", location: "finals[0].sourceRefs", side: "baseline", refs: [candidate],
      change: (data: ComparisonFindingsSubmission) => { data.finals[0]!.sourceRefs = [candidate]; } },
    { code: "final_source_missing", location: "finals[0].sourceRefs", side: "baseline", refs: [],
      change: (data: ComparisonFindingsSubmission) => { data.finals[0]!.sourceRefs = []; } },
    { code: "observation_source_mismatch", location: "findings[0].observations[0].evidenceRefs", side: "baseline", refs: [candidate], findingId: "meaning",
      change: (data: ComparisonFindingsSubmission) => { data.findings[0]!.observations[0]!.evidenceRefs = [candidate]; } },
    { code: "evidence_unresolved", location: "findings[0].observations[0].evidenceRefs", side: "baseline", refs: ["ev-99"], findingId: "meaning",
      change: (data: ComparisonFindingsSubmission) => { data.findings[0]!.observations[0]!.evidenceRefs = ["ev-99"]; } },
    { code: "evidence_unresolved", location: "findings[0].counterEvidenceRefs", refs: ["ev-99"], findingId: "meaning",
      change: (data: ComparisonFindingsSubmission) => { data.findings[0]!.counterEvidenceRefs = ["ev-99"]; } },
    { code: "evidence_unresolved", location: "decisionQuestions[0].evidenceRefs", refs: ["ev-99"], questionId: "qualifier",
      change: (data: ComparisonFindingsSubmission) => { data.decisionQuestions[0]!.evidenceRefs = ["ev-99"]; } },
  ];
  for (const item of cases) {
    const invalid = structuredClone(submission);
    item.change(invalid);
    const result = (await discovery.tool().execute(invalid, new AbortController().signal)).content;
    assert.match(result, new RegExp(`code=${item.code}`));
    const repair = JSON.parse(result.split("\nrepair=")[1]!) as ReferenceRepair;
    assert.equal(repair.location, item.location);
    assert.equal(repair.side, item.side);
    assert.equal(repair.findingId, item.findingId);
    assert.equal(repair.questionId, item.questionId);
    assert.deepEqual(repair.submittedRefs, item.refs);
    if (item.refs.length) {
      const metadata = repair.submittedRefMetadata[0];
      assert.ok(metadata);
      if (item.refs[0] === candidate) assert.equal(metadata.side, "candidate");
      if (item.refs[0] === "ev-99") assert.equal(metadata.status, "not_found");
    }
    if (item.side) assert.deepEqual(repair.catalogEntries.map((entry: { ref: string }) => entry.ref), [baseline]);
    assert.equal(repair.semanticAssessment, "not_certified");
    assert.match(repair.repairRequirement, /not replacements or certified evidence/);
    assert.doesNotMatch(result, /baseline\.txt|candidate\.txt|artifact:baseline|Qualifier retained|Claims all content retained/);
    assert.deepEqual(discovery.snapshot(), accepted);
    assert.equal(saved.length, 1);
  }
});

test("reference repair directory is bounded and sends no private catalog paths or raw source identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "reprise-ref-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "repair", links: [
    ...Array.from({ length: 15 }, (_, i) => ({ side: "baseline" as const, inspectPath: `private-source-${i}.txt`, evidenceRef: `artifact:private-${i}`, label: `private-label-${i}` })),
    { side: "candidate", inspectPath: "candidate-private.txt", evidenceRef: "artifact:private-candidate" },
  ], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: "repair", persist: async () => { assert.fail("Rejected state must not persist"); } });
  const result = await discovery.update({ criteria: ["Task outcome"], finals: [
    { side: "baseline", status: "located", sourceRefs: [], description: "Unknown final" },
    { side: "candidate", status: "unavailable", sourceRefs: [], description: "Unknown final" },
  ], findings: [], decisionQuestions: [], importantLimitations: [] });
  const repair = JSON.parse(result.split("\nrepair=")[1]!) as ReferenceRepair;
  assert.equal(repair.catalogEntries.length, 12);
  assert.equal(repair.omittedCatalogEntries, 3);
  assert.equal(repair.completeCatalogPath, undefined);
  assert.match(repair.repairRequirement, /subject to phase resource limits and may be unavailable/);
  assert.match(repair.repairRequirement, /do not retry denied reads/);
  assert.doesNotMatch(result, /private-source|private-label|artifact:private|candidate-private/);
  assert.equal(discovery.snapshot(), undefined);
});
