import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { captureHistoricalDelivery, selectedHistoricalDelivery } from '../../src/application/historical-delivery.js';
import { prepareHistoricalArtifacts } from '../../src/application/prepare-historical-artifacts.js';
import { comparisonSealedFinalLinks } from '../../src/application/comparison-sealed-finals.js';
import { materializeComparisonReportPreview } from '../../src/application/comparison-report-preview.js';
import { prepareComparisonArtifacts } from '../../src/application/comparison-publication.js';
import { HistoricalDeliverySelectionSchema, HistoricalArtifactManifestSchema } from '../../src/core/schema.js';
import { sha256 } from '../../src/core/identity.js';
import { captureGitTree, assertCapturePath } from '../../src/infrastructure/historical-git-capture.js';
import { runCli } from '../../src/cli/main.js';
import { renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';
import { context, taskCase } from '../support/comparison-fixtures.js';

const now = '2026-10-14T00:00:00.000Z';
const git = promisify(execFile);
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-delivery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const task = taskCase();
  task.privacy.allowBinary = true;
  const caseDir = join(dataDir, 'cases', task.caseId);
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'case.json'), JSON.stringify(task));
  const sourcePath = join(dataDir, 'source.docx');
  const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 128, 13, 10]);
  await writeFile(sourcePath, bytes);
  const input = { dataDir, taskCase: task, now, selectionBasis: 'User approved a nearby version, not the original.',
    source: { kind: 'user_selected_substitute' as const, sourcePath, logicalPath: '申请书-修改版.docx', expectedHash: sha256(bytes), userInstruction: 'Use this substitute.' } };
  return { dataDir, caseDir, sourcePath, bytes, input, task };
}

test('substitute capture overrides legacy empty finals without changing the case or reading live source later', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.caseDir, 'case.json'));
  await mkdir(join(f.caseDir, 'baseline-artifacts'));
  const legacy = { schemaVersion: 1, sourceHash: 'a'.repeat(64), extractorVersion: 'old', artifacts: [], issues: [] };
  await writeFile(join(f.caseDir, 'baseline-artifacts', 'manifest.json'), JSON.stringify(legacy));
  const captured = await captureHistoricalDelivery(f.input);
  await rm(f.sourcePath);
  const attemptRoot = join(f.dataDir, 'comparison-attempts', 'attempt');
  const prepared = await prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot });
  assert.equal(prepared.source, 'selected-delivery');
  assert.equal(prepared.manifest?.schemaVersion, 2);
  assert.deepEqual(await readFile(join(prepared.finalsRoot, f.input.source.logicalPath)), f.bytes);
  assert.deepEqual(await readFile(join(f.caseDir, 'case.json')), before);
  const oldManifest = JSON.parse(await readFile(join(f.caseDir, 'baseline-artifacts', 'manifest.json'), 'utf8')) as { artifacts: unknown[] };
  assert.equal(oldManifest.artifacts.length, 0);
  const links = await comparisonSealedFinalLinks(attemptRoot);
  assert.equal(links.links[0]?.origin, 'user_selected_substitute');
  assert.match(links.links[0].label!, /NOT the original/);
  const selected = await selectedHistoricalDelivery(f.caseDir, f.task);
  assert.equal(selected?.manifest.selectionId, captured.selectionId);
  assert.equal(selected?.manifest.capture.kind, 'user_selected_substitute');
  const receipt = JSON.parse(await readFile(join(selected.root, 'receipt.json'), 'utf8')) as { sourceLocator: string };
  assert.equal(receipt.sourceLocator, f.sourcePath);
  assert.doesNotMatch(await readFile(join(prepared.finalsRoot, 'manifest.json'), 'utf8'), /sourceLocator|source\.docx/);
  const preview = await materializeComparisonReportPreview({ attemptRoot, draftHtml: `<a href="${links.links[0].reportHref}">Baseline</a>`, media: [], evidence: links.links, catalogRevision: 1 });
  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot: f.dataDir, html: preview.html, evidence: links.links });
  const href = published.html.match(/href="([^"]+)"/)![1]!;
  assert.deepEqual(await readFile(join(f.dataDir, ...decodeURIComponent(href).split('/'))), f.bytes);
});

