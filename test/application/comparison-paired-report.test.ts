import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ComparisonReportModelSchema } from '../../src/core/schema.js';
import { agentContentFromDraft, hostMetricsMismatch, missingComparisonSlots, renderComparisonReportFromModel, renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';
import { comparisonCompactTextBudgetError } from '../../src/application/comparison-report-text.js';
import { comparisonReportModelFromHtml } from '../../src/application/comparison-publication.js';
import { pairedMetricTexts } from '../../src/application/comparison-paired-report.js';
import type { ComparisonReportFacts } from '../../src/agents/comparison-contract.js';
import { linkPairedImages } from '../../src/application/comparison-paired-media.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { materializeComparisonReportPreview } from '../../src/application/comparison-report-preview.js';
import { publishComparisonArtifacts, verifyAndRenderComparisonReport } from '../../src/application/comparison-publication.js';
import { sha256 } from '../../src/core/identity.js';

const facts: ComparisonReportFacts = {
  run: { runId: 'run', outcome: 'completed', terminationCode: 'done', initiatedBy: 'controller' },
  models: { baseline: 'historical-model', candidate: 'current-model', comparison: 'analysis-model' },
  activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
  delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'unknown' },
  replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available', baselineIsSubstitute: true },
  metrics: { timingComparison: { status: 'reference', reasons: ['task_scope_not_proven_equal'] }, baseline: { tokens: { total: 70480 }, pricingStatus: 'pricing_unavailable' }, candidate: { tokens: { total: 2965000 }, costUsd: 0.182 } },
};
const slots = { category: '文档修订', headline: '推荐当前', reason: '当前保留了需要继续修订的编号。', boundary: '打开后的排版尚未逐页检查。', pairedDifferences: [{ dimension: '编号保留了吗？', baseline: '替代材料缺少编号', candidate: '当前保留编号', impact: '后续修订不必重新核对编号。' }], comparison: '' };
const render = (overrides = {}) => renderComparisonReportShell({ formatVersion: 6, task: 'Private original task', facts, metrics: facts.metrics!, slots: { ...slots, ...overrides } });

test('per-result assessments color supported differences independently and survive model restoration', () => {
  const pairedDifferences = [
    { ...slots.pairedDifferences[0]!, baselineAssessment: 'better' as const, candidateAssessment: 'worse' as const },
    { dimension: '连续动作测了吗？', baseline: '没有连续播放记录', candidate: '只有作者自报', impact: '采用前仍需实际播放。', baselineAssessment: 'unknown' as const, candidateAssessment: 'unverified' as const },
    { dimension: '共有条件确认了吗？', baseline: '已确认相同', candidate: '尚无评判', impact: '缺少评判不推断优劣。', baselineAssessment: 'similar' as const },
  ];
  const html = render({ pairedDifferences });
  assert.equal(comparisonCompactTextBudgetError(html), undefined);
  assert.match(html, /assessment-better" role="group" aria-label="更好"><strong data-result-field="baseline" data-result-assessment="better"/);
  assert.match(html, /assessment-worse" role="group" aria-label="更差"><strong data-result-field="candidate" data-result-assessment="worse"/);
  assert.match(html, /assessment-neutral" role="group" aria-label="未知"/);
  assert.match(html, /assessment-neutral" role="group" aria-label="未验证"/);
  assert.match(html, /assessment-neutral" role="group" aria-label="相近"/);
  assert.doesNotMatch(html, /assessment-label|>(?:更好|更差|未验证|未知|相近) · /);
  const extracted = agentContentFromDraft(html);
  assert.ok('slots' in extracted);
  assert.deepEqual(extracted.slots.pairedDifferences, pairedDifferences);
  const model = comparisonReportModelFromHtml(html, facts, { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, []);
  assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
  assert.equal(renderComparisonReportFromModel({ model, facts }), html);
  assert.equal(comparisonCompactTextBudgetError(render()), undefined, 'old missing assessments remain valid and unclassified');
  assert.doesNotMatch(render(), /class="assessment-label"/);
  const invalid = html.replace('data-result-assessment="better"', 'data-result-assessment="success"');
  assert.ok(comparisonCompactTextBudgetError(invalid), 'unsupported assessment must not silently become neutral');
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, pairedDifferences: [{ ...pairedDifferences[0], candidateAssessment: 'red' }] }), false);
});

test('paired report renders aligned differences, local limits and fixed k and roundtrips through the production model', () => {
  const html = render();
  assert.equal(missingComparisonSlots(html), undefined);
  assert.equal(hostMetricsMismatch(html, facts.metrics!), undefined);
  assert.equal(comparisonCompactTextBudgetError(html), undefined);
  assert.match(html, />70\.5k<\/td>/);
  assert.match(html, />2,965\.0k<\/td>/);
  assert.match(html, /未配置价格/);
  assert.match(html, /模型费用（估算，USD）/);
  assert.doesNotMatch(html, /<small|timing-note|任务范围未确认一致|已记录 .*轮次/);
  assert.match(html, /替代品，差异不能归因于历史模型/);
  assert.ok(html.indexOf('<h1 data-agent-slot="headline"') < html.indexOf('<p class="reason" data-agent-slot="reason"'));
  assert.ok(html.indexOf('data-agent-slot="reason"') < html.indexOf('<span data-agent-slot="boundary"'));
  assert.doesNotMatch(html, /Token（k）|1 k =|费用不含工具|Private original task|<details|line-clamp/);
  const extracted = agentContentFromDraft(html);
  assert.ok('slots' in extracted);
  assert.deepEqual(extracted.slots.pairedDifferences, slots.pairedDifferences);
  assert.equal(renderComparisonReportShell({ task: 'ignored', facts, metrics: facts.metrics!, ...extracted }), html);
  const model = comparisonReportModelFromHtml(html, facts, { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, []);
  assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
  assert.equal(renderComparisonReportFromModel({ model, facts }), html);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, reason: undefined }), false);
  const conflictingEnvelope = comparisonReportModelFromHtml(html, facts, { status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: '推荐当前，先修背景' }, []);
  assert.equal(conflictingEnvelope.headline, '推荐当前', 'format 6 keeps the validated accepted slot instead of a later envelope claim');
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, headline: '推荐当前，先修背景' }), false);
});

