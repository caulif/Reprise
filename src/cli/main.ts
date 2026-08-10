import { parseArgs } from 'node:util';
import { compare, listCases, recordSmokeAcceptance, report, setup } from './commands.js';

const MIN_NODE = [22, 19, 0] as const;
const commandOptions = {
  'data-dir': { type: 'string' },
  fixture: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  case: { type: 'string' },
  product: { type: 'string' },
  experiment: { type: 'string' },
  record: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type CommandValues = {
  readonly 'data-dir'?: string;
  readonly fixture?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly case?: string;
  readonly product?: string;
  readonly experiment?: string;
  readonly record?: string;
  readonly help?: boolean;
};

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliContext {
  readonly now?: string;
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

  if (!supported) {
    throw new Error(`Reprise requires Node.js >= ${MIN_NODE.join('.')}; found ${version}.`);
  }
}

export function helpText(): string {
  return [
    'Reprise — local-first agent runtime harness',
    '',
    'Usage:',
    '  reprise setup [--data-dir <dir>] [--fixture <path>] [--provider <id>] [--model <id>]',
    '  reprise cases [--data-dir <dir>]',
    '  reprise compare --case <caseId> --model <id> [--product codex] [--data-dir <dir>]',
    '  reprise report --experiment <experimentId> [--data-dir <dir>]',
    '  reprise smoke-record --experiment <experimentId> --record <path> [--data-dir <dir>]',
    '  reprise [--help] [--version]',
    '',
    'Options:',
    '  -h, --help       Show this help message',
    '  -v, --version    Show the installed Reprise and Node.js versions',
    '  --data-dir       Use this local data directory (default: REPRISE_DATA_DIR or .reprise)',
  ].join('\n');
}

export function main(argv: readonly string[] = process.argv.slice(2), io: CliIo = defaultIo()): number {
  try {
    assertSupportedNodeVersion();
    const { values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
    });

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
    const [command, ...args] = argv;
    if (!command || command === '--help' || command === '-h') {
      io.stdout(helpText());
      return 0;
    }
    if (command === '--version' || command === '-v') {
      io.stdout(versionText());
      return 0;
    }

    const values = parseCommandArgs(args);
    if (values.help) {
      io.stdout(helpText());
      return 0;
    }
    const dataDir = values['data-dir'] ?? process.env.REPRISE_DATA_DIR ?? '.reprise';
    const now = context.now ?? new Date().toISOString();
    let output: string;
    switch (command) {
      case 'setup':
        output = await setup({ dataDir, providerId: values.provider ?? 'fixture', model: values.model ?? 'fixture-model', ...(values.fixture ? { fixture: values.fixture } : {}), now });
        break;
      case 'cases':
        output = await listCases(dataDir);
        break;
      case 'compare':
        output = await compare({ dataDir, caseId: required(values.case, 'case'), productId: values.product ?? 'codex', model: required(values.model, 'model'), now });
        break;
      case 'report':
        output = await report({ dataDir, experimentId: required(values.experiment, 'experiment') });
        break;
      case 'smoke-record':
        output = await recordSmokeAcceptance({ dataDir, experimentId: required(values.experiment, 'experiment'), recordPath: required(values.record, 'record') });
        break;
      default:
        throw new Error(`Unknown command: ${command}. Use --help for usage.`);
    }
    io.stdout(output);
    return 0;
  } catch (error: unknown) {
    io.stderr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

function parseCommandArgs(args: readonly string[]): CommandValues {
  const parsed = parseArgs({ args: [...args], options: commandOptions, allowPositionals: true, strict: true });
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}.`);
  return parsed.values as CommandValues;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`Missing required option: --${label}.`);
  return value;
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

if (import.meta.main) {
  process.exitCode = await runCli();
}
