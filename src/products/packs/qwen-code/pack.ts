import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CandidateSpec } from '../../../core/schema.js';
import { createAcpPack, type AcpPackDefinition } from '../../shared/acp/pack.js';

const DATA_ROOT = join(homedir(), '.qwen');

/** Follows the model this machine's `~/.qwen/settings.json` selects; ACP exposes no model listing. */
const DEFAULT_CANDIDATE: CandidateSpec = {
  candidateId: 'qwen-code-default',
  productId: 'qwen-code',
  requestedModel: 'deepseek/deepseek-v4.1-flash',
};

export const qwenCodePackDefinition: AcpPackDefinition = {
  productId: 'qwen-code',
  displayName: 'Qwen Code',
  command: 'qwen',
  executableEnvKey: 'REPRISE_QWEN_EXECUTABLE',
  // `--acp` is a boolean flag that starts the ACP agent on stdio, not a subcommand; `qwen serve`
  // is a separate experimental HTTP server and never this pack's control plane.
  acpArgs: ['--acp'],
  installHint: 'Install Qwen Code and ensure `qwen` is on PATH, or set REPRISE_QWEN_EXECUTABLE. Reprise does not install it.',
  envRole: 'acp',
  packVersion: '0.1.0',
  playbookVersion: 'qwen-code-recovery/v1',
  playbookUrl: new URL('./recovery/SKILL.md', import.meta.url),
  defaultCandidate: DEFAULT_CANDIDATE,
  dataRoot: DATA_ROOT,
  authFiles: [join(DATA_ROOT, 'settings.json')],
};

export const qwenCodeProductPack = createAcpPack(qwenCodePackDefinition);
