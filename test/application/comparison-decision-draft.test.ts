import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { ComparisonDecisionDraftSubmissionSchema, ComparisonDraftSubmissionSchema, ComparisonFindingsSubmissionSchema, type ComparisonDecisionDraftSubmission, type ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { materializeComparisonDecisionDraft } from '../../src/application/comparison-decision-draft.js';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { comparisonDetailsText, comparisonVisibleMainText } from '../../src/application/comparison-report-text.js';
import { sha256 } from '../../src/core/identity.js';

const base: ComparisonDecisionDraftSubmission = { kind: 'decision', status: 'insufficient_evidence', category: 'Results', headline: 'Unknown',
  decisionShape: 'single_difference', decisionSummary: 'Output quality remains unchecked.', decisionBoundary: 'Quality could change the choice.',
  conclusionScope: 'undetermined', findingDispositions: [], scopeSummaries: [] };
const facts = { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
  models: { candidate: 'candidate' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
  delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
  replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } };
async function fixture(t: { after(fn: () => Promise<void>): void }, withFinding = false, withSources = false) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-decision-draft-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  if (withSources) await Promise.all(['baseline', 'candidate'].map(side => writeFile(join(root, `${side}.txt`), `${side} source fixture`)));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt',
    links: withSources ? (['baseline', 'candidate'] as const).map(side => ({ side, inspectPath: `${side}.txt`, evidenceRef: `artifact:${side}` })) : [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  if (withFinding) assert.match(await discovery.update({ criteria: ['Quality'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Unchecked final' })),
    importantLimitations: ['Quality unknown'], decisionQuestions: [],
    findings: [{ id: 'quality', criterion: 'Quality', difference: 'Unchecked', userConsequence: 'Could change choice', limitations: [], counterEvidenceRefs: [],
      observations: (['baseline', 'candidate'] as const).map(side => ({ side, method: 'unavailable', timing: 'comparison_check',
        result: 'Unchecked', scope: 'Final', evidenceRefs: [], supportBoundary: { relationship: 'Quality', domain: 'Final',
          supportStage: 'unavailable', coveredInstances: [], uncheckedInstances: ['Quality'] } })) }] }), /status=accepted/);
  const draft = new ComparisonDraft({ attemptRoot: root, task: 'Compare outputs', facts, locale: 'en', catalog, deliveredImages: new Set(),
    ...(withFinding ? { discovery } : {}) });
  return { root, draft, discovery, catalog, tool: draft.tool(), signal: new AbortController().signal };
}

test('production decision shares the recorded criterion without rewriting original compact scope or bypassing details budget', async t => {
  const f = await fixture(t, false, true);
  const refs = f.catalog.snapshot().links.map(item => item.shortRef!);
  const criterion = '产出一个HTML文件，其内容使用SVG绘制鹈鹕骑自行车的2D动画，并可在浏览器中打开查看';
  const scopes = [
    [{ relationship: '基线 2D 动画实现方式', domain: 'CSS keyframes', coveredInstances: ['pelican_bike.html 全文'], uncheckedInstances: ['浏览器渲染'] },
      { relationship: '候选 2D 动画实现方式', domain: 'SMIL + JS', coveredInstances: ['pelican-bike.html 全文'], uncheckedInstances: ['浏览器渲染'] }],
    [{ relationship: '基线降级方式', domain: 'CSS 降级', coveredInstances: ['.wheel-spin/.pedal-spin 规则'], uncheckedInstances: ['浏览器渲染'] },
      { relationship: '候选降级方式', domain: 'SMIL + JS 降级', coveredInstances: ['matchMedia 分支'], uncheckedInstances: ['浏览器渲染'] }],
  ];
  const submission: ComparisonFindingsSubmission = { criteria: [criterion], finals: (['baseline', 'candidate'] as const).map((side, index) => ({ side,
    status: 'located' as const, sourceRefs: [refs[index]!], description: 'Source scope fixture' })), importantLimitations: ['未渲染'], decisionQuestions: [],
    findings: scopes.map((pair, index) => ({ id: `scope-${index}`, criterion, difference: '不同实现', userConsequence: '影响使用',
      limitations: [], counterEvidenceRefs: [], observations: (['baseline', 'candidate'] as const).map((side, sideIndex) => ({ side,
        method: 'source_inspection' as const, timing: 'comparison_check' as const, result: '源码范围', scope: '最终源码', evidenceRefs: [refs[sideIndex]!],
        supportBoundary: { ...pair[sideIndex]!, supportStage: 'delivered_output' as const } })) })) };
  assert.match(await f.discovery.update(submission), /status=accepted/);
  const before = structuredClone(f.discovery.state());
  const draft = new ComparisonDraft({ attemptRoot: f.root, task: '比较动画', facts, locale: 'zh', catalog: f.catalog,
    deliveredImages: new Set(), discovery: f.discovery });
  const decision: ComparisonDecisionDraftSubmission = { ...base, headline: '动画实现不同', decisionSummary: '按使用条件取舍。',
    decisionBoundary: '只检源码，浏览器渲染未知。', findingDispositions: submission.findings.map(item => ({ findingId: item.id,
      disposition: 'basis', explanation: '关系限定' })), scopeSummaries: [
      { findingId: 'scope-0', baseline: '静态源码已检；浏览器渲染未知。', candidate: '静态源码已检；浏览器渲染未知。' },
      { findingId: 'scope-1', baseline: 'CSS降级源码已检；浏览器渲染未知。', candidate: 'SMIL和JS降级源码已检；浏览器渲染未知。' },
    ] };
  const { scopeSummaries: _summaries, ...legacy } = materializeComparisonDecisionDraft(decision);
  assert.match((await draft.tool().execute(legacy, f.signal)).content, /status=accepted/);
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  const text = comparisonDetailsText(html, { excludeValidatedQuotes: true });
  assert.ok([...text.replace(/\s/g, '')].length <= 400);
  assert.equal(text.split(criterion).length - 1, 1);
  for (const pair of scopes) for (const scope of pair) for (const value of [scope.relationship, scope.domain,
    ...scope.coveredInstances, ...scope.uncheckedInstances]) assert.ok(text.includes(value), value);
  assert.deepEqual(f.discovery.state(), before, 'rendering must not alter evidence to fit its budget');
  const expanded = structuredClone(submission);
  const original = [
    [{ relationship: '基线交付物中 SVG 鹈鹕骑自行车 2D 动画的实现方式', domain: '单文件 HTML 内联 SVG 动画（CSS keyframes 路径）',
      coveredInstances: ['finals/pelican_bike.html 全文'], uncheckedInstances: ['浏览器实际渲染帧', '用户机器上历史原始文件字节一致性'] },
    { relationship: '候选交付物中 SVG 鹈鹕骑自行车 2D 动画的实现方式', domain: '单文件 HTML 内联 SVG 动画（SMIL + JS 驱动路径）',
      coveredInstances: ['candidate/pelican-bike.html 全文'], uncheckedInstances: ['浏览器实际渲染帧', 'JS 在真实浏览器中的运行时输出'] }],
    [{ relationship: '减少动态效果偏好与无 JS 条件下基线动画的降级方式', domain: '单文件 HTML 的动画降级路径（CSS 路径）',
      coveredInstances: ['finals/pelican_bike.html 的 @media 规则与 .wheel-spin/.pedal-spin 规则'], uncheckedInstances: ['浏览器实际渲染结果', '媒体查询在用户环境中的实际命中'] },
    { relationship: '减少动态效果偏好与无 JS 条件下候选动画的降级方式', domain: '单文件 HTML 的动画降级路径（SMIL + JS 路径）',
      coveredInstances: ['candidate/pelican-bike.html 的 matchMedia 分支与 rAF 驱动代码'], uncheckedInstances: ['浏览器实际渲染结果', '媒体查询在用户环境中的实际命中'] }],
  ];
  expanded.findings.forEach((item, index) => item.observations.forEach((observation, side) => {
    observation.supportBoundary = { ...original[index]![side]!, supportStage: 'delivered_output' };
  }));
  assert.match(await f.discovery.update(expanded), /status=accepted/);
  const expandedState = f.discovery.state();
  assert.match((await draft.tool().execute(legacy, f.signal)).content, /draft_details_too_long/);
  assert.equal(f.discovery.state(), expandedState, 'the length gate keeps the saved original scopes');
  const summarized = { ...decision, scopeSummaries: [
    { findingId: 'scope-0', baseline: '静态源码已检；未查渲染帧及历史原文件字节一致性。', candidate: '静态源码已检；未查渲染帧及真实浏览器JS输出。' },
    { findingId: 'scope-1', baseline: '@media/CSS规则已检；未查真实渲染及用户环境媒体查询命中。', candidate: 'matchMedia/rAF已检；未查真实渲染及用户环境媒体查询命中。' },
  ] };
  assert.match((await draft.tool().execute(summarized, f.signal)).content, /status=accepted/);
  const summarizedHtml = await readFile(join(f.root, 'report.html'), 'utf8');
  const summarizedDetails = comparisonDetailsText(summarizedHtml, { excludeValidatedQuotes: true });
  assert.ok([...summarizedDetails.replace(/\s/g, '')].length <= 400);
  for (const summary of summarized.scopeSummaries) for (const side of ['baseline', 'candidate'] as const) assert.ok(summarizedDetails.includes(summary[side]));
  assert.equal(f.discovery.state(), expandedState, 'a report summary cannot rewrite the original complete record');
  assert.notEqual(summarizedHtml, html, 'the new draft binding must reflect its scope summary');
  assert.match((await draft.tool().execute({ ...summarized, scopeSummaries: [] }, f.signal)).content, /decision_scope_summaries_invalid/);
  assert.match((await draft.tool().execute({ ...summarized, scopeSummaries: [...summarized.scopeSummaries, summarized.scopeSummaries[0]!] }, f.signal)).content, /decision_scope_summaries_invalid/);
  const recorded: unknown = JSON.parse(await readFile('test/fixtures/comparison-scope-summary-boundaries.json', 'utf8'));
  const recordedSchema = Type.Array(Type.Object({ criterion: Type.String({ minLength: 1 }),
    boundaries: Type.Array(ComparisonFindingsSubmissionSchema.properties.findings.items.properties.observations.items.properties.supportBoundary,
      { minItems: 2, maxItems: 2 }) }, { additionalProperties: false }), { minItems: 2, maxItems: 2 });
  if (!Value.Check(recordedSchema, recorded)) throw new Error('Recorded scope fixture failed core boundary schema validation');
  expanded.criteria = [recorded[0]!.criterion];
  expanded.findings.forEach((item, index) => {
    item.criterion = recorded[index]!.criterion;
    item.observations.forEach((observation, side) => { observation.supportBoundary = recorded[index]!.boundaries[side]!; });
  });
  assert.match(await f.discovery.update(expanded), /status=accepted/);
  const recordedState = f.discovery.state();
  const rejection = (await draft.tool().execute(legacy, f.signal)).content;
  assert.match(rejection, /draft_details_too_long/);
  assert.ok(Number(/detailsTextCharacters=(\d+)/.exec(rejection)![1]) >= 900, 'the recorded long scope still counts toward the same budget');
  const compact = { ...decision, scopeSummaries: [
    { findingId: 'scope-0', baseline: '源码轮心参数已检；实际渲染帧、历史生成检查记录未知。', candidate: '源码轮心参数已检；实际渲染帧、候选验证事件载荷未读。' },
    { findingId: 'scope-1', baseline: '可见回复已检；此前工具自检载荷、可能额外交付未知。', candidate: '可见回复已检；此前工具自检载荷、可能额外交付未知。' },
  ] };
  assert.match((await draft.tool().execute(compact, f.signal)).content, /status=accepted/);
  assert.equal(f.discovery.state(), recordedState);
  const compactHtml = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.ok([...comparisonDetailsText(compactHtml, { excludeValidatedQuotes: true }).replace(/\s/g, '')].length <= 400);
});

test('decision input is a strict object; canonical materialization derives only basis IDs and empty markup', () => {
  const input = { ...base, findingDispositions: [
    { findingId: 'a', disposition: 'basis' as const, explanation: 'Task use' },
    { findingId: 'b', disposition: 'boundary' as const, explanation: 'Unknown could reverse choice' },
    { findingId: 'c', disposition: 'not_decisive' as const, explanation: 'Outside requested relation' },
  ] };
  assert.equal(ComparisonDecisionDraftSubmissionSchema.type, 'object');
  assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, input), true);
  const canonical = materializeComparisonDecisionDraft(input);
  assert.equal(Value.Check(ComparisonDraftSubmissionSchema, canonical), true);
  assert.deepEqual(canonical.decisionBasis, ['a']);
  assert.equal(canonical.comparisonHtml, '<p></p>');
  assert.equal(canonical.detailsHtml, undefined);
  assert.equal('kind' in canonical, false);
  assert.deepEqual(canonical.findingDispositions, input.findingDispositions);
  assert.deepEqual(canonical.scopeSummaries, input.scopeSummaries);
  assert.equal(canonical.decisionSummary, input.decisionSummary);
  assert.equal(canonical.decisionBoundary, input.decisionBoundary);
  for (const extra of [{ comparisonHtml: '<p>Duplicate</p>' }, { detailsHtml: '<p>Hidden</p>' }, { decisionBasis: ['other'] }, { ignored: 'extra' }]) {
    assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, { ...input, ...extra }), false);
  }
  for (const key of Object.keys(base)) {
    const missing = { ...base } as Record<string, unknown>; delete missing[key];
    assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, missing), false, key);
  }
  for (const summary of [{ findingId: 'a', baseline: ' ', candidate: 'checked' }, { findingId: 'a', baseline: 'checked' },
    { findingId: 'a', baseline: 'checked', candidate: 'checked', hiddenScope: 'extra' }]) {
    assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, { ...base, scopeSummaries: [summary] }), false);
  }
});

