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
