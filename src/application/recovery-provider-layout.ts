import { basename, dirname, join } from 'node:path';
import { sha256 } from '../core/identity.js';

export function compactRecoveryExperimentRoot(experimentRoot: string): string {
  return join(dirname(dirname(experimentRoot)), 'r', sha256(basename(experimentRoot)).slice(0, 32));
}

export function compactRecoveryProviderRoot(experimentRoot: string, runId: string): string {
  return join(compactRecoveryExperimentRoot(experimentRoot), sha256(runId).slice(0, 32));
}
