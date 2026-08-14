import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { TaskCase } from '../core/schema.js';

const execFileAsync = promisify(execFile);

export type ContaminationSignals = {
  git?: { historicalCommit: string; currentHead: string; relation: 'same' | 'ancestor' | 'diverged' | 'missing' };
  timeline?: { sessionEndedAt: string; sourceLastModifiedAt: string };
  baselineArtifactsPresent?: string[];
};

/** Read-only preflight evidence that the selected directory may already include the historical task result. */
export async function detectContamination(sourceRoot: string, taskCase: TaskCase): Promise<ContaminationSignals> {
  const root = resolve(sourceRoot);
  const [git, timeline, baselineArtifactsPresent] = await Promise.all([
    gitSignal(root, historicalCommit(taskCase)), timelineSignal(root, taskCase), artifactSignals(root, taskCase),
  ]);
  return { ...(git ? { git } : {}), ...(timeline ? { timeline } : {}), ...(baselineArtifactsPresent.length ? { baselineArtifactsPresent } : {}) };
}

export function contaminationWarnings(signals: ContaminationSignals): string[] {
  const warnings: string[] = [];
  if (signals.git) {
    const relation = signals.git.relation;
    warnings.push(relation === 'same'
      ? 'The selected directory is at the historical commit; it may already contain the task result.'
      : relation === 'ancestor'
        ? 'The selected directory is ahead of the historical commit; the Candidate may directly see completed task changes.'
        : relation === 'diverged'
          ? 'The selected directory diverged from the historical commit; replay fidelity is uncertain.'
          : 'The historical commit is unavailable in the selected directory; current-state replay may expose task results.');
  }
  if (signals.timeline) warnings.push('The selected directory was modified after the historical session ended; it may contain the completed task result.');
  if (signals.baselineArtifactsPresent?.length) warnings.push(`Historical baseline artifacts are present in the selected directory: ${signals.baselineArtifactsPresent.join(', ')}.`);
  return warnings;
}

async function gitSignal(root: string, historicalCommit: string | undefined): Promise<ContaminationSignals['git'] | undefined> {
  if (!historicalCommit) return undefined;
  try {
    const currentHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await git(root, ['cat-file', '-e', `${historicalCommit}^{commit}`]);
    if (currentHead === historicalCommit) return { historicalCommit, currentHead, relation: 'same' };
    const ancestor = await succeeds(() => git(root, ['merge-base', '--is-ancestor', historicalCommit, currentHead]));
    return { historicalCommit, currentHead, relation: ancestor ? 'ancestor' : 'diverged' };
  } catch {
    try {
      const currentHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
      return { historicalCommit, currentHead, relation: 'missing' };
    } catch { return undefined; }
  }
}

async function timelineSignal(root: string, taskCase: TaskCase): Promise<ContaminationSignals['timeline'] | undefined> {
  const sessionEndedAt = latestHistoricalTime(taskCase);
  if (!sessionEndedAt) return undefined;
  const info = await stat(root);
  const sourceLastModifiedAt = info.mtime.toISOString();
  return Date.parse(sourceLastModifiedAt) > Date.parse(sessionEndedAt) ? { sessionEndedAt, sourceLastModifiedAt } : undefined;
}

async function artifactSignals(root: string, taskCase: TaskCase): Promise<string[]> {
  const artifactIds = taskCase.baseline.artifactRefs.map((artifact) => artifact.artifactId);
  const result: string[] = [];
  for (const artifactId of artifactIds) {
    try { await stat(resolve(root, artifactId)); result.push(artifactId); } catch { /* absence is expected */ }
  }
  return result;
}

function historicalCommit(taskCase: TaskCase): string | undefined {
  const value = taskCase.taskContext?.historicalCommit;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function latestHistoricalTime(taskCase: TaskCase): string | undefined {
  const values = taskCase.historicalEvents.flatMap((event) => typeof event.timestamp === 'string' ? [event.timestamp] : typeof event.time === 'string' ? [event.time] : []);
  return values.filter((value) => /^\d{4}-\d{2}-\d{2}T/.test(value)).sort().at(-1);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 });
  return stdout;
}
async function succeeds(action: () => Promise<unknown>): Promise<boolean> { try { await action(); return true; } catch { return false; } }
