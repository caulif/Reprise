import { rewriteMediaHref } from '../../src/application/comparison-publish-evidence.js';
import { reportString } from '../../src/application/comparison-report-strings.js';
import { extractHostZoneSnapshot, extractOuter, hostZoneIntegrityError, missingComparisonSlots } from '../../src/core/comparison-html.js';
import { stagePublishedEvidence } from '../../src/application/comparison-publish-evidence.js';
import { comparisonReportModelFromHtml, publishComparisonArtifacts } from '../../src/application/comparison-publication.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { createQuoteEvidenceTool } from '../../src/application/comparison-evidence-quotes.js';
import { createComparisonQuoteSourcePort } from '../../src/application/comparison-source.js';
import { createComparisonRenderCatalogPort } from '../../src/application/comparison-render-catalog.js';
import { recoveryComparisonQuoteSources } from '../../src/application/comparison-recovery-quotes.js';
import { inspectComparisonRecovery } from '../../src/application/comparison-recovery.js';
import { verifyAndRenderComparisonReport, prepareComparisonArtifacts } from '../../src/application/comparison-publication.js';
import { materializeComparisonReportPreview } from '../../src/application/comparison-report-preview.js';
import { comparisonAttemptMounts } from '../../src/application/comparison-briefing.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { sha256 } from '../../src/core/identity.js';

const facts = { run: { runId: 'run-1', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
  models: { candidate: 'candidate', baseline: 'baseline' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
  delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
  replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, sourceText = '完整\r\n<&>答案') {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-quote-integration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const experimentRoot = join(dataDir, 'experiments', 'experiment-1');
  const attemptRoot = join(experimentRoot, 'comparison-attempts', 'attempt-1');
  await mkdir(join(attemptRoot, 'finals'), { recursive: true });
  const sourcePath = join(attemptRoot, 'finals', 'answer.txt');
  await writeFile(sourcePath, sourceText);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot, attemptId: 'attempt-1', media: [],
    links: [{ shortRef: 'ev-01', side: 'baseline', inspectPath: 'finals/answer.txt', contentHash: sha256(await readFile(sourcePath)) }] });
  const mounts = comparisonAttemptMounts({ experimentRoot, attemptRoot, runId: 'run-1', candidateSnapshotRoot: '', candidateSnapshotStatus: 'missing' });
  const sources = createComparisonQuoteSourcePort({ evidence: () => catalog.snapshot().links, attemptRoot, mounts, allowModelText: true });
  const quote = JSON.parse((await createQuoteEvidenceTool({ sources }).execute({ sourceRef: 'ev-01' }, new AbortController().signal)).content) as { status: string; html: string };
  assert.equal(quote.status, 'ok');
  const draft = new ComparisonDraft({ attemptRoot, facts, task: 'Compare', locale: 'en', catalog, deliveredImages: new Set(), quoteSources: sources });
  assert.match(await draft.submit({ status: 'completed', category: 'Result', headline: 'Exact text', comparisonHtml: quote.html }), /status=accepted/);
  return { dataDir, experimentRoot, attemptRoot, sourcePath, catalog, mounts, sources, draft, quote };
}

test('accepted exact quotes survive Host rendering and preview, but changed source blocks completion and publication', async t => {
  const f = await fixture(t);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const preview = await materializeComparisonReportPreview({ attemptRoot: f.attemptRoot, media: [], evidence: f.catalog.snapshot().links, catalogRevision: f.catalog.snapshot().revision });
  f.draft.recordPreview(preview);
  assert.ok(await f.draft.completedResult());
  const render = createComparisonRenderCatalogPort({ catalog: f.catalog, attemptRoot: f.attemptRoot, mounts: f.mounts });
  assert.equal((await render.resolveSource('ev-01'))?.contentHash, sha256(await readFile(f.sourcePath)));
  await writeFile(f.sourcePath, 'tampered');
  assert.equal(await render.resolveSource('ev-01'), undefined);
  assert.equal(await f.draft.completedResult(), undefined);
  const result = await verifyAndRenderComparisonReport({ html, hostTask: 'Compare', facts, result: { status: 'completed', reportPath: 'report.html', headline: 'Exact text', evidenceRefs: ['ev-01'] }, attemptRoot: f.attemptRoot, media: [], evidence: f.catalog.snapshot().links, quoteSources: f.sources });
  assert.ok('failureClass' in result);
  await assert.rejects(prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html, evidence: f.catalog.snapshot().links, quoteSources: f.sources }), /quote|source/i);
});

