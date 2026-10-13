import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverExperiment } from '../../src/application/recovery/recover.js';
import { input, now, VerifiedRuntime } from '../codex-experiment-support.js';
import { LocalWorkspaceProvider } from '../../src/environment/local-workspace-provider.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('external Recovery artifacts preserve original same-name input files through Candidate preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-original-report-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(join(base.sourceRoot, '.reprise', 'recovery-work'), { recursive: true });
  const originals = { 'recovery.md': '# Original task input\n', '.reprise/recovery-work/input.txt': 'original user data\n' };
  for (const [path, text] of Object.entries(originals)) await writeFile(join(base.sourceRoot, path), text);
  const attempt = await recoverExperiment({ ...base, now, recovery: { recover: async () => ({ status: 'completed', sessionId: 'original-input', value: { status: 'ready', summary: 'Original inputs remain available.', unresolved: [] } }) } });
  assert.equal(attempt.acceptedAutomatically, true);
  const candidate = await attempt.provider.prepareRun(attempt.baseline, 'candidate-original-input');
  for (const [path, text] of Object.entries(originals)) {
    assert.equal(await readFile(join(attempt.baseline.root!, path), 'utf8'), text);
    assert.equal(await readFile(join(candidate.root, path), 'utf8'), text);
    assert.equal(await readFile(join(base.sourceRoot, path), 'utf8'), text);
  }
  const report = await readFile(join(attempt.experimentRoot, 'runs', base.runId, 'artifacts', 'recovery-md'), 'utf8');
  assert.match(report, /Original inputs remain available/);
  assert.match(report, /Agent judgment \(before Host sealing\)/);
  assert.match(report, /Host validation \(after Agent judgment\)/);
  assert.match(report, /Additional path checks: 0; command checks: 0/);
  assert.match(report, /full original-task execution.*not established/);
});

test('a failing finalization is not invoked a second time after the decision completed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-finalization-once-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'input.txt'), 'original');
  const provider = new LocalWorkspaceProvider(join(root, 'provider')); let finalizations = 0;
  provider.validateRecovery = async () => { finalizations++; throw new Error('finalization deliberately failed'); };
  const attempt = await recoverExperiment({ ...base, now, environmentProvider: provider, recovery: { recover: async () => ({ status: 'completed', sessionId: 'finalization-once', value: { status: 'ready', summary: 'Original input is ready.', unresolved: [] } }) } });
  assert.equal(finalizations, 1);
  assert.equal(attempt.acceptedAutomatically, undefined);
  assert.equal(attempt.baseline.recovery?.failureStage, 'runner_crashed');
  assert.equal(await readFile(join(base.sourceRoot, 'input.txt'), 'utf8'), 'original');
});

test('ready boundary with mismatched HEAD or unknown evidence cannot bypass the mechanical gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-boundary-reverse-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const exec = promisify(execFile);
  for (const kind of ['head', 'reference']) await t.test(kind === 'head' ? 'mismatched HEAD is rejected' : 'unknown original evidence is rejected', async () => {
    const base = input(join(root, kind), new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true });
    const git = async (...args: string[]) => (await exec('git', ['-C', base.sourceRoot, ...args], { windowsHide: true })).stdout.trim();
    await git('init', '--template='); await writeFile(join(base.sourceRoot, 'input.txt'), 'original'); await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'before');
    const head = await git('rev-parse', 'HEAD'); let calls = 0; const feedback: string[] = [];
    const attempt = await recoverExperiment({ ...base, now, recovery: { recover: async context => {
      calls++;
      if (context.mechanicalFeedback) feedback.push(context.mechanicalFeedback.facts);
      return { status: 'completed', sessionId: 'boundary-' + kind, value: { status: 'ready', summary: 'The original input is ready.', unresolved: [], boundary: { commit: kind === 'head' ? 'a'.repeat(40) : head, evidenceRefs: [kind === 'head' ? base.taskCase.initialInput.id : 'observations/no-such-original-evidence.json'], statement: 'Original evidence establishes the starting point.' } } };
    } } });
    assert.equal(calls, 2, kind);
    assert.equal(attempt.acceptedAutomatically, undefined, kind);
    assert.equal(typeof attempt.accept, 'undefined', kind);
    assert.notEqual(attempt.baseline.recovery?.status, 'ready', kind);
    assert.equal(attempt.baseline.recovery?.failureStage, 'provider_validation_failed');
    assert.match(feedback.join(' '), kind === 'head' ? /Boundary commit differs/ : /Boundary evidence file is unavailable/);
  });
});
