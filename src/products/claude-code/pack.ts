import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../core/identity.js';
import type { CandidateSpec } from '../../core/schema.js';
import type { ProductAuthStatus, ProductPack, RecoveryPlaybookDescriptor } from '../contract.js';
import { claudeActivityTranslator } from './activity.js';
import { ClaudeCodeRuntimePort } from './runtime-port.js';
import { claudeSessionAdapter } from './sessions.js';

const PLAYBOOK_VERSION = 'claude-code-recovery/v1';
const DEFAULT_CANDIDATE: CandidateSpec = { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' };

function claudeRecoveryPlaybook(): RecoveryPlaybookDescriptor {
  const text = readFileSync(new URL('./recovery/SKILL.md', import.meta.url), 'utf8');
  return { version: PLAYBOOK_VERSION, sha256: sha256(text), text };
}

export async function checkClaudeAuth(port?: ClaudeCodeRuntimePort): Promise<ProductAuthStatus> {
  if (port) {
    try {
      const models = await port.listModels();
      if (models.length) return { configured: true, provider: 'claude-code', source: 'initialize', detail: 'catalog-listed' };
    } catch {
      /* injected ports are test or composition-root probes */
    }
  }
  const credentials = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credentials)) return { configured: true, provider: 'claude-code', source: '.credentials.json' };
  if (process.env.ANTHROPIC_API_KEY) return { configured: true, provider: 'claude-code', source: 'ANTHROPIC_API_KEY' };
  if (!port) {
    try {
      const models = await new ClaudeCodeRuntimePort().listModels();
      if (models.length) return { configured: true, provider: 'claude-code', source: 'initialize', detail: 'catalog-listed' };
    } catch {
      /* initialize is a runtime fact; absence of a catalog is not a credential leak. */
    }
  }
  return { configured: false, provider: 'claude-code', detail: 'No initialize account, credentials file, or ANTHROPIC_API_KEY. Catalog listing is not the same as a runnable account.' };
}

export const claudeCodeProductPack: ProductPack = {
  runtime: new ClaudeCodeRuntimePort(),
  sessions: claudeSessionAdapter,
  activity: claudeActivityTranslator,
  recoveryPlaybook: claudeRecoveryPlaybook,
  checkAuth: checkClaudeAuth,
  defaultCandidate: () => DEFAULT_CANDIDATE,
  manifest: {
    productId: 'claude-code',
    displayName: 'Claude Code',
    packVersion: '0.1.0',
    schemaVersion: 1,
    sessionSchemaVersions: ['claude-code-session-jsonl/v1'],
  },
};