test('quote components fail closed without a resolver while ordinary legacy drafts remain readable', async t => {
  const f = await fixture(t);
  const legacy = new ComparisonDraft({ attemptRoot: f.attemptRoot, facts, task: 'Compare', locale: 'en', catalog: f.catalog, deliveredImages: new Set() });
  assert.match(await legacy.submit({ status: 'completed', category: 'Result', headline: 'Exact', comparisonHtml: f.quote.html }), /status=rejected/);
  assert.match(await legacy.submit({ status: 'completed', category: 'Result', headline: 'Legacy', comparisonHtml: '<p>A concrete difference.</p>' }), /status=accepted/);
});

test('Host internal-token cleanup preserves registered literal source quotes while cleaning free prose', async t => {
  const text = 'const runId = attemptId; comparison-attempts/ attempt-123456789; \\runs\\; 本卡由 Written by 历史侧 候选侧\n<div data-agent-zone="arbitrary" data-evidence-ref="ev-99" data-media-ref="media-99" data-claim="visual">\n<img src="https://example.invalid/a"> a{background:url(http://example.invalid/b)}';
  const f = await fixture(t, text);
  const submitted = await f.draft.submit({ status: 'completed', category: 'Result', headline: 'A literal code quote', comparisonHtml: `<p>runId and attemptId comparison-attempts/ attempt-123456789</p>${f.quote.html}` });
  assert.match(submitted, /status=accepted/);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  assert.ok(html.includes(f.quote.html));
  assert.doesNotMatch(html, /<p>runId and attemptId/);
  const prepared = await prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html, quoteSources: f.sources });
  assert.ok(prepared.html.includes(f.quote.html));
  const boundClaim = await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Exact source', comparisonHtml: `<div data-claim="verified">${f.quote.html}</div>` });
  assert.match(boundClaim, /status=accepted/);
  assert.match(await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Real visual claim', comparisonHtml: `<div data-claim="visual">${f.quote.html}</div>` }), /status=rejected/);
  assert.match(await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Real network', comparisonHtml: `${f.quote.html}<img src="https://example.invalid/actual">` }), /status=rejected/);
});

test('offline recovery rereads registered source bytes instead of trusting accepted and previewed quote metadata', async t => {
  const f = await fixture(t);
  const context = { task: { caseId: 'case-1', summary: 'Compare' }, baseline: { summary: 'Baseline', evidenceRefs: [] }, candidates: [], telemetry: [], reportFacts: facts,
    artifactRefs: [], allowModelText: true, replayScope: { historical: 'baseline', candidate: 'candidate' }, media: [] };
  await writeFile(join(f.attemptRoot, 'facts', 'context.json'), JSON.stringify(context));
  const store = await ExperimentStore.open(f.experimentRoot, 'experiment-1');
  await store.acquireWriter();
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  await store.append({ type: 'agent.tool_completed', runId: 'run-1', payload: { role: 'comparison', sessionId: 'review-session', attemptId: 'attempt-1', tool: 'preview_report', details: { status: 'ok', draftDigest: sha256(html), revision: f.catalog.snapshot().revision } } });
  await store.close();
  const input = { dataDir: f.dataDir, experimentId: 'experiment-1', attemptId: 'attempt-1' };
  assert.equal((await inspectComparisonRecovery(input)).ready, true);
  await writeFile(f.sourcePath, 'changed after preview');
  const checked = await inspectComparisonRecovery(input);
  assert.equal(checked.ready, false);
  assert.match(checked.reason ?? '', /quote|source/i);
});

