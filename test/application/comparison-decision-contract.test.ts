import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionTextHtml, decisionSupportDetailsHtml, decisionContractError } from '../../src/application/comparison-decision-contract.js';
import type { ComparisonDraftSubmission, ComparisonFindingsSubmission, ComparisonSupportBoundary } from '../../src/core/schema.js';

type Finding = ComparisonFindingsSubmission['findings'][number];
const partial: ComparisonSupportBoundary = { relationship: 'Wheel remains inside rim', domain: 'Entire animation', supportStage: 'delivered_output', coveredInstances: ['Frame 0'], uncheckedInstances: ['Far wheel', 'Full cycle'] };
function finding(id: string, criterion: string, baseline?: ComparisonSupportBoundary, candidate?: ComparisonSupportBoundary): Finding {
  return { id, criterion, difference: 'Observed difference', userConsequence: 'Changes task use', limitations: [], counterEvidenceRefs: [],
    observations: (['baseline', 'candidate'] as const).map(side => ({ side, method: 'source_inspection', timing: 'comparison_check', result: 'Inspected', scope: 'Final output', evidenceRefs: [],
      ...(side === 'baseline' ? baseline && { supportBoundary: baseline } : candidate && { supportBoundary: candidate }) })) };
}
function findings(items: Finding[]): ComparisonFindingsSubmission {
  return { criteria: items.map(item => item.criterion), finals: [], findings: items, decisionQuestions: [], importantLimitations: [] };
}
const draft: ComparisonDraftSubmission = { status: 'completed', category: 'Result', headline: 'Scoped choice', comparisonHtml: '<p>Evidence.</p>',
  decisionSummary: 'Candidate preferred within the checked relation.', decisionBoundary: 'Far wheel remains unknown and may change this choice.', decisionBasis: ['wheel'], conclusionScope: 'conditional',
  findingDispositions: [{ findingId: 'wheel', disposition: 'basis', explanation: 'Task output' }] };

