import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SAFE_ID, sha256 } from '../core/identity.js';
import { sameFsPath } from '../core/paths.js';

function compactRecoveryExperimentRoot(experimentRoot: string): string {
  return join(dirname(dirname(experimentRoot)), 'r', sha256(basename(experimentRoot)).slice(0, 32));
}

export function compactRecoveryProviderRoot(experimentRoot: string, runId: string): string {
  return join(compactRecoveryExperimentRoot(experimentRoot), sha256(runId).slice(0, 32));
}

/** Accepts Host-owned Provider layouts within this experiment and candidate run. */
export function replicaWorkspaceLocation(experimentRoot: string, runId: string, workspaceRoot: string): { providerRoot: string; workspaceRoot: string } | undefined {
  if (!SAFE_ID.test(runId)) return undefined;
  const environmentRoot = resolve(experimentRoot, 'environment');
  const workspacePath = resolve(workspaceRoot);
  if (sameFsPath(workspacePath, join(environmentRoot, 'runs', runId))) {
    return { providerRoot: environmentRoot, workspaceRoot: workspacePath };
  }
  const compactRoot = compactRecoveryExperimentRoot(resolve(experimentRoot));
  const compactParts = relative(compactRoot, workspacePath).split(sep);
  if (compactParts.length === 3 && /^[a-f0-9]{32}$/.test(compactParts[0] ?? '') && compactParts[1] === 'runs' && compactParts[2] === runId)
    return { providerRoot: join(compactRoot, compactParts[0]!), workspaceRoot: workspacePath };
  const parts = relative(join(environmentRoot, 'recovery'), workspacePath).split(sep);
  if (parts.length !== 3 || !SAFE_ID.test(parts[0] ?? '') || parts[1] !== 'runs' || parts[2] !== runId) return undefined;
  return { providerRoot: join(environmentRoot, 'recovery', parts[0]!), workspaceRoot: workspacePath };
}
