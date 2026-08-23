import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findProductPack, productPacks, defaultSessionsRoots } from '../products/index.js';
import { CodexIntakeTui } from '../tui/intake-app.js';
import { createCodexTuiWorkflow } from '../application/tui-workflow.js';

const MIN_NODE = [22, 19, 0] as const;
const commandOptions = {
  'data-dir': { type: 'string' },
  'sessions-dir': { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type CommandValues = {
  readonly 'data-dir'?: string;
  readonly 'sessions-dir'?: string[];
  readonly help?: boolean;
  readonly version?: boolean;
};

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliContext {
  readonly now?: string;
  readonly runTui?: (input: { dataDir: string; sessionsRoot: string; sessionsRoots: Readonly<Record<string, string>>; now?: string }) => Promise<void>;
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
    '  reprise [--data-dir <dir>] [--sessions-dir <productId>=<path>]',
    '  reprise [--help] [--version]',
    '',
    'Options:',
    '  -h, --help       Show this help message',
    '  -v, --version    Show the installed Reprise and Node.js versions',
    '  --data-dir       Use this local data directory (default: REPRISE_DATA_DIR or .reprise)',
    '  --sessions-dir   Repeatable <productId>=<path>. A bare path still sets the default product sessions root.',
  ].join('\n');
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
    const sessionsRoots = parseSessionsDirs(values['sessions-dir']);
    const sessionsRoot = '';
    await (context.runTui ?? runBenchmarkWorkbenchTui)({
      dataDir,
      sessionsRoot,
      sessionsRoots,
      ...(context.now ? { now: context.now } : {}),
    });
    io.stdout('TUI closed.');
    return 0;
  } catch (error: unknown) {
    io.stderr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

export function parseSessionsDirs(values: readonly string[] | undefined): Record<string, string> {
  const roots = defaultSessionsRoots();
  for (const value of values ?? []) {
    const eq = value.indexOf('=');
    if (eq > 0) {
      const productId = value.slice(0, eq);
      const path = value.slice(eq + 1);
      if (!productId.trim() || !path.trim()) throw new Error(`Invalid --sessions-dir ${value}. Use <productId>=<path>.`);
      findProductPack(productId);
      roots[productId] = path;
      continue;
    }
    const fallback = productPacks[0]?.manifest.productId;
    if (!fallback) throw new Error('No product packs are registered.');
    roots[fallback] = value;
  }
  return roots;
}

async function runBenchmarkWorkbenchTui(input: { dataDir: string; sessionsRoot: string; sessionsRoots: Readonly<Record<string, string>>; now?: string }): Promise<void> {
  const dataDir = resolve(input.dataDir);
  await new CodexIntakeTui({
    dataDir,
    sessionsRoot: input.sessionsRoot,
    sessionsRoots: input.sessionsRoots,
    workflow: createCodexTuiWorkflow({ dataDir, now: input.now ? () => input.now! : () => new Date().toISOString() }),
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    now: input.now ? () => input.now! : () => new Date().toISOString(),
  }).run();
}

function parseCommandArgs(args: readonly string[]): CommandValues {
  return parseArgs({ args: [...args], options: commandOptions, allowPositionals: false, strict: true }).values;
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