test('a new selection does not modify previously frozen attempts; hashes and binding fail closed', async t => {
  const f = await fixture(t);
  const first = await captureHistoricalDelivery(f.input);
  const attemptRoot = join(f.dataDir, 'first');
  await prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot });
  const body = await readFile(join(attemptRoot, 'finals', 'manifest.json'));
  await writeFile(f.sourcePath, 'second');
  await captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, expectedHash: sha256('second') } });
  assert.deepEqual(await readFile(join(attemptRoot, 'finals', 'manifest.json')), body);
  const selected = (await selectedHistoricalDelivery(f.caseDir, f.task))!;
  assert.notEqual(selected.manifest.selectionId, first.selectionId);
  await writeFile(join(selected.root, 'files', selected.manifest.selectionId, f.input.source.logicalPath), 'corrupted');
  await assert.rejects(prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot: join(f.dataDir, 'broken') }), /byteLength|contentHash/);
  await assert.rejects(selectedHistoricalDelivery(f.caseDir, { ...f.task, provenance: { ...f.task.provenance, sourceHash: 'f'.repeat(64) } }), /different case/);
  await writeFile(join(selected.root, 'manifest.json'), '{}');
  await assert.rejects(selectedHistoricalDelivery(f.caseDir, f.task), /identity mismatch/);
  await writeFile(join(f.dataDir, 'historical-deliveries', f.task.caseId, 'SELECTED.json'), '{broken');
  await assert.rejects(selectedHistoricalDelivery(f.caseDir, f.task), SyntaxError);
});

test('capture rejects unsupported paths, wrong hashes, missing consent, large files, and symlink files', async t => {
  const f = await fixture(t);
  await assert.rejects(captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, expectedHash: '0'.repeat(64) } }), /incorrect expected hash/);
  await assert.rejects(captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, userInstruction: '' } }), /schema/);
  for (const path of ['../escape', 'manifest.json', 'CON.txt', 'a./b', 'a/.git/config', '.env', 'credentials.json', 'harness-model.json', 'x:ads', 'a\u0000b', '/root']) {
    assert.throws(() => assertCapturePath(path), Error, path);
  }
  await assert.rejects(captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, sourcePath: f.dataDir } }), /regular file/);
  const handle = await import('node:fs/promises').then(fs => fs.open(join(f.dataDir, 'large.bin'), 'w'));
  await handle.truncate(32 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, sourcePath: join(f.dataDir, 'large.bin') } }), /budget/);
  const link = join(f.dataDir, 'link.docx');
  try { await symlink(f.sourcePath, link); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    return;
  }
  await assert.rejects(captureHistoricalDelivery({ ...f.input, source: { ...f.input.source, sourcePath: link } }), /regular file/);
});

test('capture-history CLI requires the exact frozen case and persists substitute provenance', async t => {
  const f = await fixture(t);
  const output: string[] = [];
  const io = { stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) };
  const args = ['capture-history', '--data-dir', f.dataDir, '--task-case', join(f.caseDir, 'case.json'), '--basis', 'User choice',
    '--file', f.sourcePath, '--logical-path', f.input.source.logicalPath, '--expected-hash', sha256(f.bytes), '--substitute', '--user-instruction', 'Use substitute', '--json'];
  assert.equal(await runCli(args, io), 0);
  assert.equal((JSON.parse(output[0]!) as { caseId: string }).caseId, f.task.caseId);
  assert.equal(await runCli(['capture-history'], io), 1);
  await writeFile(join(f.dataDir, 'other.json'), JSON.stringify({ ...f.task, initialInput: { ...f.task.initialInput, text: 'other' } }));
  assert.notEqual(await runCli(args.map(s => s === join(f.caseDir, 'case.json') ? join(f.dataDir, 'other.json') : s), io), 0);
  const selected: unknown = JSON.parse(await readFile(join(f.dataDir, 'historical-deliveries', f.task.caseId, 'SELECTED.json'), 'utf8'));
  assert.equal(Value.Check(HistoricalDeliverySelectionSchema, selected), true);
  assert.equal(Value.Check(HistoricalArtifactManifestSchema, { schemaVersion: 1, sourceHash: 'a'.repeat(64), extractorVersion: 'old', issues: [], artifacts: [] }), true);
});

test('generic JSON deliverables may use a nested manifest name; binary privacy remains enforced', async t => {
  const f = await fixture(t);
  const path = join(f.dataDir, 'manifest.json'); await writeFile(path, '{}');
  await captureHistoricalDelivery({ ...f.input, source: { kind: 'captured_file', sourcePath: path, logicalPath: 'result/manifest.json', expectedHash: sha256('{}') } });
  const prepared = await prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot: join(f.dataDir, 'json-attempt') });
  assert.equal(await readFile(join(prepared.finalsRoot, 'result/manifest.json'), 'utf8'), '{}');
  await assert.rejects(captureHistoricalDelivery({ ...f.input, taskCase: { ...f.task, privacy: { ...f.task.privacy, allowBinary: false } } }), /not authorized/);
});