test('live tool renders one escaped summary and boundary and retains exact legacy full compatibility', async t => {
  const f = await fixture(t);
  assert.equal(f.tool.parameters.type, 'object');
  assert.equal(Value.Check(f.tool.parameters, base), true);
  const submitted = { ...base, decisionSummary: 'Choice <script> & task use', decisionBoundary: 'Unknown <img> may change choice' };
  assert.match((await f.tool.execute(submitted, f.signal)).content, /status=accepted/);
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.equal(comparisonVisibleMainText(html).split(submitted.decisionSummary).length - 1, 1);
  assert.match(html, /Choice &lt;script&gt; &amp; task use/);
  assert.match(html, /Unknown &lt;img&gt; may change choice/);
  const inspection = JSON.parse((await f.draft.inspectTool().execute({}, f.signal)).content) as { comparisonHtml: string };
  assert.match(inspection.comparisonHtml, /Choice &lt;script&gt;/);
  for (const extra of [{ comparisonHtml: '<p>Injected</p>' }, { detailsHtml: '<p>Ignored</p>' }, { decisionBasis: [] }, { arbitrary: true }]) {
    const invalid = { ...base, ...extra };
    assert.equal(Value.Check(f.tool.parameters, invalid), false);
    assert.match((await f.tool.execute(invalid, f.signal)).content, /invalid_submission/);
    assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), html);
  }
  const full = { ...materializeComparisonDecisionDraft(base), comparisonHtml: '<p>Legacy necessary detail</p>', detailsHtml: '<p>Legacy method</p>' };
  assert.equal(Value.Check(f.tool.parameters, full), true);
  assert.match((await f.tool.execute(full, f.signal)).content, /status=accepted/);
  assert.match(await readFile(join(f.root, 'report.html'), 'utf8'), /Legacy necessary detail/);
});