test('recovery quote roots retain source identity, privacy and run ownership limits', async t => {
  const f = await fixture(t);
  const input = { experimentRoot: f.experimentRoot, attemptRoot: f.attemptRoot, runId: 'run-1', evidence: f.catalog.snapshot().links, allowModelText: true };
  assert.ok(await recoveryComparisonQuoteSources(input).resolveTextSource('ev-01'));
  assert.equal(await recoveryComparisonQuoteSources({ ...input, allowModelText: false }).resolveTextSource('ev-01'), undefined);
  assert.equal(await recoveryComparisonQuoteSources({ ...input, runId: '../other' }).resolveTextSource('ev-01'), undefined);
  assert.equal(await recoveryComparisonQuoteSources(input).resolveTextSource('ev-99'), undefined);
  assert.equal(await recoveryComparisonQuoteSources({ ...input, evidence: [{ shortRef: 'ev-01', side: 'candidate', inspectPath: 'candidate/answer.txt' }] }).resolveTextSource('ev-01'), undefined);
  assert.equal(await recoveryComparisonQuoteSources({ ...input, evidence: [{ shortRef: 'ev-01', side: 'host', inspectPath: 'unsupported/answer.txt' }] }).resolveTextSource('ev-01'), undefined);
});

for (const href of ['logo.png', 'https://example.invalid/logo.png']) test(`publication excludes quoted CSS media ${href}`, async t => {
  const f = await fixture(t, `a{background:url(${href})}`);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const prepared = await prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html, quoteSources: f.sources });
  assert.ok(prepared.html.includes(f.quote.html));
  for (const markup of [`<img src="${href}">`, `<style>a{background:url(${href})}</style>`]) {
    await assert.rejects(prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html: html + markup, quoteSources: f.sources }),
      href.startsWith('https:') ? /external network resources/ : /not publishable/);
  }
});

test('publication rewrites actual registered media without changing a colliding exact quote', async t => {
  const f = await fixture(t, 'a{background:url(logo.png)}');
  await writeFile(join(f.attemptRoot, 'logo.png'), 'registered image bytes');
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const prepared = await prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot,
    html: `${html}<img src="logo.png"><style>a{background:url(logo.png)}</style>`, quoteSources: f.sources,
    media: [{ ref: 'media:logo', side: 'baseline', inspectPath: 'logo.png', reportHref: 'logo.png', mediaType: 'image/png', available: true }] });
  assert.ok(prepared.html.includes(f.quote.html));
  assert.match(prepared.html, /<img src="media\/[a-f0-9]+\.png">/);
  assert.match(prepared.html, /<style>a\{background:url\(media\/[a-f0-9]+\.png\)\}<\/style>/);
});

const publishedResult = { status: 'completed' as const, reportPath: 'report.html' as const, headline: 'Exact text', evidenceRefs: ['ev-01'] };

