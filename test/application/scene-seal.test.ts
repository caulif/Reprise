import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistTaskCase } from '../../src/application/experiment-helpers.js';
import { comparisonCandidateMount } from '../../src/application/experiment-report.js';
import { LocalWorkspaceProvider } from '../../src/environment/local-workspace-provider.js';
import { listPublishedFrozenCases } from '../../src/products/shared/freeze.js';
import { readLocalHistory } from '../../src/tui/local-history.js';
import type { TaskCase } from '../../src/core/schema.js';

function taskCase(caseId: string): TaskCase {
  return {
    schemaVersion: 1,
    caseId,
    source: { productId: 'codex', sessionId: 'session-1' },
    initialInput: { id: 'message-1', role: 'user', text: 'Do the task.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Do the task.' }],
    historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    provenance: { packVersion: '1', importedAt: '2026-09-08T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: 'b'.repeat(64),
  };
}

test('sealed baseline refuses a fingerprint mismatch or missing files after the source is gone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-mismatch-'));
  const source = await mkdtemp(join(tmpdir(), 'reprise-seal-src-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, 'input.txt'), 'original');
  const provider = new LocalWorkspaceProvider(root);
  await provider.resolveBaseline({ caseId: 'case-seal', sourceRoot: source }, [], {});
  await writeFile(join(root, 'baselines', 'case-seal', 'input.txt'), 'tampered');
  await rm(source, { recursive: true, force: true });
  await assert.rejects(
    provider.resolveBaseline({ caseId: 'case-seal', sourceRoot: source }, [], {}),
    /does not match its published fingerprint/,
  );
});

test('missing sealed baseline without a live source is unsupported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-missing-'));
  const source = join(root, 'gone-source');
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new LocalWorkspaceProvider(root);
  const baseline = await provider.resolveBaseline({ caseId: 'case-missing', sourceRoot: source }, [], {});
  assert.equal(baseline.mode, 'unsupported');
});

test('candidate snapshot is sealed complete and is not the live run directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-snap-'));
  const source = await mkdtemp(join(tmpdir(), 'reprise-snap-src-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, 'input.txt'), 'original');
  const provider = new LocalWorkspaceProvider(root);
  const baseline = await provider.resolveBaseline({ caseId: 'case-snap', sourceRoot: source }, [], {});
  const environment = await provider.prepareRun(baseline, 'run-snap');
  await writeFile(join(environment.root, 'input.txt'), 'after-run');
  const sealed = await provider.sealCandidateSnapshot(environment);
  assert.equal(sealed.status, 'complete');
  assert.equal(await readFile(join(sealed.root, 'input.txt'), 'utf8'), 'after-run');
  await writeFile(join(environment.root, 'input.txt'), 'later-live-mutation');
  assert.equal(await readFile(join(sealed.root, 'input.txt'), 'utf8'), 'after-run');
  const recorded = await provider.candidateSnapshot('run-snap');
  assert.equal(recorded.status, 'complete');
  assert.notEqual(sealed.root, environment.root);
});

test('incomplete freeze dirs are omitted from published case lists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-cases-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const published = join(root, 'case-published');
  const incomplete = join(root, 'case-incomplete');
  const staging = join(root, '.case-published.staging-1');
  await mkdir(published, { recursive: true });
  await mkdir(incomplete, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(published, 'case.json'), JSON.stringify(taskCase('case-published')));
  await writeFile(join(published, 'case.complete'), '');
  await writeFile(join(incomplete, 'case.json'), JSON.stringify(taskCase('case-incomplete')));
  await writeFile(join(staging, 'case.json'), JSON.stringify(taskCase('case-published')));
  assert.deepEqual(await listPublishedFrozenCases(root), ['case-published']);
  const listedRoot = await mkdtemp(join(tmpdir(), 'reprise-history-cases-'));
  t.after(() => rm(listedRoot, { recursive: true, force: true }));
  await mkdir(join(listedRoot, 'cases', 'case-published'), { recursive: true });
  await writeFile(join(listedRoot, 'cases', 'case-published', 'case.json'), JSON.stringify(taskCase('case-published')));
  await writeFile(join(listedRoot, 'cases', 'case-published', 'case.complete'), '');
  await mkdir(join(listedRoot, 'cases', 'case-incomplete'), { recursive: true });
  await writeFile(join(listedRoot, 'cases', 'case-incomplete', 'case.json'), JSON.stringify(taskCase('case-incomplete')));
  const historyListed = await readLocalHistory(listedRoot);
  assert.deepEqual(historyListed.cases.map((item) => item.taskCase.caseId), ['case-published']);
});

test('persistTaskCase refuses an unpublished incomplete freeze', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-persist-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caseDir = join(root, 'case-half');
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'case.json'), JSON.stringify(taskCase('case-half')));
  await assert.rejects(
    persistTaskCase(join(caseDir, 'case.json'), taskCase('case-half')),
    /unpublished incomplete freeze/,
  );
});

test('comparison does not mount the live run directory when the snapshot is incomplete', () => {
  const live = join('C:', 'experiments', 'exp', 'environment', 'runs', 'run-1');
  const sealed = join('C:', 'experiments', 'exp', 'environment', 'snapshots', 'run-1');
  const attempt = join('C:', 'experiments', 'exp', 'comparison-attempts', 'attempt-1');
  const mount = comparisonCandidateMount({
    candidateSnapshotStatus: 'incomplete',
    candidateSnapshotRoot: sealed,
    attemptRoot: attempt,
  });
  assert.equal(mount, join(attempt, 'candidate-snapshot-unavailable'));
  assert.notEqual(mount, live);
  assert.equal(
    comparisonCandidateMount({
      candidateSnapshotStatus: 'complete',
      candidateSnapshotRoot: sealed,
      attemptRoot: attempt,
    }),
    sealed,
  );
});
