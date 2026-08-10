import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliIo } from '../src/cli/main.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-session.fixture.json', import.meta.url));

function ioCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) }, stdout, stderr };
}

test('CLI fixture path runs setup, cases, compare, and report without a provider', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-cli-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const context = { now: '2026-08-10T00:00:00.000Z' };

  const setupIo = ioCapture();
  assert.equal(await runCli(['setup', '--data-dir', dataDir, '--fixture', fixturePath], setupIo.io, context), 0);
  assert.match(setupIo.stdout.join('\n'), /Imported case case-/);

  const casesIo = ioCapture();
  assert.equal(await runCli(['cases', '--data-dir', dataDir], casesIo.io, context), 0);
  const caseId = casesIo.stdout[0]?.split('\t')[0];
  assert.match(caseId ?? '', /^case-[A-Za-z0-9]+$/);

  const compareIo = ioCapture();
  assert.equal(await runCli(['compare', '--data-dir', dataDir, '--case', caseId ?? '', '--model', 'fixture-model'], compareIo.io, context), 0);
  const experimentId = /Experiment: (experiment-[A-Za-z0-9]+)/.exec(compareIo.stdout.join('\n'))?.[1];
  assert.match(experimentId ?? '', /^experiment-[A-Za-z0-9]+$/);

  const reportIo = ioCapture();
  assert.equal(await runCli(['report', '--data-dir', dataDir, '--experiment', experimentId ?? ''], reportIo.io, context), 0);
  const html = await readFile(join(dataDir, 'experiments', experimentId ?? '', 'report.html'), 'utf8');
  assert.match(html, /Reprise comparison/);
  assert.match(await readFile(join(dataDir, 'experiments', experimentId ?? '', 'events.jsonl'), 'utf8'), /run.finished/);
});

test('CLI stores one immutable smoke acceptance record under its run', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-smoke-record-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const context = { now: '2026-08-10T00:00:00.000Z' };
  const setupIo = ioCapture();
  await runCli(['setup', '--data-dir', dataDir, '--fixture', fixturePath], setupIo.io, context);
  const casesIo = ioCapture();
  await runCli(['cases', '--data-dir', dataDir], casesIo.io, context);
  const caseId = casesIo.stdout[0]?.split('\t')[0] ?? '';
  const compareIo = ioCapture();
  await runCli(['compare', '--data-dir', dataDir, '--case', caseId, '--model', 'fixture-model'], compareIo.io, context);
  const output = compareIo.stdout.join('\n');
  const experimentId = /Experiment: (experiment-[A-Za-z0-9]+)/.exec(output)?.[1] ?? '';
  const runId = /Run: (run-[A-Za-z0-9]+)/.exec(output)?.[1] ?? '';
  const recordPath = join(dataDir, 'smoke-record.json');
  await writeFile(recordPath, `${JSON.stringify({
    schemaVersion: 1, status: 'passed', recordedAt: context.now, taskCaseId: caseId, experimentId, runId,
    executable: 'C:/tools/codex.cmd', version: '0.147.0', requestedModel: 'gpt-test', resolvedModel: 'gpt-test',
    fidelity: 'native', termination: 'completed', cleanup: 'released', reportPath: 'report.html',
    smokeSteps: { started: true, initialAdmission: true, firstTurnSettlement: true, followupSubmission: true, stopped: true },
    humanJudgment: { rawEvidence: 'checked', artifacts: 'checked', traceAndReport: 'checked', knownLimitations: '', conclusion: 'passed' },
  }, null, 2)}\n`, 'utf8');

  const recordIo = ioCapture();
  assert.equal(await runCli(['smoke-record', '--data-dir', dataDir, '--experiment', experimentId, '--record', recordPath], recordIo.io, context), 0);
  const savedPath = join(dataDir, 'experiments', experimentId, 'runs', runId, 'codex-smoke-acceptance.json');
  assert.match(recordIo.stdout.join('\n'), /Smoke acceptance record saved/);
  assert.match(await readFile(savedPath, 'utf8'), /"status":"passed"/);
  assert.equal(await runCli(['smoke-record', '--data-dir', dataDir, '--experiment', experimentId, '--record', recordPath], ioCapture().io, context), 1);
});

test('CLI reports missing arguments and unavailable fixture products', async () => {
  const missingIo = ioCapture();
  assert.equal(await runCli(['compare', '--case', 'case-1'], missingIo.io), 1);
  assert.match(missingIo.stderr.join('\n'), /Missing required option: --model/);

  const productIo = ioCapture();
  assert.equal(await runCli(['compare', '--case', 'case-1', '--model', 'fixture-model', '--product', 'claude'], productIo.io), 1);
  assert.match(productIo.stderr.join('\n'), /Product claude is unavailable/);
});