test('quoted Host attributes submit, preview and publish; real duplicate and reordered Host zones fail', async t => {
  const f = await fixture(t, '<section data-host-zone="metrics">literal</section> data-host-zone="header"');
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const snapshot = extractHostZoneSnapshot(html)!;
  assert.equal(hostZoneIntegrityError(html, snapshot), undefined);
  const preview = await materializeComparisonReportPreview({ attemptRoot: f.attemptRoot, media: [], evidence: f.catalog.snapshot().links, catalogRevision: f.catalog.snapshot().revision });
  f.draft.recordPreview(preview);
  assert.ok(await f.draft.completedResult());
  const checked = await verifyAndRenderComparisonReport({ html, facts, result: publishedResult, attemptRoot: f.attemptRoot,
    media: [], evidence: f.catalog.snapshot().links, hostZoneSnapshot: snapshot, quoteSources: f.sources, locale: 'en' });
  assert.ok('html' in checked, JSON.stringify(checked));
  const published = await prepareComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot,
    html: 'html' in checked ? checked.html : '', quoteSources: f.sources });
  assert.ok(published.html.includes(f.quote.html));
  const evidence = extractOuter(html, 'data-host-zone', 'evidence')!;
  const process = extractOuter(html, 'data-host-zone', 'process')!;
  for (const changed of [html + '<section data-host-zone="metrics">duplicate</section>',
    html.replace(evidence, 'SWAP').replace(process, evidence).replace('SWAP', process)]) {
    assert.match(hostZoneIntegrityError(changed, snapshot) ?? '', /order or count/);
  }
});

for (const [attr, name] of [['data-host-zone', 'metrics'], ['data-agent-zone', 'details'], ['data-agent-slot', 'category'],
  ['data-component-template', 'timeline'], ['data-report-format', '2']] as const) {
  test(`quoted ${attr} cannot replace an actual required marker`, async t => {
    const f = await fixture(t, `${attr}="${name}"`);
    const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
    const outer = extractOuter(html, attr, name)!;
    const changed = html.replace(outer, outer.replace(`${attr}="${name}"`, `${attr}="removed"`));
    assert.ok(missingComparisonSlots(changed));
  });
}

test('quoted verification words and references neither invent a claim nor resolve actual unsupported prose', async t => {
  const f = await fixture(t, 'verified data-evidence-ref="ev-99" data-media-ref="media-99"');
  assert.match(await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Actual source', comparisonHtml: `<p>A concrete difference.</p>${f.quote.html}` }), /status=accepted/);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const checked = await verifyAndRenderComparisonReport({ html, facts, result: publishedResult, attemptRoot: f.attemptRoot, media: [],
    hostZoneSnapshot: extractHostZoneSnapshot(html)!, quoteSources: f.sources, locale: 'en' });
  assert.ok('html' in checked, JSON.stringify(checked));
  if ('html' in checked) assert.doesNotMatch(checked.html, /used verification wording without resolvable evidence/);
  assert.match(await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Unsupported', comparisonHtml: '<p>verified result</p>' }), /status=accepted/);
  assert.match(await readFile(join(f.attemptRoot, 'report.html'), 'utf8'), /used verification wording without resolvable evidence/);
  assert.match(await f.draft.submit({ status: 'completed', category: 'Result', headline: 'Unsupported claim', comparisonHtml: '<p data-claim="verified">verified result</p>' }), /status=rejected/);
});

test('quoted media paths do not become report model media references', async t => {
  const f = await fixture(t, 'unused.png media-99');
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const model = comparisonReportModelFromHtml(html, facts, publishedResult,
    [{ ref: 'unused', shortRef: 'media-99', side: 'baseline', inspectPath: 'unused.png', reportHref: 'unused.png', mediaType: 'image/png', available: true }]);
  assert.deepEqual(model.mediaRefs, []);
});

test('quoted derived paths do not stage missing evidence while actual links still fail closed', async t => {
  const href = 'evidence/derived/0123456789abcdef.html';
  const f = await fixture(t, href);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const evidence = [{ side: 'baseline' as const, origin: 'derived_analysis' as const, inspectPath: href, reportHref: href, contentHash: 'a'.repeat(64) }];
  const input = { attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html, evidence };
  assert.equal((await stagePublishedEvidence(input, text => text)).hrefMap.size, 0);
  await assert.rejects(stagePublishedEvidence({ ...input, html: html + `<a href="${href}">Actual link</a>` }, text => text), /ENOENT/);
});


