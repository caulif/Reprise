import { join, resolve } from 'node:path';
/** Versioned environment selection. Values stay in memory; records contain names only. */
export const PROCESS_ENVIRONMENT_RULE = 'trusted-local-v1';
const BASE = new Set(('TEMP TMP TMPDIR PATH PATHEXT OS COMPUTERNAME SYSTEMROOT WINDIR COMSPEC LANG LC_ALL LC_CTYPE TERM USER USERNAME HOME HOMEDRIVE HOMEPATH USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 SYSTEMDRIVE NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE').split(' '));
const CONNECTION = new Set(('HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS').split(' '));
export type ProcessEnvironmentRole = 'codex' | 'codex-service' | 'claude' | 'host-shell';
const HOST_MOUNTS = new Set(['REPRISE_SOURCE_MOUNT', 'REPRISE_BASELINE_ROOT', 'REPRISE_FINALS_ROOT', 'REPRISE_CANDIDATE_ROOT', 'REPRISE_EVIDENCE_ROOT', 'REPRISE_SCRATCH_ROOT']);

export function hostShellOverrides(overrides: Readonly<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(overrides)) {
    const key = name.toUpperCase();
    if (!HOST_MOUNTS.has(key)) throw new Error(`Unsupported Host shell environment override: ${key}`);
    if (value?.includes('\0')) throw new Error('Invalid Host shell environment configuration.');
    result[key] = value;
  }
  return result;
}

export function hostShellEnvironment(home: string): NodeJS.ProcessEnv {
  const env = selectedProcessEnvironment('host-shell');
  const root = env.SYSTEMROOT ?? env.WINDIR;
  if (root) {
    env.SYSTEMROOT ??= root;
    env.WINDIR ??= root;
    env.COMSPEC ??= join(root, 'System32', 'cmd.exe');
  }
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR']) env[key] = home;
  env.GIT_CONFIG_GLOBAL = resolve(home, 'gitconfig');
  env.GIT_CONFIG_SYSTEM = resolve(home, 'missing-system-gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}
const PRODUCT: Record<ProcessEnvironmentRole, ReadonlySet<string>> = {
  codex: new Set(['CODEX_HOME', 'OPENAI_BASE_URL']),
  'codex-service': new Set(['CODEX_HOME', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']),
  claude: new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
  'host-shell': new Set(),
};

export function selectedProcessEnvironment(
  role: ProcessEnvironmentRole,
  overrides: Readonly<NodeJS.ProcessEnv> = {},
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (BASE.has(name) || (role !== 'host-shell' && (CONNECTION.has(name) || PRODUCT[role].has(name)))) result[name] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const name = key.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_()]*$/.test(name) || value?.includes('\0')) throw new Error('Invalid child environment configuration.');
    // Explicit local overrides retain their legacy semantics, except injection and Git bypasses.
    if (/^(?:GITHUB_TOKEN|GH_TOKEN|GIT_.*|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|DOTNET_STARTUP_HOOKS|ELECTRON_RUN_AS_NODE)$/i.test(name)) {
      if (value !== undefined) throw new Error(`Unsupported child environment override: ${name}`);
      delete result[name];
    } else if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}