test('same finding merges both sides in ordinary main text while retaining decisive unknown and complete detailed scope', () => {
  const current = findings([finding('wheel', 'Wheel containment', partial, partial)]);
  const main = decisionTextHtml(draft, current);
  assert.match(main, /Wheel containment：历史运行、当前运行仅有局部交付支持。/);
  assert.equal((main.match(/Wheel containment/g) ?? []).length, 1);
  assert.ok(main.includes(draft.decisionBoundary!));
  assert.doesNotMatch(main, /Entire animation|Frame 0|Full cycle/);
  for (const locale of ['zh', 'en'] as const) {
    const details = decisionSupportDetailsHtml(draft, current, locale);
    for (const text of [partial.relationship, partial.domain, ...partial.coveredInstances, ...partial.uncheckedInstances]) {
      assert.equal(details.split(text).length - 1, 2, `${text} retained separately for both sides`);
    }
    assert.doesNotMatch(details, /delivered_output|relationship=|covered=|\[&quot;/);
  }
  assert.match(decisionTextHtml(draft, current, 'en'), /Wheel containment: Historical run and Current run: limited delivered-output coverage\./);
});

test('mixed stages and boundary findings remain side-specific; complete or nondecisive findings add no warning', () => {
  const intermediate: ComparisonSupportBoundary = { ...partial, supportStage: 'intermediate_only' };
  const unavailable: ComparisonSupportBoundary = { ...partial, supportStage: 'unavailable', coveredInstances: [] };
  const complete: ComparisonSupportBoundary = { ...partial, uncheckedInstances: [] };
  const current = findings([finding('wheel', 'Wheel containment', partial, intermediate), finding('other', 'Other relation', unavailable, undefined),
    finding('complete', 'Fully checked', complete, complete), finding('irrelevant', 'Nondecisive relation', partial, partial)]);
  const selected: ComparisonDraftSubmission = { ...draft, findingDispositions: [...draft.findingDispositions!,
    { findingId: 'other', disposition: 'boundary', explanation: 'Could change choice' }, { findingId: 'complete', disposition: 'basis', explanation: 'Checked' },
    { findingId: 'irrelevant', disposition: 'not_decisive', explanation: 'Outside this choice' }] };
  for (const locale of ['zh', 'en'] as const) {
    const main = decisionTextHtml(selected, current, locale), details = decisionSupportDetailsHtml(selected, current, locale);
    assert.doesNotMatch(main + details, /Fully checked|Nondecisive relation/);
    assert.match(main, locale === 'zh' ? /历史运行仅有局部交付支持；当前运行交付结果未确认/ : /Historical run: limited delivered-output coverage; Current run: delivered-output support unverified/);
    assert.match(main, locale === 'zh' ? /Other relation：历史运行、当前运行交付结果未确认/ : /Other relation: Historical run and Current run: delivered-output support unverified/);
    assert.doesNotMatch(details, /intermediate_only|unavailable/);
    assert.match(details, locale === 'zh' ? /未记录/ : /none recorded/);
    assert.match(details, locale === 'zh' ? /交付结果未确认/ : /delivered output has not been verified/);
  }
});

test('untrusted criterion and support directories are escaped without truncating any declared unknown', () => {
  const boundary: ComparisonSupportBoundary = { ...partial, relationship: '<details open>relation & "value"</details>', domain: '<script>scope</script>',
    coveredInstances: ["covered 'instance'"], uncheckedInstances: Array.from({ length: 12 }, (_, i) => `unknown-${i}-${'x'.repeat(60)}<img>`) };
  const current = findings([finding('wheel', '<script>criterion</script>', boundary, boundary)]);
  const main = decisionTextHtml(draft, current), details = decisionSupportDetailsHtml(draft, current);
  assert.match(main, /&lt;script&gt;criterion&lt;\/script&gt;/);
  assert.doesNotMatch(main + details, /<script>|<details|<img>/);
  assert.match(details, /&lt;details open&gt;relation &amp; &quot;/);
  assert.match(details, /&#39;instance&#39;/);
  for (let i = 0; i < 12; i++) assert.equal(details.split(`unknown-${i}-`).length - 1, 2);
  assert.ok(details.length > 1000, 'full scope is returned for the existing details budget to reject, not silently cut');
});

test('legacy typed draft and absent findings produce no invented support declarations', () => {
  const legacy: ComparisonDraftSubmission = { status: 'completed', category: 'Result', headline: 'Legacy', comparisonHtml: '<p>Legacy evidence.</p>' };
  const current = findings([finding('wheel', 'Wheel containment', partial, partial)]);
  assert.equal(decisionTextHtml(legacy, current), legacy.comparisonHtml);
  assert.equal(decisionSupportDetailsHtml(legacy, current), '');
  assert.equal(decisionSupportDetailsHtml(draft), '');
  const { findingDispositions: _dispositions, ...withoutDispositions } = draft;
  assert.equal(decisionSupportDetailsHtml(withoutDispositions, current), '');
  assert.equal(decisionTextHtml(withoutDispositions, current), decisionTextHtml(draft));
});

test('unavailable decision questions prevent unconditional scope and require a visible boundary even without saved limitations', () => {
  const complete: ComparisonSupportBoundary = { ...partial, uncheckedInstances: [] };
  const current = findings([finding('wheel', 'Wheel containment', complete, complete)]);
  current.decisionQuestions = [{ id: 'remaining-relation', question: 'Does the other requested relationship hold?', decisionImpact: 'An incorrect relationship would prevent use.',
    status: 'unavailable', evidenceRefs: [], nextCheck: 'Inspect the actual output.', resolution: 'No recorded resolution before the investigation deadline.' }];
  assert.deepEqual(current.importantLimitations, []);
  const before = structuredClone(current);
  for (const invalid of [{ ...draft, conclusionScope: 'supported_in_scope' as const }, { ...draft, decisionBoundary: '  ' }]) {
    const error = decisionContractError(invalid, current);
    assert.match(error!, /^code=decision_questions_unavailable\n/);
    assert.ok(error!.includes(current.decisionQuestions[0]!.decisionImpact));
    assert.ok(error!.includes('not certified facts'));
  }
  assert.equal(decisionContractError(draft, current), undefined);
  assert.ok(decisionTextHtml(draft, current).includes(draft.decisionBoundary!));
  assert.deepEqual(current, before, 'draft validation cannot resolve, delete or rewrite the question');
  current.decisionQuestions[0]!.status = 'resolved';
  assert.equal(decisionContractError({ ...draft, conclusionScope: 'supported_in_scope' }, current), undefined);
  const legacy: ComparisonDraftSubmission = { status: 'completed', category: 'Result', headline: 'Legacy', comparisonHtml: '<p>Legacy.</p>' };
  assert.equal(decisionContractError(legacy, before), undefined, 'legacy drafts retain their existing boundary');
});