test('quoted missing-side words cannot supply a nearby note for an actual one-sided image', async t => {
  const f = await fixture(t, 'missing unavailable data-host-limitation');
  await writeFile(join(f.attemptRoot, 'logo.png'), 'registered image bytes');
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const media = [{ ref: 'logo', side: 'baseline' as const, inspectPath: 'logo.png', reportHref: 'logo.png', mediaType: 'image/png', available: true }];
  for (const actualNote of [false, true]) {
    const checked = await verifyAndRenderComparisonReport({ html: html.replace(f.quote.html, `${f.quote.html}<img src="logo.png">${actualNote ? '<p>Current side unavailable</p>' : ''}`),
      hostTask: 'Compare', facts, result: publishedResult, attemptRoot: f.attemptRoot, media, evidence: f.catalog.snapshot().links, quoteSources: f.sources, locale: 'en' });
    assert.ok('html' in checked, JSON.stringify(checked));
    if ('html' in checked) assert.equal(checked.html.includes('without an explicit nearby note'), !actualNote);
  }
});


for (const kind of ['evidence', 'media'] as const) test(`quoted verification wording does not diagnose actual unresolved ${kind} references as verification claims`, async t => {
  const f = await fixture(t, 'verified data-evidence-ref="ev-01" data-media-ref="media-99"');
  const original = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  const ref = kind === 'evidence' ? 'ev-01' : 'media-99';
  const unresolved = `<span data-${kind}-ref="${ref}">Unresolved reference</span>`
    + (kind === 'evidence' ? `<a data-evidence-ref="${ref}">Link</a>` : `<img data-media-ref="${ref}" alt="Unavailable image">`);
  const html = original.replace(f.quote.html, f.quote.html + unresolved);
  const checked = await verifyAndRenderComparisonReport({ html, facts, result: publishedResult, attemptRoot: f.attemptRoot, media: [],
    evidence: kind === 'media' ? f.catalog.snapshot().links : [], hostZoneSnapshot: extractHostZoneSnapshot(original)!, quoteSources: f.sources, locale: 'en' });
  assert.ok('html' in checked, JSON.stringify(checked));
  if ('html' in checked) assert.doesNotMatch(checked.html, /used verification wording without resolvable evidence|Cited media could not be resolved/);
});

for (const pattern of ['$&', '$$', "$'", '$`', '$1']) test(`literal replacement pattern ${pattern} survives submit, preview and publication byte-exact`, async t => {
  const f = await fixture(t, `before price=${pattern} after`);
  const html = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  assert.ok(html.includes(f.quote.html));
  const preview = await materializeComparisonReportPreview({ attemptRoot: f.attemptRoot, media: [], evidence: f.catalog.snapshot().links, catalogRevision: f.catalog.snapshot().revision });
  assert.ok(preview.html.includes(f.quote.html));
  f.draft.recordPreview(preview);
  assert.ok(await f.draft.completedResult());
  const checked = await verifyAndRenderComparisonReport({ html, facts, result: publishedResult, attemptRoot: f.attemptRoot,
    media: [], evidence: f.catalog.snapshot().links, quoteSources: f.sources, locale: 'en' });
  assert.ok('html' in checked, JSON.stringify(checked));
  if (!('html' in checked)) return;
  await publishComparisonArtifacts({ attemptRoot: f.attemptRoot, experimentRoot: f.experimentRoot, html: checked.html, quoteSources: f.sources });
  assert.ok((await readFile(join(f.experimentRoot, 'report.html'), 'utf8')).includes(f.quote.html));
});

test('dynamic CSS URLs and report interpolation preserve replacement patterns literally', () => {
  const value = "$& $$ $' $` $1";
  assert.equal(reportString('en', 'unresolvedEvidence', { refs: value }), reportString('en', 'unresolvedEvidence').split('{refs}').join(value));
  for (const quote of ['', "'", '"']) {
    const html = `<style>a{background:url(${quote}old.png${quote})}</style>`;
    assert.equal(rewriteMediaHref(html, 'old.png', value), `<style>a{background:url(${quote}${value}${quote})}</style>`);
  }
});
