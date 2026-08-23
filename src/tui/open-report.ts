import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, type SpawnOptions } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ReportProcess = {
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'spawn', listener: () => void): void;
  unref(): void;
};

export type ReportSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReportProcess;

/** Opens a local filesystem path with the operating system's default handler. */
async function openLocalPath(
  target: string,
  start: ReportSpawner = spawn,
): Promise<void> {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = start(command, [target], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    child.once('error', rejectOpen);
    child.once('spawn', resolveOpen);
  });
}

/** Opens only the HTML report produced at the root of one local experiment. */
export async function openExperimentReport(
  experimentRoot: string,
  reportPath: string,
  start: ReportSpawner = spawn,
): Promise<void> {
  assertExperimentReportPath(experimentRoot, reportPath);
  await openLocalPath(reportPath, start);
}

export async function openExperimentTrace(
  experimentRoot: string,
  runId: string,
  start: ReportSpawner = spawn,
): Promise<void> {
  await openLocalPath(assertExperimentTracePath(experimentRoot, runId), start);
}

export async function openAllowedLocalPath(
  allowedRoot: string,
  target: string,
  start: ReportSpawner = spawn,
): Promise<void> {
  await openLocalPath(assertPathInsideRoot(allowedRoot, target), start);
}

export async function openAllowedFileUrl(
  allowedRoot: string,
  url: string,
  start: ReportSpawner = spawn,
): Promise<void> {
  await openAllowedLocalPath(allowedRoot, localPathFromFileUrl(url), start);
}

/** Writes the selected event's full text inside the data directory, then opens it. */
export async function openScratchText(
  dataDir: string,
  contents: string,
  start: ReportSpawner = spawn,
): Promise<string> {
  const target = join(resolve(dataDir), 'scratch', 'selected-detail.txt');
  assertPathInsideRoot(dataDir, target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  await openLocalPath(target, start);
  return target;
}

export function assertExperimentReportPath(experimentRoot: string, reportPath: string): void {
  const root = resolve(experimentRoot);
  const allowed = new Set(['report.html', 'comparison-failure.html'].map((name) => resolve(root, name)));
  if (!allowed.has(resolve(reportPath))) throw new Error('Report path must be report.html or comparison-failure.html in the selected experiment directory.');
}

export function assertExperimentTracePath(experimentRoot: string, runId: string): string {
  if (!runId.trim() || runId === '.' || /[\\/]/.test(runId) || runId.includes('..')) {
    throw new Error('Trace path must be a run directory inside the selected experiment.');
  }
  const runsRoot = resolve(experimentRoot, 'runs');
  const expected = assertPathInsideRoot(runsRoot, resolve(runsRoot, runId));
  if (expected === resolve(runsRoot)) throw new Error('Trace path must be a run directory inside the selected experiment.');
  return expected;
}

export function assertPathInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside the local Reprise data directory.');
  return resolvedTarget;
}

export function localPathFromFileUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Link is not a valid local file URL.');
  }
  if (parsed.protocol !== 'file:') throw new Error('Only local files can be opened from this screen.');
  if (parsed.hostname && parsed.hostname !== 'localhost') throw new Error('Only local files can be opened from this screen.');
  return fileURLToPath(parsed);
}
