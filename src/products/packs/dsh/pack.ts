import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProductPack } from '../../contract.js';
import { createAcpPack, type AcpPackDefinition } from '../../shared/acp/pack.js';

/** Local data root is the user's default dsh home; sessions, profiles and credentials live there. */
const DSH_HOME = join(homedir(), '.dsh');

/**
 * `dsh --profile acp` is the only stdio ACP entry point, so the shared ACP layer owns behaviour.
 * The default model is dsh's own `agent-default-model` choice; a live `session/new` reported
 * `deepseek-v4-flash` under provider `deepseek-official`, and dsh resolves the real model itself.
 */
export const dshPackDefinition: AcpPackDefinition = {
  productId: 'dsh',
  displayName: 'DeepSeek Harness',
  command: 'dsh',
  executableEnvKey: 'REPRISE_DSH_EXECUTABLE',
  acpArgs: ['--profile', 'acp'],
  installHint: 'Install DeepSeek Harness and ensure dsh is on PATH, or set REPRISE_DSH_EXECUTABLE. Reprise does not install it.',
  envRole: 'acp',
  packVersion: '0.1.0',
  playbookVersion: 'dsh-recovery/v1',
  playbookUrl: new URL('./recovery/SKILL.md', import.meta.url),
  defaultCandidate: { candidateId: 'dsh-deepseek', productId: 'dsh', requestedModel: 'deepseek-v4-flash' },
  dataRoot: DSH_HOME,
  authFiles: [join(DSH_HOME, '.credentials.yaml')],
};

export const dshProductPack: ProductPack = createAcpPack(dshPackDefinition);
