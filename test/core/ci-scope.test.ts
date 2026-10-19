import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function scopeTool() {
  return import(pathToFileURL(resolve('scripts/ci-scope.mjs')).href) as Promise<{
    requiresFullChecks: (paths: string[]) => boolean;
    verifyResults: (full: string, results: Record<string, string>) => void;
  }>;
}

test('only explicit Markdown documentation paths qualify for the fast path', async () => {
  const { requiresFullChecks } = await scopeTool();
  assert.equal(requiresFullChecks(['README.md', 'README.zh-CN.md', 'docs/usage.md', 'docs/architecture/overview.md']), false);
  for (const path of ['src/runtime.ts', 'src/products/packs/codex/recovery/SKILL.md', 'test/README.md', 'AGENTS.md', 'docs/AGENTS.md',
    'docs/a/AGENTS.override.md', 'docs/../src/runtime.md', 'docs/.local/script.md', 'docs/diagram.svg', 'package-lock.json',
    '.github/workflows/check.yml', 'scripts/ci-scope.mjs', 'docs/fixture.json', 'knip.json']) {
    assert.equal(requiresFullChecks(['docs/usage.md', path]), true, path);
  }
  assert.equal(requiresFullChecks([]), true);
});

test('aggregate requires every code lane and only allows deliberate documentation skips', async () => {
  const { verifyResults } = await scopeTool();
  const full = { scope: 'success', static: 'success', test: 'success', audit: 'success', coverage: 'success' };
  const docs = { ...full, test: 'skipped', audit: 'skipped', coverage: 'skipped' };
  verifyResults('true', full);
  verifyResults('false', docs);
  for (const state of ['failure', 'cancelled', 'skipped', '']) {
    for (const lane of Object.keys(full)) assert.throws(() => verifyResults('true', { ...full, [lane]: state }));
  }
  for (const lane of Object.keys(docs)) {
    assert.throws(() => verifyResults('false', { ...docs, [lane]: 'failure' }));
    assert.throws(() => verifyResults('false', { ...docs, [lane]: 'cancelled' }));
  }
  assert.throws(() => verifyResults('', full));
  assert.throws(() => verifyResults('false', { ...docs, scope: 'skipped' }));
  assert.throws(() => verifyResults('true', docs));
});

test('scope CLI compares the whole PR, includes rename deletions and always checks main pushes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-ci-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), 'baseline');
  await writeFile(join(root, 'src/runtime.md'), 'runtime input');
  const base = commit();
  await writeFile(join(root, 'README.md'), 'changed');
  const docsHead = commit();
  const output = join(root, '.git/scope-output');
  const run = async (event: string, head: string, expected: boolean) => {
    await writeFile(output, '');
    execFileSync(process.execPath, [resolve('scripts/ci-scope.mjs')], {
      cwd: root, windowsHide: true, env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, REPRISE_CI_BASE: base, REPRISE_CI_HEAD: head },
    });
    assert.equal(await readFile(output, 'utf8'), `full=${expected}\n`);
  };
  await run('pull_request', docsHead, false);
  await run('push', docsHead, true);
  await rename(join(root, 'src/runtime.md'), join(root, 'docs/runtime.md'));
  await run('pull_request', commit(), true);
});
