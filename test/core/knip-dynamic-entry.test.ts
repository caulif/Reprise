import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD_ENTRY = 'test/support/control-owner-child.ts!';
const CHILD_FILE = 'test/support/control-owner-child.ts';

test('Knip dynamic child entry prevents a false unused-file result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-knip-child-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await mkdir(join(root, 'test', 'support'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'knip-entry-reverse', private: true, type: 'module' }));
  await writeFile(join(root, 'test', 'main.test.ts'), 'export {};\n');
  await writeFile(join(root, CHILD_FILE), 'process.stdout.write("child");\n');

  const configured = JSON.parse(await readFile(join(process.cwd(), 'knip.json'), 'utf8')) as { entry?: string[] };
  const dynamicEntry = configured.entry?.filter((entry) => entry === CHILD_ENTRY) ?? [];
  const knipBin = join(process.cwd(), 'node_modules', 'knip', 'bin', 'knip.js');
  const run = async (entry: readonly string[]) => {
    await writeFile(join(root, 'knip.json'), JSON.stringify({ entry, project: ['test/**/*.ts'] }));
    const result = spawnSync(process.execPath, [knipBin, '--reporter', 'json'], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(result.error);
    return { status: result.status, report: JSON.parse(result.stdout) as { files: string[] } };
  };

  const included = await run(['test/main.test.ts', ...dynamicEntry]);
  assert.equal(included.status, 0, 'configured dynamic entry must keep Knip green');
  const removed = await run(['test/main.test.ts']);
  assert.notEqual(removed.status, 0, 'removing the dynamic entry must fail Knip');
  assert.ok(removed.report.files.includes(CHILD_FILE));
});
