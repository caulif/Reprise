import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodexRuntimePort } from '../products/codex/runtime-port.js';
import { CodexIntakeTui } from '../tui/codex-intake.js';
import { createCodexTuiWorkflow } from '../application/codex-tui-workflow.js';

const MIN_NODE = [22, 19, 0] as const;
const commandOptions = {
  'data-dir': { type: 'string' },
  'sessions-dir': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type CommandValues = {
  readonly 'data-dir'?: string;
  readonly 'sessions-dir'?: string;
  readonly help?: boolean;
  readonly version?: boolean;
};

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliContext {
  readonly now?: string;
  readonly runTui?: (input: { dataDir: string; sessionsRoot: string; now: string }) => Promise<void>;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const actual = version.split('.').map(Number);
  let supported = true;
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const minimum = MIN_NODE[index] ?? 0;
    const difference = (actual[index] ?? 0) - minimum;
    if (difference !== 0) {
      supported = difference > 0;
      break;
    }
  }

  if (!supported) throw new Error(`Reprise requires Node.js >= ${MIN_NODE.join('.')}; found ${version}.`);
}

export function helpText(): string {
  return [
    'Reprise — local-first agent runtime replay and inspection',
    '',
    'Usage:',
    '  reprise [--data-dir <dir>] [--sessions-dir <dir>]',
    '  reprise [--help] [--version]',
    '',
    'Options:',
    '  -h, --help       Show this help message',
    '  -v, --version    Show the installed Reprise and Node.js versions',
    '  --data-dir       Use this local data directory (default: REPRISE_DATA_DIR or .reprise)',
    '  --sessions-dir   Read Codex rollout JSONL files from this directory (default: CODEX_HOME/sessions)',
  ].join('\n');
}

export function main(argv: readonly string[] = process.argv.slice(2), io: CliIo = defaultIo()): number {
  try {
    assertSupportedNodeVersion();
    const values = parseCommandArgs(argv);
    if (values.version) {
      io.stdout(versionText());
      return 0;
    }
    io.stdout(helpText());
    return 0;
  } catch (error: unknown) {
    io.stderr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

export async function runCli(argv: readonly string[] = process.argv.slice(2), io: CliIo = defaultIo(), context: CliContext = {}): Promise<number> {
  try {
    assertSupportedNodeVersion();
    const values = parseCommandArgs(argv);
    if (values.help) {
      io.stdout(helpText());
      return 0;
    }
    if (values.version) {
      io.stdout(versionText());
      return 0;
    }
    const dataDir = values['data-dir'] ?? process.env.REPRISE_DATA_DIR ?? '.reprise';
    await (context.runTui ?? runBenchmarkWorkbenchTui)({
      dataDir,
      sessionsRoot: values['sessions-dir'] ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
      now: context.now ?? new Date().toISOString(),
    });
    io.stdout('TUI closed.');
    return 0;
  } catch (error: unknown) {
    io.stderr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

async function runBenchmarkWorkbenchTui(input: { dataDir: string; sessionsRoot: string; now: string }): Promise<void> {
  const dataDir = resolve(input.dataDir);
  const runtime = new CodexRuntimePort({ effort: 'high' });
  await new CodexIntakeTui({
    dataDir,
    sessionsRoot: input.sessionsRoot,
    workflow: createCodexTuiWorkflow({ dataDir, runtime, now: () => input.now }),
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => input.now,
  }).run();
}

function parseCommandArgs(args: readonly string[]): CommandValues {
  const parsed = parseArgs({ args: [...args], options: commandOptions, allowPositionals: false, strict: true });
  return parsed.values as CommandValues;
}

function defaultIo(): CliIo {
  return { stdout: console.log, stderr: console.error };
}

function versionText(): string {
  return `reprise ${process.env.npm_package_version ?? '0.1.0'} (Node.js ${process.versions.node})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exitCode = await runCli();
