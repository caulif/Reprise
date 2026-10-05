import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonDiscovery } from "../../src/application/comparison-discovery.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import type { ComparisonDiscoveryRecord, ComparisonFindingsSubmission } from "../../src/core/schema.js";

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
      { side: "baseline", method: "source_inspection", result: "Qualifier retained", scope: "Final paragraph", evidenceRefs: [baseline!], timing: "comparison_check" },
      { side: "candidate", method: "self_report", result: "Claims all content retained", scope: "Visible narrative only", evidenceRefs: [candidate!], timing: "original_run" },
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
