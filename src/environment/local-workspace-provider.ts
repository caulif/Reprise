import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type JsonRecord = Record<string, unknown>;
type EnvironmentSource = { caseId: string; sourceRoot: string };
type EnvironmentClue = JsonRecord;
type EnvironmentPolicy = JsonRecord;
type FingerprintEntry = { path: string; kind: 'file' | 'directory'; size: number; contentHash?: string };

export type EnvironmentFingerprint = {
  capturedAt: string;
  resources: FingerprintEntry[];
  digest: string;
};

export type EnvironmentBaseline = {
  baselineId: string;
  caseId: string;
  mode: 'canonical' | 'unsupported';
  match: 'matched' | 'observational';
  resources: [];
  readiness: {
    runnable: 'isolated' | 'unsupported';
    strictness: 'strict';
    blockingResourceIds: string[];
  };
  fingerprint: EnvironmentFingerprint;
  capabilities: {
    canFork: boolean;
    fingerprints: ['file_tree'];
    externalSideEffects: 'none';
  };
  warnings: string[];
  createdAt: string;
  root?: string;
};

export type PreparedEnvironmentRef = {
  environmentId: string;
  baselineId: string;
  runId: string;
  mode: 'isolated';
  root: string;
  resources: [{ resourceId: string; mode: 'isolated'; bindingRef: string; writable: true; owner: 'harness' }];
  manifestRef: string;
  beforeFingerprint: EnvironmentFingerprint;
};

