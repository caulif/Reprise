import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CandidateSpec } from '../../../core/schema.js';
import type { ProductPack } from '../../contract.js';
import { createAcpPack, type AcpPackDefinition } from '../../shared/acp/pack.js';

/** Standalone installer home; sessions, config and the login token all live under it. */
const KIMI_HOME = join(homedir(), '.kimi-code');

/**
 * `kimi acp` is the only stdio ACP entry point. Kimi Code lists no models and ACP never carries
 * a model, so this id only labels the candidate: it is the coding model that kimi.exe 2.1.1
 * bundles in its models.dev catalog, while the agent resolves `default_model` from its own config.
 */
const DEFAULT_CANDIDATE: CandidateSpec = {
  candidateId: 'kimi-code-default',
  productId: 'kimi-code',
  requestedModel: 'kimi-k2.7-code',
};

export const kimiCodePackDefinition: AcpPackDefinition = {
  productId: 'kimi-code',
  displayName: 'Kimi Code',
  command: 'kimi',
  executableEnvKey: 'REPRISE_KIMI_EXECUTABLE',
  acpArgs: ['acp'],
  installHint: 'Install Kimi Code and ensure `kimi` is on PATH, or set REPRISE_KIMI_EXECUTABLE. Reprise does not install it.',
  envRole: 'acp',
  packVersion: '0.1.0',
  playbookVersion: 'kimi-code-recovery/v1',
  playbookUrl: new URL('./recovery/SKILL.md', import.meta.url),
  defaultCandidate: DEFAULT_CANDIDATE,
  dataRoot: KIMI_HOME,
  authFiles: [join(KIMI_HOME, 'server.token'), join(KIMI_HOME, 'config.toml')],
};

export const kimiCodeProductPack: ProductPack = createAcpPack(kimiCodePackDefinition);
