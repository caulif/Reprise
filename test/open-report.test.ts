import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  assertExperimentReportPath, assertExperimentTracePath, assertExperimentReplicaPath, assertPathInsideRoot,
  localPathFromFileUrl, openAllowedFileUrl, openExperimentReport, openExperimentTrace, openScratchText,
  type ReportSpawner,
} from '../src/tui/open-report.js';

const EXPERIMENT_ROOT = resolve('/data/experiments/one');
const REPORT_PATH = join(EXPERIMENT_ROOT, 'report.html');
const TRACE_PATH = join(EXPERIMENT_ROOT, 'runs', 'run-1');
const REPLICA_PATH = join(EXPERIMENT_ROOT, 'environment', 'runs', 'run-1');
const DATA_ROOT = resolve('/data');
const OTHER_ROOT = resolve('/other');

function reportProcess(): EventEmitter & { unref(): void } {
  return Object.assign(new EventEmitter(), { unref() {} });
}

function recordingSpawner(child: EventEmitter & { unref(): void }): {
  start: ReportSpawner;
  calls: { command: string; args: readonly string[]; options: Parameters<ReportSpawner>[2] }[];
} {
  const calls: { command: string; args: readonly string[]; options: Parameters<ReportSpawner>[2] }[] = [];
  const start: ReportSpawner = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { start, calls };
}

function expectedCommand(): string {
  return process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
}

test('report opener only accepts report.html directly inside the selected experiment', () => {
  assert.doesNotThrow(() => assertExperimentReportPath(EXPERIMENT_ROOT, REPORT_PATH));
  assert.throws(() => assertExperimentReportPath(EXPERIMENT_ROOT, join(EXPERIMENT_ROOT, 'runs', 'run', 'record.json')), /report\.html/);
  assert.throws(() => assertExperimentReportPath(EXPERIMENT_ROOT, join(resolve('/data/experiments/two'), 'report.html')), /report\.html/);
});

test('trace opener only accepts a run directory inside the selected experiment', () => {
  assert.equal(assertExperimentTracePath(EXPERIMENT_ROOT, 'run-1').replaceAll('\\', '/'), TRACE_PATH.replaceAll('\\', '/'));
  assert.throws(() => assertExperimentTracePath(EXPERIMENT_ROOT, '../secret'), /Trace path/);
  assert.throws(() => assertExperimentTracePath(EXPERIMENT_ROOT, 'run/nested'), /Trace path/);
});

test('replica opener only accepts the isolated run workspace inside the selected experiment', () => {
  assert.equal(assertExperimentReplicaPath(EXPERIMENT_ROOT, 'run-1').replaceAll('\\', '/'), REPLICA_PATH.replaceAll('\\', '/'));
  assert.throws(() => assertExperimentReplicaPath(EXPERIMENT_ROOT, '../secret'), /Replica path/);
  assert.throws(() => assertExperimentReplicaPath(EXPERIMENT_ROOT, 'run/nested'), /Replica path/);
});

test('local file URLs must stay inside the allowed data directory', () => {
  assert.doesNotThrow(() => assertPathInsideRoot(DATA_ROOT, REPORT_PATH));
  assert.throws(() => assertPathInsideRoot(DATA_ROOT, join(OTHER_ROOT, 'report.html')), /outside/);
  assert.throws(() => localPathFromFileUrl('https://example.com/report.html'), /local files/);
  assert.equal(localPathFromFileUrl(pathToFileURL(REPORT_PATH).href), REPORT_PATH);
});

test('report opener resolves after the operating system accepts the spawn request', async () => {
  const child = reportProcess();
  const { start, calls } = recordingSpawner(child);

  const opening = openExperimentReport(EXPERIMENT_ROOT, REPORT_PATH, start);
  const settledBeforeSpawn = await Promise.race([
    opening.then(() => true, () => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(settledBeforeSpawn, false);
  child.emit('spawn');
  await assert.doesNotReject(opening);
  assert.deepEqual(calls, [{ command: expectedCommand(), args: [REPORT_PATH], options: { detached: true, stdio: 'ignore', windowsHide: true } }]);
});

test('trace opener and file-url opener use the same local handler', async () => {
  const child = reportProcess();
  const { start, calls } = recordingSpawner(child);
  const opening = openExperimentTrace(EXPERIMENT_ROOT, 'run-1', start);
  child.emit('spawn');
  await assert.doesNotReject(opening);
  assert.equal(calls[0]?.command, expectedCommand());
  assert.equal(String(calls[0]?.args[0]).replaceAll('\\', '/'), TRACE_PATH.replaceAll('\\', '/'));

  const linked = reportProcess();
  const second = recordingSpawner(linked);
  const href = pathToFileURL(REPORT_PATH).href;
  const openingLink = openAllowedFileUrl(DATA_ROOT, href, second.start);
  linked.emit('spawn');
  await assert.doesNotReject(openingLink);
  await assert.rejects(openAllowedFileUrl(DATA_ROOT, 'https://example.com', second.start), /local files/);
  await assert.rejects(openAllowedFileUrl(DATA_ROOT, pathToFileURL(join(OTHER_ROOT, 'secret.txt')).href, second.start), /outside/);
});

test('report opener rejects when the operating system cannot start the opener', async () => {
  const child = reportProcess();
  const opening = openExperimentReport(EXPERIMENT_ROOT, REPORT_PATH, () => child);
  child.emit('error', new Error('opener unavailable'));
  await assert.rejects(opening, /opener unavailable/);
});

test('scratch opener writes selected output inside the data directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-scratch-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const child = reportProcess();
  const calls: { command: string; args: readonly string[] }[] = [];
  const start: ReportSpawner = (command, args) => {
    calls.push({ command, args });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const target = await openScratchText(root, 'full command output', start);
  assert.equal(await readFile(target, 'utf8'), 'full command output');
  assert.equal(relative(root, target).startsWith('..'), false);
  assert.equal(calls[0]?.args[0], target);
});
