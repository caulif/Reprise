import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionBoundary } from '../../core/schema.js';
import type { CandidateLaunchContext } from '../../core/schema.js';
import { selectedProcessEnvironment, PROCESS_ENVIRONMENT_RULE } from '../../infrastructure/process/environment.js';
import { isolateCandidateProcessEnv } from '../../infrastructure/process/spawn.js';

export function candidateExecutionPlan(role: 'codex' | 'claude', root: string, permissionMode: string, overrides?: Readonly<NodeJS.ProcessEnv>, requirements?: CandidateLaunchContext['executionRequirements'], customArgs = false, safeMode = false) {
  if (customArgs && role === 'claude') permissionMode = 'unknown';
  if (!['read-only', 'workspace-write', 'danger-full-access', 'bypassPermissions', 'unknown'].includes(permissionMode)) throw new Error('Unsupported native permission mode.');
  if (requirements?.filesystemIsolation || requirements?.disableExternalExtensions) throw new Error('Trusted-local execution cannot enforce the requested filesystem or extension isolation.');
  if (requirements?.nativePermissionMode && (permissionMode === 'unknown' || requirements.nativePermissionMode !== permissionMode)) throw new Error('Requested native permission mode conflicts with the configured launch.');
  const temporaryDirectory = join(tmpdir(), `reprise-candidate-${randomUUID()}`);
  const environment = Object.freeze(isolateCandidateProcessEnv({ ...selectedProcessEnvironment(role, overrides), TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory }, root));
  const record: ExecutionBoundary = {
    schemaVersion: 1, mode: 'trusted-local',
    environment: { source: 'host-configured', rule: PROCESS_ENVIRONMENT_RULE, names: Object.keys(environment).sort() },
    native: { source: 'pack-declared', permissionMode, confirmation: 'unknown' },
    hostShell: { source: 'host-configured', rule: 'host-shell-v1', filesystem: 'unrestricted', network: 'unrestricted' },
    filesystem: 'unknown', network: 'unknown', extensions: 'unknown',
    invocation: customArgs ? 'explicit-argv-override' : 'pack-default',
    controls: role === 'codex' ? ['approval-policy-never', 'persistent-session', 'thread-source-reprise'] : !customArgs ? ['strict-mcp-config', 'persistent-session', 'disallow-scheduling-and-messaging', ...(safeMode ? ['safe-mode-requested'] : [])] : [],
    limitations: [
      'Workspace copies and environment selection do not restrict disk reads or network access.',
      'Native login/configuration locations remain visible; Codex credentials are not read or copied by launch planning.',
      role === 'claude' && !customArgs ? 'Strict MCP configuration, disabled scheduling/messaging tools and candidate session persistence on; hooks, skills, agents, memory and other shared configuration are not fully controlled.' : 'Shared user/project configuration, MCP, hooks and skills are not disabled or verified.',
      'No automatic permission relaxation; a wide-permission Candidate can attempt its own alternative commands.',
      'Temporary directories are invocation-owned; real Runtime compatibility has not been verified.',
    ],
  };
  return { environment, record, temporaryDirectory };
}
