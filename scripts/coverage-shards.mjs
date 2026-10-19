import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { coverageArguments, runGuardedTests } from './test-coverage.mjs';
import { planShards } from './coverage-plan.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Manifest = Type.Object({
  version: Type.Literal(1), revision: Type.String(), node: Type.String(), workspace: Type.String(), digest: Digest,
  index: Type.Integer({ minimum: 1 }), total: Type.Integer({ minimum: 1 }), files: Type.Array(Type.String()),
  reports: Type.Array(Type.Object({ name: Type.String({ pattern: '^coverage-[0-9]+-[0-9]{13}-[0-9]+\\.json$' }), digest: Digest }), { minItems: 1 }),
}, { additionalProperties: false });
const RawCoverage = Type.Object({ result: Type.Array(Type.Object({
  scriptId: Type.String(), url: Type.String(), functions: Type.Array(Type.Object({
    functionName: Type.String(), isBlockCoverage: Type.Boolean(), ranges: Type.Array(Type.Object({
      startOffset: Type.Integer({ minimum: 0 }), endOffset: Type.Integer({ minimum: 0 }), count: Type.Integer({ minimum: 0 }),
    }), { minItems: 1 }),
  })),
}), { minItems: 1 }) });

async function filesUnder(root, directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unexpected non-file: ${path}`);
  }
  return files.sort();
}

export function selectShard(files, index, total) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total || total > files.length) {
    throw new Error('Invalid or empty coverage shard');
  }
  return planShards(files, total)[index - 1].files;
}

export async function suiteIdentity(root) {
  const built = await filesUnder(root, 'dist');
  const scripts = (await filesUnder(root, 'scripts')).filter(file => /\.(mjs|json)$/.test(file));
  const digest = createHash('sha256');
  for (const file of [...built, ...scripts, 'package-lock.json'].sort()) {
    digest.update(file).update('\0').update(hash(await readFile(join(root, file)))).update('\0');
  }
  return {
    version: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    node: process.version, workspace: resolve(root), digest: digest.digest('hex'),
    files: built.filter(file => file.endsWith('.test.js') && file.startsWith('dist/test/')),
  };
}

async function readReport(path) {
  const bytes = await readFile(path);
  if (!Value.Check(RawCoverage, JSON.parse(bytes.toString('utf8')))) throw new Error(`Invalid V8 coverage: ${path}`);
  return hash(bytes);
}

export async function runShard(root, index, total, output) {
  const identity = await suiteIdentity(root);
  const files = selectShard(identity.files, index, total);
  await mkdir(output); // Never overwrite a previous run's success manifest or raw reports.
  const raw = join(output, 'raw');
  await mkdir(raw);
  const reporter = new URL('./test-timings-reporter.mjs', import.meta.url).href;
  const code = await runGuardedTests(['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`, `--test-reporter-destination=${join(output, 'timings.jsonl')}`, ...coverageArguments(false), ...files], {
    cwd: root, env: { ...process.env, NODE_V8_COVERAGE: resolve(raw) },
  });
  if (code !== 0) return code;
  const reports = [];
  for (const name of await readdir(raw)) reports.push({ name, digest: await readReport(join(raw, name)) });
  const manifest = { ...identity, index, total, files, reports };
  if (!Value.Check(Manifest, manifest)) throw new Error('Invalid coverage manifest or no raw reports');
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
  return 0;
}

export async function validateArtifacts(input, identity) {
  const reports = [];
  const indices = new Set();
  let total;
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`Unexpected coverage artifact: ${entry.name}`);
    const directory = join(input, entry.name);
    if (!(await lstat(join(directory, 'manifest.json'))).isFile() || !(await lstat(join(directory, 'raw'))).isDirectory()) {
      throw new Error('Coverage manifest and raw directory must not be symbolic links');
    }
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (!Value.Check(Manifest, manifest)) throw new Error('Invalid coverage manifest');
    for (const key of ['version', 'revision', 'node', 'workspace', 'digest']) {
      if (manifest[key] !== identity[key]) throw new Error(`Coverage identity mismatch: ${key}`);
    }
    total ??= manifest.total;
    if (total !== manifest.total || indices.has(manifest.index)) throw new Error('Duplicate or inconsistent coverage shard');
    indices.add(manifest.index);
    const expected = selectShard(identity.files, manifest.index, total);
    if (JSON.stringify(expected) !== JSON.stringify(manifest.files)) throw new Error('Coverage test assignment mismatch');
    const entries = await readdir(join(directory, 'raw'), { withFileTypes: true });
    if (entries.some(entry => !entry.isFile()) || entries.length !== manifest.reports.length ||
        new Set(manifest.reports.map(report => report.name)).size !== entries.length) throw new Error('Coverage report inventory mismatch');
    for (const report of manifest.reports) {
      if (!entries.some(entry => entry.name === report.name)) throw new Error('Missing coverage report');
      const path = join(directory, 'raw', report.name);
      if (await readReport(path) !== report.digest) throw new Error('Coverage report digest mismatch');
      reports.push(path);
    }
  }
  if (!total || indices.size !== total) throw new Error('Missing coverage shards');
  return reports;
}

export async function mergeShards(root, input) {
  const reports = await validateArtifacts(input, await suiteIdentity(root));
  const staging = await mkdtemp(join(tmpdir(), 'reprise-coverage-merge-'));
  try {
    for (const [index, path] of reports.entries()) {
      await copyFile(path, join(staging, `coverage-${process.pid}-${Date.now()}-${index}.json`));
    }
    const env = { ...process.env, REPRISE_COVERAGE_INPUT: staging };
    delete env.NODE_V8_COVERAGE;
    return await runGuardedTests(['--test', ...coverageArguments(), 'dist/test/coverage-collector.js'], { cwd: root, env });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, argument, output, ...extra] = process.argv.slice(2);
    if (mode === 'run' && /^\d+\/\d+$/.test(argument ?? '') && output && extra.length === 0) {
      const [index, total] = argument.split('/').map(Number);
      process.exitCode = await runShard(process.cwd(), index, total, resolve(output));
    } else if (mode === 'merge' && argument && !output) {
      process.exitCode = await mergeShards(process.cwd(), resolve(argument));
    } else throw new Error('Usage: coverage-shards.mjs run INDEX/TOTAL OUTPUT | merge INPUT');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