test('lean submissions cannot omit current findings or erase important boundaries and preserve original length gates', async t => {
  const f = await fixture(t, true);
  assert.match((await f.tool.execute(base, f.signal)).content, /decision_findings_invalid/);
  const valid: ComparisonDecisionDraftSubmission = { ...base,
    findingDispositions: [{ findingId: 'quality', disposition: 'basis', explanation: 'Uncertainty affects use' }],
    scopeSummaries: [{ findingId: 'quality', baseline: 'Final output unverified.', candidate: 'Final output unverified.' }] };
  assert.match((await f.tool.execute({ ...valid, findingDispositions: [...valid.findingDispositions, ...valid.findingDispositions] }, f.signal)).content, /invalid_submission/);
  assert.match((await f.tool.execute({ ...valid, decisionBoundary: '' }, f.signal)).content, /decision_boundary_missing/);
  assert.match((await f.tool.execute({ ...valid, status: 'completed', conclusionScope: 'supported_in_scope' }, f.signal)).content, /decision_scope_incomplete/);
  assert.match((await f.tool.execute(valid, f.signal)).content, /status=accepted/);
  const before = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.match(before, /delivered-output support unverified|delivered output has not been verified/);
  for (const [decisionShape, limit] of [['single_difference', 250], ['multiple_differences', 600]] as const) {
    assert.match((await f.tool.execute({ ...valid, decisionShape, decisionSummary: 'x'.repeat(limit) }, f.signal)).content, /draft_too_long/);
    assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), before);
  }
});

