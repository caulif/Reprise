import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Identity { version: number; revision: string; node: string; workspace: string; digest: string; files: string[] }
async function tooling() {
  return import(pathToFileURL(resolve('scripts/coverage-shards.mjs')).href) as Promise<{
    selectShard: (files: string[], index: number, total: number) => string[];
    suiteIdentity: (root: string) => Promise<Identity>;
    validateArtifacts: (input: string, identity: Identity) => Promise<string[]>;
  }>;
}

test('coverage shard assignment is complete, disjoint and rejects invalid or empty shards', async () => {
  const { selectShard } = await tooling();
  const files = Array.from({ length: 273 }, (_, index) => String(index));
  const assigned = [1, 2, 3, 4].flatMap(index => selectShard(files, index, 4));
  assert.equal(new Set(assigned).size, files.length);
  assert.deepEqual(assigned.sort(), [...files].sort());
  for (const [index, total] of [[0, 4], [5, 4], [1.5, 4], [1, 274], [1, 0]] as const) {
    assert.throws(() => selectShard(files, index, total));
  }
});

test('historical costs balance heavy files deterministically without omitting new files', async () => {
  const { planShards } = await import(pathToFileURL(resolve('scripts/coverage-plan.mjs')).href) as {
    planShards: (files: string[], total: number, weights?: Record<string, number>, defaultMs?: number) => { files: string[]; estimatedMs: number }[];
  };
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const weights = { a: 80, b: 70, c: 60, d: 50, e: 40, f: 30, g: 20, h: 10 };
  const plan = planShards(files, 4, weights);
  assert.deepEqual(plan.map(shard => shard.estimatedMs), [90, 90, 90, 90]);
  assert.deepEqual(planShards([...files].reverse(), 4, weights), plan);
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), files);
  const extended = planShards([...files, 'new'], 4, weights, 1);
  assert.equal(extended.flatMap(shard => shard.files).filter(file => file === 'new').length, 1);
  assert.throws(() => planShards(['a', 'a'], 1));
  assert.throws(() => planShards(files, 9));
});

test('local and merged coverage keep the original global thresholds and exclusions', async () => {
  const { coverageArguments } = await import(pathToFileURL(resolve('scripts/test-coverage.mjs')).href) as {
    coverageArguments: (enforce?: boolean) => string[];
  };
  assert.deepEqual(coverageArguments(), [
    '--experimental-test-coverage', '--test-coverage-lines=88', '--test-coverage-branches=76', '--test-coverage-functions=87',
    '--test-coverage-exclude=dist/test/**', '--test-coverage-exclude=dist/scripts/**',
    '--test-coverage-exclude=dist/src/**/types.js', '--test-coverage-exclude=dist/src/cli/main.js',
  ]);
  assert.ok(coverageArguments(false).every(argument => !/--test-coverage-(lines|branches|functions)=/.test(argument)));
});

