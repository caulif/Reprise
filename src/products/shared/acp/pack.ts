import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256 } from '../../../core/identity.js';
import { PACK_API_MAJOR, type ProductAuthStatus, type ProductPack, type RecoveryPlaybookDescriptor } from '../../contract.js';
import { acpHistoryReader } from './history.js';
import { acpProjection } from './projection.js';
import { AcpProductRuntime, type AcpProductConfig, type AcpRuntimeOptions } from './runtime.js';

export type AcpPackDefinition = AcpProductConfig & {
  packVersion: string;
  /** Version string recorded with the recovery playbook so a changed text is visible. */
  playbookVersion: string;
  /** This pack's own `recovery/SKILL.md`, resolved from the pack module. */
  playbookUrl: URL;
  /** Local data root reported to discovery and recovery. */
  dataRoot: string;
  /**
   * Credential or configuration files that indicate a configured account. Presence is the only
   * local fact this pack can check without starting the agent, so it never claims more.
   */
  authFiles: readonly string[];
};

/**
 * ACP packs differ only in executable, argv, data locations and playbook text, so the shared
 * layer owns behaviour and each pack stays a declaration.
 */
export function createAcpPack(definition: AcpPackDefinition, options: AcpRuntimeOptions = {}): ProductPack {
  let playbook: RecoveryPlaybookDescriptor | undefined;
  return {
    runtime: new AcpProductRuntime(definition, options),
    history: acpHistoryReader({ displayName: definition.displayName, dataRoot: definition.dataRoot }),
    projection: acpProjection,
    recoveryPlaybook() {
      playbook ??= readPlaybook(definition);
      return playbook;
    },
    checkAuth: () => probeAuth(definition),
    defaultCandidate: () => definition.defaultCandidate,
    manifest: {
      productId: definition.productId,
      displayName: definition.displayName,
      packVersion: definition.packVersion,
      schemaVersion: 1,
      apiMajor: PACK_API_MAJOR,
      capabilities: ['runtime'],
    },
  };
}

function readPlaybook(definition: AcpPackDefinition): RecoveryPlaybookDescriptor {
  const text = readFileSync(definition.playbookUrl, 'utf8');
  return { version: definition.playbookVersion, sha256: sha256(text), text };
}

async function probeAuth(definition: AcpPackDefinition): Promise<ProductAuthStatus> {
  const found = definition.authFiles.find((file) => existsSync(file));
  if (found) return { configured: true, provider: definition.productId, source: basename(found), detail: 'local-configuration-present' };
  return {
    configured: false,
    provider: definition.productId,
    detail: `No local credential or configuration file found (${definition.authFiles.map((file) => basename(file)).join(', ')}). A configuration file is also not proof of a runnable account.`,
  };
}
