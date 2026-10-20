import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { resolveNpmCliJs } from './npm-cli.mjs';

const PACKAGE = '@caulif/reprise';
const REPOSITORY = 'caulif/Reprise';
const Version = Type.String({ pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?![\\s\\S])' });
const PackSchema = Type.Array(Type.Object({ name: Type.Literal(PACKAGE), version: Version,
  filename: Type.String({ pattern: '^caulif-reprise-[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$' }),
  integrity: Type.String({ pattern: '^sha512-[A-Za-z0-9+/]+=*$' }) }), { minItems: 1, maxItems: 1 });
const ReleaseSchema = Type.Object({ tag_name: Type.String(), target_commitish: Type.String(), draft: Type.Boolean(),
  assets: Type.Array(Type.Object({ name: Type.String() })) });
const RegistrySchema = Type.Object({ name: Type.Literal(PACKAGE), version: Version,
  dist: Type.Object({ integrity: Type.String() }) });
const PlanSchema = Type.Object({ tag: Type.String(), sha: Type.String(), filename: Type.String(), integrity: Type.String() });

function parse(schema, bytes) {
  const data = JSON.parse(bytes);
  if (!Value.Check(schema, data)) throw new Error('Release metadata failed schema validation.');
  return data;
}

export function versionFromTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v') || !Value.Check(Version, tag.slice(1))) {
    throw new Error('Expected a stable release tag such as v0.1.1.');
  }
  return tag.slice(1);
}

export function validateIdentity(tag, sha, versions) {
  const version = versionFromTag(tag);
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Release commit must be a full SHA.');
  if (!versions.length || versions.some(candidate => candidate !== version)) {
    throw new Error('Tag, package, lockfile, manifest, and tarball versions must match.');
  }
  return version;
}

export function assertIntegrity(bytes, integrity) {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== actual) throw new Error('Published and local package integrity differ; do not republish or overwrite.');
}

export function registryExists(status, data, expected) {
  if (status === 404) return false;
  if (status !== 200) throw new Error(`Registry check failed (${status}); publishing is blocked.`);
  if (!Value.Check(RegistrySchema, data) || data.version !== expected.version || data.dist.integrity !== expected.integrity) {
    throw new Error('Registry version exists with different or invalid metadata.');
  }
  return true;
}

