import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RunRecordSchema, type ComparisonLinkRecord } from '../core/schema.js';
import { SAFE_ID } from '../core/identity.js';
import { pathContainedBy } from '../core/paths.js';
import { comparisonAttemptMounts } from './comparison-briefing.js';
import { replicaWorkspaceLocation } from './result-paths.js';
import { isMissing } from './experiment-helpers.js';
import { createComparisonQuoteSourcePort, type ComparisonQuoteSourcePort } from './comparison-source.js';

export function recoveryComparisonQuoteSources(input: {
  experimentRoot: string; attemptRoot: string; runId: string;
  evidence: readonly ComparisonLinkRecord[]; allowModelText: boolean;
}): ComparisonQuoteSourcePort {
  return { resolveTextSource: async sourceRef => {
    if (!input.allowModelText || !SAFE_ID.test(input.runId)) return undefined;
    const link = input.evidence.find(item => item.shortRef === sourceRef);
    if (!link) return undefined;
    let candidateSnapshotRoot = join(input.attemptRoot, 'candidate-snapshot-unavailable');
    let candidateSnapshotStatus: 'complete' | 'missing' = 'missing';
    if (link.inspectPath.replaceAll('\\', '/').startsWith('candidate/')) {
      const record = await readRecoveryRecord(input.experimentRoot, input.runId);
      const location = record?.manifest?.environment.workspacePath
        ? replicaWorkspaceLocation(input.experimentRoot, input.runId, record.manifest.environment.workspacePath) : undefined;
      if (!location) return undefined;
      candidateSnapshotRoot = join(location.providerRoot, 'snapshots', input.runId);
      try {
        if (!(await stat(`${candidateSnapshotRoot}.complete`)).isFile()) return undefined;
      } catch (error) { if (isMissing(error)) return undefined; throw error; }
      candidateSnapshotStatus = 'complete';
    }
    const mounts = comparisonAttemptMounts({ ...input, candidateSnapshotRoot, candidateSnapshotStatus });
    const prefix = link.inspectPath.replaceAll('\\', '/').split('/')[0] ?? '';
    const mount = prefix === 'media' || prefix === 'review' ? join(input.attemptRoot, prefix) : mounts[prefix as keyof typeof mounts];
    if (!mount) return undefined;
    try {
      if (!pathContainedBy(await realpath(input.experimentRoot), await realpath(mount))) return undefined;
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
    return createComparisonQuoteSourcePort({ evidence: () => input.evidence, attemptRoot: input.attemptRoot,
      mounts, allowModelText: input.allowModelText }).resolveTextSource(sourceRef);
  } };
}

async function readRecoveryRecord(experimentRoot: string, runId: string) {
  let bytes: string;
  try {
    const path = await realpath(join(experimentRoot, 'runs', runId, 'record.json'));
    if (!pathContainedBy(await realpath(experimentRoot), path)) return undefined;
    bytes = await readFile(path, 'utf8');
  }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  const record: unknown = JSON.parse(bytes);
  if (!Value.Check(RunRecordSchema, record)) throw new Error('Recovery candidate record failed schema validation.');
  if (record.attempt.runId !== runId) throw new Error('Recovery candidate record belongs to another run.');
  return record;
}