test('new paired gates have reverse examples for short recommendation, pair completeness, repeated evidence, privacy and budget', () => {
  for (const override of [
    { headline: '推荐当前，先修背景' }, { reason: '' },
    { pairedDifferences: Array(4).fill(slots.pairedDifferences[0]) },
    { pairedDifferences: [{ ...slots.pairedDifferences[0], impact: '' }] },
    { comparison: '<table><tbody><tr><td>重复证据表</td></tr></tbody></table>' },
    { comparison: '<p>重复的差异正文</p>' },
    { comparison: '<img src="review.png" alt="unlabelled">' },
    { comparison: '<details><summary>隐藏依据</summary></details>' },
    { reason: 'private.docx' }, { reason: '字'.repeat(901) },
  ]) assert.ok(comparisonCompactTextBudgetError(render(override)), JSON.stringify(override).slice(0, 100));
  assert.equal(comparisonCompactTextBudgetError(render({ pairedDifferences: [] })), undefined);
  assert.equal(comparisonCompactTextBudgetError(render({ headline: '暂不能推荐' })), undefined);
});

test('Host original-image links preserve the complete image and avoid nested links on rebuild', () => {
  const source = render({ comparison: '<figure><img src="review/full.png" alt="完整视口"><figcaption>历史 · 车轮位置；单帧不能证明连续动作。</figcaption></figure>' });
  const linked = linkPairedImages(source);
  assert.match(linked, /<a href="review\/full.png" aria-label="放大完整原图 \/ Open full original image"><img/);
  assert.equal(linkPairedImages(linked), linked);
  assert.equal(comparisonCompactTextBudgetError(linked), undefined);
  assert.match(linked, /height:auto;max-height:none;object-fit:contain/);
  assert.doesNotMatch(linked, /object-fit:cover/);
});

test('metrics preserve zero, tiny positive, missing and unknown pricing without M or misleading zero', () => {
  const values = pairedMetricTexts({ baseline: { tokens: { total: 0 }, costUsd: 0 }, candidate: { tokens: { total: 1 }, costUsd: 0.00001 } }, 'zh');
  assert.deepEqual(values.map(v => v.text), ['未知', '未知', '0.0k', '<0.1k', '0.000', '<0.001']);
  assert.equal(pairedMetricTexts({ candidate: { tokens: { total: 100 }, pricingStatus: 'unknown' } }, 'zh')[5]?.text, '未知');
  assert.equal(pairedMetricTexts({}, 'en')[0]?.text, 'Unknown');
});

