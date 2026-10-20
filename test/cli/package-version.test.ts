import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCliPackageVersion } from '../../src/cli/package-version.js';

test('CLI version comes from its installed package, not the caller environment or working directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'reprise-version-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'unrelated-host', version: '98.0.0' }));
  const metadata = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
  const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));
  for (const callerVersion of [undefined, '99.0.0']) {
    const environment = { ...process.env };
    if (callerVersion) environment.npm_package_version = callerVersion;
    else delete environment.npm_package_version;
    const output = execFileSync(process.execPath, [cli, '--version'], { cwd: directory, env: environment, encoding: 'utf8' });
    assert.ok(output.startsWith(`reprise ${metadata.version} (`), output);
  }
});

test('package version loading accepts released versions and rejects invalid or foreign metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'reprise-version-metadata-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = pathToFileURL(join(directory, 'package.json'));
  await writeFile(path, JSON.stringify({ name: '@caulif/reprise', version: '0.1.1-beta.1+build.2' }));
  assert.equal(readCliPackageVersion(path), '0.1.1-beta.1+build.2');
  for (const metadata of [{ name: 'foreign', version: '0.1.1' }, { name: '@caulif/reprise', version: 1 },
    { name: '@caulif/reprise', version: 'latest' }]) {
    await writeFile(path, JSON.stringify(metadata));
    assert.throws(() => readCliPackageVersion(path), /Invalid installed Reprise package metadata/);
  }
  await writeFile(path, '{');
  assert.throws(() => readCliPackageVersion(path), SyntaxError);
  await rm(path);
  assert.throws(() => readCliPackageVersion(path), /ENOENT/);
});
