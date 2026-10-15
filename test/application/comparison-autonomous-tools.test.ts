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
const params = { boundary: 'Task quality remains unverified.', differences: ['Candidate preserves the final paragraph.'], status: 'completed', category: 'Text comparison', headline: 'Candidate preserves the missing detail', path: 'scratch/report.html' };
const signal = new AbortController().signal;

test('file report submission shares draft validation, accepts semantic HTML and invalidates old previews on revision', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, params.path), '<p>The candidate preserves the final paragraph.</p>');
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
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, boundary: undefined }), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, differences: undefined }), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...model, differences: ['a', 'b', 'c', 'd'] }), false);
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

test('compact reports enforce Unicode recommendation, difference and all-fragment text budgets', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, params.path), '<p>Evidence.</p>');
  for (const differences of [[], ['A'], ['A', 'B'], ['A', 'B', 'C']]) {
    assert.match((await f.tool.execute({ ...params, differences }, signal)).content, /"status":"accepted"/);
  }
  assert.match((await f.tool.execute({ ...params, headline: 'A < B & C' }, signal)).content, /"status":"accepted"/);
  assert.match(await readFile(join(f.root, 'report.html'), 'utf8'), /A &lt; B &amp; C/);
  await assert.rejects(f.tool.execute({ ...params, differences: ['A', 'B', 'C', 'D'] }, signal), /Invalid/);
  assert.match((await f.tool.execute({ ...params, headline: '😀'.repeat(80), boundary: '', differences: [] }, signal)).content, /"status":"accepted"/);
  assert.match((await f.tool.execute({ ...params, headline: '😀'.repeat(81) }, signal)).content, /status=rejected/);
  assert.match((await f.tool.execute({ ...params, differences: ['字'.repeat(61)] }, signal)).content, /status=rejected/);
  assert.match((await f.tool.execute({ ...params, differences: ['字 '.repeat(60)] }, signal)).content, /"status":"accepted"/);
  await writeFile(join(f.root, params.path), `<table><tr><td>${'字'.repeat(901)}</td></tr></table>`);
  assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
  await writeFile(join(f.root, params.path), `<p data-host-limitation="fake">${'字'.repeat(901)}</p>`);
  assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
  await writeFile(join(f.root, params.path), '<details><summary>Brief</summary><p>Short supporting text.</p></details>');
  assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
  await writeFile(join(f.root, params.path), `<details><summary>Brief</summary><p>${'字'.repeat(901)}</p></details>`);
  assert.match((await f.tool.execute(params, signal)).content, /status=rejected/);
});
