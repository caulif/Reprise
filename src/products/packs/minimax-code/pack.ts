import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CandidateSpec } from '../../../core/schema.js';
import { createAcpPack, type AcpPackDefinition } from '../../shared/acp/pack.js';

const PLAYBOOK_VERSION = 'minimax-code-recovery/v1';
/**
 * `mcode` lists no models and ACP never carries one, so this id only labels the candidate: it is the
 * model the built-in `minimax` provider ships as its default, while the agent resolves `defaultModel`
 * from its own `config.yaml`.
 */
const DEFAULT_CANDIDATE: CandidateSpec = {
  candidateId: 'minimax-code-default',
  productId: 'minimax-code',
  requestedModel: 'minimax/MiniMax-M3.1-Flash',
};

export const minimaxCodeDefinition: AcpPackDefinition = {
  productId: 'minimax-code',
  displayName: 'MiniMax Code',
  command: 'mcode',
  executableEnvKey: 'REPRISE_MCODE_EXECUTABLE',
  acpArgs: ['acp'],
  installHint: 'Install MiniMax Code (`npm install -g @minimax-ai/code`) so `mcode` is on PATH, or set REPRISE_MCODE_EXECUTABLE to its full path.',
  envRole: 'acp',
  packVersion: '0.1.0',
  playbookVersion: PLAYBOOK_VERSION,
  playbookUrl: new URL('./recovery/SKILL.md', import.meta.url),
  defaultCandidate: DEFAULT_CANDIDATE,
  // `mcode` keeps its state in `~/.minimax`, not `~/.mcode`; MINIMAX_DATA_DIR overrides it at launch.
  dataRoot: join(homedir(), '.minimax'),
  authFiles: [join(homedir(), '.minimax', 'config.yaml')],
};

export const minimaxCodeProductPack = createAcpPack(minimaxCodeDefinition);