test('decision media uses registered image refs, escaped captions and the existing main budget', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(f.root, 'sample.png'), png);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: f.root, attemptId: 'images', links: [], media: [
    { ref: 'media:sample', side: 'baseline', inspectPath: 'sample.png', reportHref: 'sample.png', mediaType: 'image/png',
      available: true, contentHash: sha256(png) },
    { ref: 'media:missing', side: 'candidate', inspectPath: 'missing.png', reportHref: 'missing.png', mediaType: 'image/png', available: false },
  ] });
  const draft = new ComparisonDraft({ attemptRoot: f.root, task: 'Compare outputs', facts, locale: 'en', catalog, deliveredImages: new Set() });
  const caption = 'Baseline <script> & "sample"';
  const submission = { ...base, media: [{ ref: 'media-01', caption }] };
  assert.match((await draft.tool().execute(submission, f.signal)).content, /status=accepted/);
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.match(html, /data-media-ref="media-01"/);
  assert.ok(comparisonVisibleMainText(html).includes(caption));
  assert.doesNotMatch(materializeComparisonDecisionDraft(submission).comparisonHtml, /data-claim="visual"/);
  for (const ref of ['media-02', 'media-99']) {
    assert.match((await draft.tool().execute({ ...base, media: [{ ref, caption: 'Unavailable' }] }, f.signal)).content, /media_unavailable/);
  }
  assert.match((await draft.tool().execute({ ...base, media: [{ ref: 'media-01', caption: 'x'.repeat(160) },
    { ref: 'media-01', caption: 'y'.repeat(160) }] }, f.signal)).content, /draft_too_long/);
  assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), html);
  assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, { ...base, media: [{ ref: '../sample.png', caption }] }), false);
});