for (const formatVersion of [6, 7] as const) test(`format ${formatVersion}: structured evidence and media survive draft, preview, publication and rebuild`, async t => {
  const reportSlots: Omit<typeof slots, 'boundary'> & { boundary?: string } = { ...slots };
  if (formatVersion === 7) delete reportSlots.boundary;
  const root = await mkdtemp(join(tmpdir(), 'reprise-paired-roundtrip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'review'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(root, 'review', 'full.png'), png);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt',
    links: [{ side: 'candidate', inspectPath: 'evidence/result.txt', shortRef: 'ev-01', evidenceRef: 'artifact:source', contentHash: sha256('source'), sourceRefs: ['artifact:source'] }],
    media: ['baseline', 'candidate'].map((side, index) => ({ ref: `media:frame-${index}`, shortRef: `media-0${index + 1}`, side: side as 'baseline' | 'candidate', inspectPath: 'review/full.png', reportHref: 'review/full.png', mediaType: 'image/png', available: true, contentHash: sha256(png) })) });
  const draft = new ComparisonDraft({ attemptRoot: root, task: 'Compare', facts, locale: 'zh', catalog, deliveredImages: new Set([sha256(png)]) });
  const pairedDifferences = [{ ...slots.pairedDifferences[0]!, baselineAssessment: 'worse' as const, candidateAssessment: 'better' as const, evidenceRefs: ['ev-01'] }];
  const comparisonHtml = `<div data-component="page-row">${['历史', '当前'].map((label, index) => `<figure><img data-media-ref="media-0${index + 1}" alt="完整视口"><figcaption>${label} · 完整视口；单帧不证明动作连续性。</figcaption></figure>`).join('')}</div>`;
  assert.match(await draft.submit({ formatVersion, status: 'completed', ...reportSlots, pairedDifferences, comparisonHtml }), /status=accepted/);
  const html = await readFile(join(root, 'report.html'), 'utf8');
  assert.match(html, /data-evidence-ref="ev-01"/);
  assert.match(html, /<a href="review\/full.png" aria-label="放大完整原图/);
  const snapshot = catalog.snapshot();
  const preview = await materializeComparisonReportPreview({ attemptRoot: root, media: snapshot.media, evidence: snapshot.links, catalogRevision: snapshot.revision });
  draft.recordPreview(preview);
  const result = await draft.completedResult();
  assert.ok(result);
  assert.deepEqual(result.evidenceRefs, ['ev-01']);
  const verified = await verifyAndRenderComparisonReport({ html, hostTask: 'Compare', facts, result, attemptRoot: root, media: snapshot.media, evidence: snapshot.links, locale: 'zh', deliveredImageContentHashes: new Set([sha256(png)]) });
  assert.ok('model' in verified, JSON.stringify(verified));
  assert.deepEqual(verified.model.pairedDifferences, pairedDifferences);
  assert.deepEqual(verified.model.evidenceRefs, ['artifact:source']);
  assert.deepEqual(verified.model.mediaRefs, ['media:frame-0', 'media:frame-1']);
  await publishComparisonArtifacts({ attemptRoot: root, experimentRoot: join(root, 'published'), html: verified.html, model: verified.model, media: snapshot.media, evidence: snapshot.links });
  const model: unknown = JSON.parse(await readFile(join(root, 'published', 'report-model.json'), 'utf8'));
  assert.ok(Value.Check(ComparisonReportModelSchema, model));
  assert.deepEqual(model.pairedDifferences, pairedDifferences);
  const rebuilt = renderComparisonReportFromModel({ model, facts });
  assert.match(rebuilt, /data-evidence-ref="ev-01"/);
  assert.match(rebuilt, /<a href="media\/[a-f0-9]+\.png"/);
  assert.equal(comparisonCompactTextBudgetError(rebuilt), undefined);
  await writeFile(join(root, 'report.html'), html.replace('data-result-assessment="better"', 'data-result-assessment="worse"'));
  assert.equal(await draft.completedResult(), undefined, 'changing only the assessment after preview cannot publish');
  await writeFile(join(root, 'report.html'), html);
  const previousDigest = draft.acceptedReceipt().draftDigest;
  assert.match(await draft.submit({ formatVersion, status: 'completed', ...reportSlots, pairedDifferences: [{ ...pairedDifferences[0]!, candidateAssessment: 'unverified' }], comparisonHtml }), /status=accepted/);
  assert.notEqual(draft.acceptedReceipt().draftDigest, previousDigest);
  assert.equal(await draft.completedResult(), undefined, 'assessment-only revisions require a new preview');
  assert.match(await draft.submit({ formatVersion, status: 'completed', ...reportSlots, pairedDifferences: [{ ...pairedDifferences[0]!, evidenceRefs: ['ev-99'] }], comparisonHtml }), /evidence_unresolved/);
});


test('decision-only report omits fixed caveats in both languages without discarding internal facts or legacy content', () => {
  for (const locale of ['zh', 'en'] as const) {
    const html = renderComparisonReportShell({ formatVersion: 7, task: 'Private original task', facts, metrics: facts.metrics!, slots, locale });
    assert.equal(missingComparisonSlots(html), undefined);
    assert.equal(hostMetricsMismatch(html, facts.metrics!), undefined);
    assert.equal(comparisonCompactTextBudgetError(html), undefined);
    assert.doesNotMatch(html, /<[^>]*data-agent-slot="boundary"|data-host="substitute-baseline"|采用前注意|Before adopting|User-selected substitute|历史材料为用户指定替代品/);
    assert.ok(html.includes(slots.reason));
    assert.ok(html.includes(slots.pairedDifferences[0]!.impact));
    const extracted = agentContentFromDraft(html);
    assert.ok('slots' in extracted);
    assert.equal(Object.hasOwn(extracted.slots, 'boundary'), false);
    const model = comparisonReportModelFromHtml(html, facts, { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, [], [], locale);
    assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
    assert.equal(Object.hasOwn(model, 'boundary'), false);
    assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, boundary: '' }), false);
    assert.equal(renderComparisonReportFromModel({ model, facts, locale }), html);
    const legacy = renderComparisonReportShell({ formatVersion: 6, task: 'ignored', facts, metrics: facts.metrics!, slots, locale });
    const legacyModel = comparisonReportModelFromHtml(legacy, facts, { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, [], [], locale);
    assert.equal(legacyModel.boundary, slots.boundary);
    assert.match(legacy, /data-host="substitute-baseline"/);
    assert.equal(renderComparisonReportFromModel({ model: legacyModel, facts, locale }), legacy);
    assert.equal(Value.Check(ComparisonReportModelSchema, { ...legacyModel, boundary: undefined }), false);
    const extraSlot = html.replace('</h1>', '</h1><p data-agent-slot="boundary">legacy caveat</p>');
    assert.ok(missingComparisonSlots(extraSlot));
    assert.ok('error' in agentContentFromDraft(extraSlot));
    assert.ok(comparisonCompactTextBudgetError(html.replace(slots.reason, '')));
    assert.ok(comparisonCompactTextBudgetError(html.replace(slots.reason, 'private.docx')));
    assert.ok(comparisonCompactTextBudgetError(html.replace(slots.reason, '字'.repeat(901))));
  }
  assert.equal(facts.replay.baselineIsSubstitute, true);
});

test('format 7 draft rejects legacy fields and incomplete pairs before accepting decision content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-decision-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: 'Delivery', facts, catalog, locale: 'zh', deliveredImages: new Set() });
  const submission = { formatVersion: 7 as const, status: 'completed' as const, category: slots.category, headline: slots.headline, reason: slots.reason, pairedDifferences: slots.pairedDifferences, comparisonHtml: '' };
  for (const invalid of [
    { ...submission, boundary: '' }, { ...submission, detailsHtml: '' }, { ...submission, differences: [] },
    { ...submission, reason: '' },
  ]) assert.match(await draft.submit(invalid), /code=draft_invalid/);
  assert.match(await draft.submit(submission), /status=accepted/);
  const html = await readFile(join(root, 'report.html'), 'utf8');
  assert.doesNotMatch(html, /<[^>]*data-agent-slot="boundary"|data-host="substitute-baseline"/);
});