test('native coverage shards merge complementary branches and reject incomplete, stale or failed results', { timeout: 120_000 }, async t => {
  const { suiteIdentity, validateArtifacts } = await tooling();
  await mkdir('docs/.local', { recursive: true });
  const root = await mkdtemp(resolve('docs/.local/coverage-gate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'dist/test'), { recursive: true });
  await mkdir(join(root, 'dist/src'));
  await mkdir(join(root, 'tmp'));
  await cp('dist/test/coverage-collector.js', join(root, 'dist/test/coverage-collector.js'));
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'dist/src/logic.js'), 'export function choose(value) {\n if (value) return 1;\n return 2;\n}\n');
  const logicImport = `import { choose } from ${JSON.stringify('../src/logic.js')};\n`;
  for (const [index, value] of [true, false].entries()) {
    await writeFile(join(root, `dist/test/${index}.test.js`), `${logicImport}choose(${value});\n`);
  }
  const script = resolve('scripts/coverage-shards.mjs');
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp') };
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.once('error', reject);
    child.once('exit', code => done({ code, output }));
  });
  const success = async (args: string[]) => {
    const result = await run(args);
    assert.equal(result.code, 0, result.output);
    return result.output;
  };
  await mkdir(join(root, 'artifacts'));
  await success([script, 'run', '1/2', 'artifacts/one']);
  const timing = JSON.parse((await readFile(join(root, 'artifacts/one/timings.jsonl'), 'utf8')).trim()) as { file: string; durationMs: number };
  assert.equal(timing.file, 'dist/test/0.test.js');
  assert.ok(timing.durationMs > 0);
  const identity = await suiteIdentity(root);
  await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity), /Missing coverage shards/);
  await success([script, 'run', '2/2', 'artifacts/two']);
  const merged = await success([script, 'merge', 'artifacts']);
  assert.match(merged, /all files\s*\|\s*100\.00\s*\|\s*100\.00\s*\|\s*100\.00/);
  const serial = await success(['--test', '--experimental-test-coverage', '--test-coverage-lines=100', '--test-coverage-branches=100', '--test-coverage-functions=100', '--test-coverage-exclude=dist/test/**', 'dist/test/0.test.js', 'dist/test/1.test.js']);
  assert.match(serial, /all files\s*\|\s*100\.00\s*\|\s*100\.00\s*\|\s*100\.00/);
  const original = await readFile(join(root, 'artifacts/one/manifest.json'), 'utf8');
  for (const key of ['revision', 'node', 'workspace', 'digest'] as const) {
    await assert.rejects(validateArtifacts(join(root, 'artifacts'), { ...identity, [key]: 'stale' }), /identity mismatch/);
  }
  const mutateManifest = async (change: (manifest: Record<string, unknown>) => void) => {
    const manifest = JSON.parse(original) as Record<string, unknown>;
    change(manifest);
    await writeFile(join(root, 'artifacts/one/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity));
    await writeFile(join(root, 'artifacts/one/manifest.json'), original);
  };
  await mutateManifest(manifest => { manifest.files = []; });
  await mutateManifest(manifest => { manifest.total = 3; });
  await mutateManifest(manifest => { manifest.index = 2; });
  await mutateManifest(manifest => { manifest.version = 99; });
  await cp(join(root, 'artifacts/one'), join(root, 'artifacts/duplicate'), { recursive: true });
  await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity), /Duplicate/);
  await rm(join(root, 'artifacts/duplicate'), { recursive: true });
  const raw = join(root, 'artifacts/one/raw');
  const name = (await readdir(raw))[0];
  assert.ok(name);
  const report = join(raw, name);
  const bytes = await readFile(report);
  await writeFile(report, '{}');
  await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity), /Invalid V8/);
  await writeFile(report, bytes.toString().replace('"result":', '"tampered":true,"result":'));
  await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity), /digest mismatch/);
  await rm(report);
  await assert.rejects(validateArtifacts(join(root, 'artifacts'), identity), /inventory mismatch/);
  await writeFile(report, bytes);
  // Both workers succeed, but neither exercises the false branch: the global gate must fail.
  await writeFile(join(root, 'dist/test/1.test.js'), `${logicImport}choose(true);\n`);
  await mkdir(join(root, 'incomplete'));
  await success([script, 'run', '1/2', 'incomplete/one']);
  await success([script, 'run', '2/2', 'incomplete/two']);
  const incomplete = await run([script, 'merge', 'incomplete']);
  assert.notEqual(incomplete.code, 0, incomplete.output);
  assert.match(incomplete.output, /coverage.*threshold/i);
  await writeFile(join(root, 'dist/test/1.test.js'), 'throw new Error("intentional worker failure");');
  const failed = await run([script, 'run', '2/2', 'failed']);
  assert.notEqual(failed.code, 0, failed.output);
  await assert.rejects(readFile(join(root, 'failed/manifest.json')), { code: 'ENOENT' });
  await writeFile(join(root, 'dist/test/1.test.js'), "import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; mkdirSync(join(tmpdir(), 'reprise-intentional-leak'));");
  const leaked = await run([script, 'run', '2/2', 'leaked']);
  assert.notEqual(leaked.code, 0, leaked.output);
  assert.match(leaked.output, /new reprise-\* temp dir/);
  await assert.rejects(readFile(join(root, 'leaked/manifest.json')), { code: 'ENOENT' });
});