test('Git capture exports exact committed binary bytes and never the dirty worktree or export-ignore subset', async t => {
  const f = await fixture(t);
  const repo = join(f.dataDir, 'repository'); await mkdir(repo);
  const run = (...args: string[]) => git('git', ['-C', repo, ...args], { windowsHide: true });
  await run('init');
  await writeFile(join(repo, 'binary.dat'), f.bytes);
  await writeFile(join(repo, '中文 file.txt'), 'committed');
  await writeFile(join(repo, '.gitattributes'), 'binary.dat export-ignore\n');
  await run('add', '.'); await run('update-index', '--chmod=+x', '中文 file.txt');
  await run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const commit = (await run('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repo, '中文 file.txt'), 'dirty');
  const before = (await run('status', '--porcelain=v1')).stdout;
  const result = await captureHistoricalDelivery({ ...f.input, source: { kind: 'git_snapshot', repository: repo, commit } });
  const manifest = (await selectedHistoricalDelivery(f.caseDir, f.task))!.manifest;
  assert.equal(manifest.capture.kind, 'git_snapshot');
  assert.equal(manifest.artifacts.length, 3);
  assert.equal(manifest.artifacts.find(a => a.logicalPath === '中文 file.txt')?.gitMode, '100755');
  const attemptRoot = join(f.dataDir, 'git-attempt');
  await prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot });
  assert.deepEqual(await readFile(join(attemptRoot, 'finals', 'binary.dat')), f.bytes);
  assert.equal(await readFile(join(attemptRoot, 'finals', '中文 file.txt'), 'utf8'), 'committed');
  assert.equal((await run('status', '--porcelain=v1')).stdout, before);
  assert.equal((await run('rev-parse', 'HEAD')).stdout.trim(), commit);
  assert.ok(result.manifestHash);
  await assert.rejects(captureGitTree(repo, 'HEAD'), /full lowercase/);
  await assert.rejects(captureGitTree(repo, 'f'.repeat(40)), /locally/);
  const blob = (await run('rev-parse', 'HEAD:binary.dat')).stdout.trim();
  await assert.rejects(captureGitTree(repo, blob), /not a commit/);
  await writeFile(join(repo, 'asset.lfs'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64));
  await run('add', '.'); await run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'lfs');
  await assert.rejects(captureGitTree(repo, (await run('rev-parse', 'HEAD')).stdout.trim()), /LFS pointer/);
  await run('rm', '-r', '--cached', '.');
  await run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'empty tree');
  const emptyCommit = (await run('rev-parse', 'HEAD')).stdout.trim();
  const empty = await captureHistoricalDelivery({ ...f.input, source: { kind: 'git_snapshot', repository: repo, commit: emptyCommit } });
  const emptyPrepared = await prepareHistoricalArtifacts({ caseDir: f.caseDir, taskCase: f.task, attemptRoot: join(f.dataDir, 'empty-tree') });
  assert.equal(emptyPrepared.manifest?.schemaVersion, 2);
  assert.equal(emptyPrepared.manifest?.artifacts.length, 0);
  assert.equal((await selectedHistoricalDelivery(f.caseDir, f.task))!.manifest.selectionId, empty.selectionId);
});

test('repository source inventories keep the legacy shell bounded without hiding candidate leads or changing older projections', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ side: 'baseline' as const, origin: 'git_snapshot' as const,
    inspectPath: `finals/file-${i}.ts`, reportHref: `finals/file-${i}.ts`, shortRef: `ev-${i + 1}` }));
  const candidate = { side: 'candidate' as const, origin: 'candidate_delivery' as const, inspectPath: 'candidate/changed.ts', reportHref: 'candidate/changed.ts' };
  const facts = context().reportFacts;
  const html = renderComparisonReportShell({ task: 'Compare code', facts, metrics: {}, evidence: [...entries, candidate] });
  assert.equal((html.match(/data-component="path-link"/g) ?? []).length, 33);
  assert.match(html, /candidate\/changed\.ts/);
  assert.doesNotMatch(html, /finals\/file-199\.ts/);
  const old = renderComparisonReportShell({ task: 'Compare files', facts, metrics: {}, evidence: entries.map(entry => ({ ...entry, origin: 'historical_artifact' as const })) });
  assert.equal((old.match(/data-component="path-link"/g) ?? []).length, 200);
});
