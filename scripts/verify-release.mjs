import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { assertIntegrity, compareVersions, registryExists, release, validateIdentity, versionFromTag } from './release-artifacts.mjs';

const sha = 'a'.repeat(40);
const version = Type.String({ pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' });
function load(path, schema) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Value.Check(schema, data), `Invalid release metadata: ${path}`);
  return data;
}

function selfTest() {
  for (const draft of [true, false]) {
    const metadata = { tag_name: 'v0.1.1', target_commitish: sha, draft, assets: [] };
    assert.deepEqual(release('v0.1.1', args => {
      assert.deepEqual(args.slice(0, 5), ['release', 'view', 'v0.1.1', '--repo', 'caulif/Reprise']);
      assert.ok(args.includes('tagName,targetCommitish,isDraft,assets'));
      return JSON.stringify(metadata);
    }), metadata);
  }
  assert.throws(() => release('v0.1.1', () => '{}'), /schema validation/);
  assert.throws(() => release('v0.1.1', () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  assert.throws(() => release('v0.1.1;bad', () => { assert.fail('Invalid tags must not reach gh'); }));
  assert.equal(versionFromTag('v0.1.1'), '0.1.1');
  for (const tag of ['0.1.1', 'v01.1.1', 'v0.1.1-beta.1', 'v0.1.1\n', 'v0.1.1\nnext', 'v0.1.1;echo bad']) {
    assert.throws(() => versionFromTag(tag));
  }
  assert.equal(validateIdentity('v0.1.1', sha, ['0.1.1', '0.1.1']), '0.1.1');
  assert.throws(() => validateIdentity('v0.1.1', sha, ['0.1.0']));
  assert.throws(() => validateIdentity('v0.1.1', 'main', ['0.1.1']));
  assert.throws(() => validateIdentity('v0.1.1', `${sha}\n`, ['0.1.1']));
  assert.throws(() => validateIdentity('v0.1.1', sha, []));
  const expected = { version: '0.1.1', integrity: 'sha512-test' };
  const registry = { name: '@caulif/reprise', version: '0.1.1', dist: { integrity: 'sha512-test' } };
  assert.equal(registryExists(404, undefined, expected), false);
  assert.equal(registryExists(200, registry, expected), true);
  for (const status of [401, 403, 429, 500, 503]) assert.throws(() => registryExists(status, undefined, expected));
  assert.throws(() => registryExists(200, { ...registry, dist: { integrity: 'different' } }, expected));
  assert.throws(() => registryExists(200, { ...registry, version: '0.1.0' }, expected));
  assert.throws(() => registryExists(200, { ...registry, name: 'other-package' }, expected));
  assert.throws(() => registryExists(200, {}, expected));
  assertIntegrity(Buffer.alloc(0), 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==');
  assert.throws(() => assertIntegrity(Buffer.from('changed'), 'sha512-test'));
  assert.equal(compareVersions('0.2.0', '0.1.10'), 1);
  assert.equal(compareVersions('0.1.1', '0.1.2'), -1);
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
  assert.throws(() => compareVersions('next', '0.1.1'));
  console.log('verify-release reverse tests: mismatched versions/commits/integrity and registry failures are rejected.');
}

selfTest();
const pkg = load('package.json', Type.Object({ version }));
const lock = load('package-lock.json', Type.Object({ version, packages: Type.Object({ '': Type.Object({ version }) }) }));
const manifest = load('.release-please-manifest.json', Type.Object({ '.': version }));
validateIdentity(`v${pkg.version}`, sha, [pkg.version, lock.version, lock.packages[''].version, manifest['.']]);
const config = load('release-please-config.json', Type.Object({ packages: Type.Object({ '.': Type.Object({
  'release-type': Type.Literal('node'), 'package-name': Type.Literal('@caulif/reprise'),
  'changelog-path': Type.Literal('docs/CHANGELOG.md'), 'include-component-in-tag': Type.Literal(false),
  'include-v-in-tag': Type.Literal(true), draft: Type.Literal(true), 'force-tag-creation': Type.Literal(true),
}) }) }));
assert.ok(config.packages['.']);
console.log('verify-release: package/lock/manifest versions agree; releases use drafts and immutable tags.');