export function compareVersions(a, b) {
  if (![a, b].every(value => Value.Check(Version, value))) throw new Error('Only stable versions are supported.');
  for (let index = 0; index < 3; index++) {
    const difference = Number(a.split('.')[index]) - Number(b.split('.')[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function release(tag) {
  versionFromTag(tag);
  return parse(ReleaseSchema, gh(['api', `repos/${REPOSITORY}/releases/tags/${tag}`]));
}

function identity() {
  const tag = process.env.RELEASE_TAG;
  const info = release(tag);
  const sha = info.target_commitish;
  validateIdentity(tag, sha, [versionFromTag(info.tag_name)]);
  if (process.env.GITHUB_REF !== `refs/tags/${tag}` || process.env.GITHUB_SHA !== sha) {
    throw new Error('Publish workflow and provenance must run from the exact release tag commit.');
  }
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  const tagged = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
  if (tagged !== sha) throw new Error('Release tag does not point to its recorded commit.');
  output({ tag, sha });
}

function packageInfo(directory, create = false) {
  const tag = process.env.RELEASE_TAG;
  const sha = process.env.RELEASE_SHA;
  const [pack] = parse(PackSchema, readFileSync(join(directory, 'pack.json'), 'utf8'));
  const pkg = parse(Type.Object({ name: Type.Literal(PACKAGE), version: Version }), readFileSync('package.json', 'utf8'));
  const lock = parse(Type.Object({ version: Version, packages: Type.Object({ '': Type.Object({ version: Version }) }) }),
    readFileSync('package-lock.json', 'utf8'));
  const manifest = parse(Type.Object({ '.': Version }), readFileSync('.release-please-manifest.json', 'utf8'));
  const version = validateIdentity(tag, sha, [pkg.version, lock.version, lock.packages[''].version, manifest['.'], pack.version]);
  if (pack.filename !== `caulif-reprise-${version}.tgz`) throw new Error('Unexpected package filename.');
  const bytes = readFileSync(join(directory, pack.filename));
  assertIntegrity(bytes, pack.integrity);
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== sha) throw new Error('Checkout does not match release commit.');
  const plan = { tag, sha, filename: pack.filename, integrity: pack.integrity };
  if (create) writeFileSync(join(directory, 'release.json'), `${JSON.stringify(plan, null, 2)}\n`);
  else {
    const saved = parse(PlanSchema, readFileSync(join(directory, 'release.json'), 'utf8'));
    if (Object.keys(plan).some(key => saved[key] !== plan[key])) throw new Error('Release artifact provenance mismatch.');
  }
  return { ...plan, version, bytes };
}

async function registryRequest(path) {
  const response = await fetch(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(20_000),
    headers: { 'cache-control': 'no-cache' } });
  return { status: response.status, data: response.status === 200 ? await response.json() : undefined };
}

async function existing(info) {
  const result = await registryRequest(`@caulif%2Freprise/${info.version}`);
  return registryExists(result.status, result.data, info);
}

async function latest() {
  const result = await registryRequest('@caulif%2Freprise/latest');
  if (result.status !== 200 || !Value.Check(RegistrySchema, result.data)) throw new Error('Cannot resolve the current npm latest version.');
  return result.data.version;
}

async function checkRegistry(directory) {
  const info = packageInfo(directory);
  const exists = await existing(info);
  if (!exists && compareVersions(await latest(), info.version) >= 0) throw new Error('Refusing to move npm latest backwards or replace a version.');
  output({ exists, filename: info.filename });
}

async function verifyRegistry(directory) {
  const info = packageInfo(directory);
  let available = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await existing(info) && compareVersions(await latest(), info.version) >= 0) { available = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!available) throw new Error('Published version or latest tag is not yet available; retry this release later.');
  const temporary = mkdtempSync(join(tmpdir(), 'reprise-registry-'));
  try {
    execFileSync(process.execPath, [resolveNpmCliJs(), 'install', '--prefix', temporary, `${PACKAGE}@${info.version}`,
      '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    const cli = join(temporary, 'node_modules', '@caulif', 'reprise', 'dist', 'src', 'cli', 'main.js');
    const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    if (!version.startsWith(`reprise ${info.version} (`)) throw new Error('Installed CLI version does not match.');
    execFileSync(process.execPath, [cli, '--help'], { stdio: 'ignore' });
    console.log(`Registry integrity and installed CLI verified: ${info.tag}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function finish(directory) {
  const info = packageInfo(directory);
  if (!await existing(info)) throw new Error('Do not publish GitHub Release before npm is available.');
  const npmLatest = await latest();
  if (compareVersions(npmLatest, info.version) < 0) throw new Error('npm latest has not advanced; keep the GitHub Release draft.');
  const current = release(info.tag);
  if (current.target_commitish !== info.sha) throw new Error('Release target changed.');
  if (current.assets.some(asset => asset.name === info.filename)) {
    const temporary = mkdtempSync(join(tmpdir(), 'reprise-asset-'));
    try {
      gh(['release', 'download', info.tag, '--repo', REPOSITORY, '--pattern', info.filename, '--dir', temporary]);
      assertIntegrity(readFileSync(join(temporary, info.filename)), info.integrity);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } else gh(['release', 'upload', info.tag, join(directory, info.filename), '--repo', REPOSITORY]);
  if (current.draft) gh(['release', 'edit', info.tag, '--repo', REPOSITORY, '--draft=false',
    compareVersions(npmLatest, info.version) > 0 ? '--latest=false' : '--latest']);
  console.log(`Synchronized npm and GitHub Release: ${info.tag}`);
}

async function dispatchChecks() {
  const prs = parse(Type.Array(Type.Object({ number: Type.Integer({ minimum: 1 }), headBranchName: Type.String() })),
    process.env.RELEASE_PRS ?? '[]');
  for (const pr of prs) {
    if (!/^release-please--branches--main(?:--[a-z0-9-]+)?$/.test(pr.headBranchName)) throw new Error('Unexpected release PR branch.');
    gh(['workflow', 'run', 'check.yml', '--repo', REPOSITORY, '--ref', pr.headBranchName]);
  }
}

function dispatchRelease() {
  const tag = process.env.RELEASE_TAG;
  const info = release(tag);
  validateIdentity(tag, info.target_commitish, [versionFromTag(info.tag_name)]);
  gh(['workflow', 'run', 'release.yml', '--repo', REPOSITORY, '--ref', tag, '--raw-field', `tag=${tag}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  const directory = process.argv[3];
  if (directory && basename(directory) !== 'reprise-release') throw new Error('Expected the dedicated artifact directory.');
  if (command === 'dispatch-checks') await dispatchChecks();
  else if (command === 'dispatch-release') dispatchRelease();
  else if (command === 'identity') identity();
  else if (command === 'package') packageInfo(directory, true);
  else if (command === 'registry') await checkRegistry(directory);
  else if (command === 'verify-registry') await verifyRegistry(directory);
  else if (command === 'finish') await finish(directory);
  else throw new Error('Unknown release operation.');
}
