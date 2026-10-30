import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ComparisonReportModelSchema } from '../../src/core/schema.js';
import { comparisonReportModelFromHtml } from '../../src/application/comparison-publication.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutonomousReportTool } from '../../src/application/comparison-autonomous-tools.js';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-autonomous-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scratch'));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const facts = {
    run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' },
    activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
    delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' },
  };
  const draft = new ComparisonDraft({ attemptRoot: root, task: 'Compare text', locale: 'zh', catalog, deliveredImages: new Set(), facts: facts });
  return { root, facts, draft, tool: createAutonomousReportTool(draft, root) };
}
const params = { reason: 'Current preserves the missing detail.', pairedDifferences: [], status: 'completed', category: 'Text comparison', headline: '推荐当前', path: 'scratch/report.html' };
const signal = new AbortController().signal;

test('file report submission shares draft validation, accepts semantic HTML and invalidates old previews on revision', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, params.path), '');
  await writeFile(join(f.root, 'scratch/details.html'), '<p>Compared the complete documents.</p>');
  await assert.rejects(f.tool.execute({ ...params, detailsPath: 'scratch/details.html' }, signal), /Invalid/);
  const response = await f.tool.execute(params, signal);
  assert.match(response.content, /"status":"accepted"/);
  assert.ok(response.details);
  const alias = join(f.root, 'alias');
  await symlink(f.root, alias, 'junction');
  assert.match((await createAutonomousReportTool(f.draft, alias).execute(params, signal)).content, /"status":"accepted"/);
  await rm(alias);
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  const model = comparisonReportModelFromHtml(html, f.facts,{ status: 'completed', reportPath: 'report.html', headline: params.headline, evidenceRefs: [] }, []);
  assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
  // A cache write is a persisted token part: a stored report carrying one must stay Value.Check-valid.
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, metrics: { baseline: { tokens: { total: 5, cacheCreation: 7 } } } }), true);
  assert.equal(model.formatVersion, 7);
  assert.equal(Object.hasOwn(model, 'boundary'), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, boundary: 'old caveat' }), false);
  await assert.rejects(f.tool.execute({ ...params, boundary: 'old caveat' }, signal), /Invalid/);
  assert.doesNotMatch(f.tool.description, /before-adoption|reason, boundary/);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, pairedDifferences: undefined }), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, pairedDifferences: Array(4).fill({dimension:'a',baseline:'b',candidate:'c',impact:'d'}) }), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, formatVersion: 2, boundary: undefined, differences: undefined }), true);
  assert.doesNotMatch(html, /data-host-limitation="hostLimitationShareCardPresentation"/);
  const accepted = f.draft.acceptedReceipt();
  f.draft.recordPreview({ htmlPath: 'preview.html', html, draftDigest: accepted.draftDigest, preparedDigest: accepted.draftDigest,
    dependencyDigest: accepted.draftDigest, catalogRevision: accepted.catalogRevision, outputRoot: f.root });
  assert.equal((await f.draft.completedResult())?.status, 'completed');
  await f.tool.execute({ ...params, status: 'insufficient_evidence' }, signal);
  assert.equal(await f.draft.completedResult(), undefined);
  await writeFile(join(f.root, params.path), '<script>alert(1)</script>');
  assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
});

test('report submission rejects traversal, junction escape, malformed UTF8, oversized files and cancellation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tool.execute({ ...params, path: '../outside.html' }, signal), /inside scratch/);
  await assert.rejects(f.tool.execute({ ...params, path: join(f.root, 'scratch/report.html') }, signal), /inside scratch/);
  await assert.rejects(f.tool.execute({ ...params, extra: true }, signal), /Invalid/);
  await writeFile(join(f.root, params.path), Buffer.from([0xff]));
  await assert.rejects(f.tool.execute(params, signal), /encoded data/);
  await writeFile(join(f.root, params.path), 'x'.repeat(262_145));
  await assert.rejects(f.tool.execute(params, signal), /exceeds/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.tool.execute(params, cancelled.signal));
  const outside = await mkdtemp(join(tmpdir(), 'reprise-autonomous-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'report.html'), '<p>Outside</p>');
  await symlink(outside, join(f.root, 'scratch/escape'), 'junction');
  await assert.rejects(f.tool.execute({ ...params, path: 'scratch/escape/report.html' }, signal), /escapes/);
  await rm(join(f.root, 'scratch/escape'));
  await rm(join(f.root, 'scratch'), { recursive: true });
  await symlink(outside, join(f.root, 'scratch'), 'junction');
  await assert.rejects(f.tool.execute(params, signal), /Scratch directory escapes/);
  await rm(join(f.root, 'scratch'));
});

test('paired reports enforce short recommendations, complete pairs, private text and media-only fragments', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, params.path), '');
  const difference = { dimension: 'What is preserved?', baseline: 'Unknown', candidate: 'Verified paragraph', impact: 'Ready for further review' };
  for (const pairedDifferences of [[], [difference], [difference, difference], [difference, difference, difference]]) {
    assert.match((await f.tool.execute({ ...params, pairedDifferences }, signal)).content, /"status":"accepted"/);
  }
  await assert.rejects(f.tool.execute({ ...params, pairedDifferences: Array(4).fill(difference) }, signal), /Invalid/);
  await assert.rejects(f.tool.execute({ ...params, pairedDifferences: [{ ...difference, impact: '' }] }, signal), /Invalid/);
  for (const headline of ['推荐当前，先修背景', '😀'.repeat(81)]) assert.match((await f.tool.execute({ ...params, headline }, signal)).content, /status=rejected/);
  for (const reason of ['字'.repeat(901), 'private.docx']) assert.match((await f.tool.execute({ ...params, reason }, signal)).content, /status=rejected/);
  for (const content of ['<table><tr><td>Repeated evidence</td></tr></table>', '<p>Repeated difference.</p>', '<details><summary>Hidden</summary></details>']) {
    await writeFile(join(f.root, params.path), content);
    assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
  }
});