export type ReleaseResult = { status: 'released' | 'already_released'; environmentId: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LocalWorkspaceProvider {
  readonly #root: string;
  readonly #preparedRoots = new Map<string, string>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Environment root must be an absolute path.');
    this.#root = resolve(root);
  }

  async resolveBaseline(source: EnvironmentSource, _clues: EnvironmentClue[], _policy: EnvironmentPolicy): Promise<EnvironmentBaseline> {
    assertId(source.caseId, 'caseId');
    const sourceRoot = resolve(source.sourceRoot);
    let sourceInfo;
    try {
      sourceInfo = await lstat(sourceRoot);
    } catch (error) {
      if (isMissing(error)) return unsupportedBaseline(source.caseId);
      throw error;
    }
    if (!sourceInfo.isDirectory()) throw new Error('Environment source must be a directory.');
    await assertTreeSafe(sourceRoot);
    if (sourceRoot === this.#root || isInside(this.#root, sourceRoot) || isInside(sourceRoot, this.#root)) {
      throw new Error('Environment source and provider workspace must not overlap.');
    }

    const baselineRoot = join(this.#root, 'baselines', source.caseId);
    await mkdir(dirname(baselineRoot), { recursive: true });
    await mkdir(baselineRoot);
    await copyTree(sourceRoot, baselineRoot);
    const fingerprint = await fingerprintTree(baselineRoot);
    return {
      baselineId: `baseline-${source.caseId}`,
      caseId: source.caseId,
      mode: 'canonical',
      match: 'matched',
      resources: [],
      readiness: { runnable: 'isolated', strictness: 'strict', blockingResourceIds: [] },
      fingerprint,
      capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
      warnings: [],
      createdAt: new Date().toISOString(),
      root: baselineRoot,
    };
  }

  async prepareRun(baseline: EnvironmentBaseline, runId: string): Promise<PreparedEnvironmentRef> {
    assertId(runId, 'runId');
    if (baseline.mode !== 'canonical' || baseline.readiness.runnable !== 'isolated' || !baseline.root) {
      throw new Error(`Environment baseline ${baseline.baselineId} is unsupported.`);
    }
    const baselineRoot = resolve(baseline.root);
    if (!isInside(this.#root, baselineRoot)) throw new Error('Environment baseline is outside the provider workspace.');
    const runRoot = join(this.#root, 'runs', runId);
    await mkdir(dirname(runRoot), { recursive: true });
    await mkdir(runRoot);
    await copyTree(baselineRoot, runRoot);
    const beforeFingerprint = await fingerprintTree(runRoot);
    this.#preparedRoots.set(`environment-${runId}`, runRoot);
    return {
      environmentId: `environment-${runId}`,
      baselineId: baseline.baselineId,
      runId,
      mode: 'isolated',
      root: runRoot,
      resources: [{ resourceId: 'workspace', mode: 'isolated', bindingRef: runRoot, writable: true, owner: 'harness' }],
      manifestRef: `environment:${runId}`,
      beforeFingerprint,
    };
  }

  // ponytail: ownership is process-local until a run manifest exists; later recovery can validate that manifest before cleanup.
  #assertOwnedEnvironment(environment: PreparedEnvironmentRef): void {
    const expectedRoot = this.#preparedRoots.get(environment.environmentId);
    if (environment.environmentId !== `environment-${environment.runId}` || expectedRoot !== resolve(environment.root)) {
      throw new Error('Environment workspace is not owned by this provider.');
    }
  }
  async fingerprint(environment: PreparedEnvironmentRef): Promise<EnvironmentFingerprint> {
    this.#assertOwnedEnvironment(environment);
    try {
      await stat(environment.root);
    } catch (error) {
      if (isMissing(error)) throw new Error(`Environment workspace is unavailable: ${environment.root}`);
      throw error;
    }
    return fingerprintTree(environment.root);
  }

  async release(environment: PreparedEnvironmentRef): Promise<ReleaseResult> {
    this.#assertOwnedEnvironment(environment);
    try {
      await rm(environment.root, { recursive: true, force: false });
      return { status: 'released', environmentId: environment.environmentId };
    } catch (error) {
      if (isMissing(error)) return { status: 'already_released', environmentId: environment.environmentId };
      throw new Error(`Unable to release environment ${environment.environmentId}: ${String(error)}`);
    }
  }
}

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`Invalid ${label}.`);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}


function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function unsupportedBaseline(caseId: string): EnvironmentBaseline {
  const fingerprint: EnvironmentFingerprint = { capturedAt: new Date().toISOString(), resources: [], digest: createHash('sha256').update('unsupported').digest('hex') };
  return {
    baselineId: `baseline-${caseId}`,
    caseId,
    mode: 'unsupported',
    match: 'observational',
    resources: [],
    readiness: { runnable: 'unsupported', strictness: 'strict', blockingResourceIds: ['workspace'] },
    fingerprint,
    capabilities: { canFork: false, fingerprints: ['file_tree'], externalSideEffects: 'none' },
    warnings: ['Source workspace is unavailable.'],
    createdAt: new Date().toISOString(),
  };
}

async function assertTreeSafe(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Environment source contains an unsupported symlink: ${path}`);
    if (entry.isDirectory()) await assertTreeSafe(path);
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Environment source contains an unsupported symlink: ${from}`);
    if (entry.isDirectory()) {
      await mkdir(to);
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from, { flag: 'r' }), { flag: 'wx' });
    } else {
      throw new Error(`Unsupported environment entry: ${from}`);
    }
  }
}

// ponytail: linear file-tree scan is sufficient for the first local slice; add an index only after measured need.
async function fingerprintTree(root: string): Promise<EnvironmentFingerprint> {
  const resources: FingerprintEntry[] = [];
  await collectFingerprint(root, '', resources);
  const digest = createHash('sha256').update(JSON.stringify(resources)).digest('hex');
  return { capturedAt: new Date().toISOString(), resources, digest };
}

async function collectFingerprint(root: string, prefix: string, resources: FingerprintEntry[]): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const path = join(root, relativePath);
    if (entry.isSymbolicLink()) throw new Error(`Environment workspace contains an unsupported symlink: ${path}`);
    if (entry.isDirectory()) {
      resources.push({ path: relativePath, kind: 'directory', size: 0 });
      await collectFingerprint(root, relativePath, resources);
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      resources.push({ path: relativePath, kind: 'file', size: bytes.byteLength, contentHash: createHash('sha256').update(bytes).digest('hex') });
    } else {
      throw new Error(`Unsupported environment entry: ${path}`);
    }
  }
  resources.sort((left, right) => left.path.localeCompare(right.path));
}
