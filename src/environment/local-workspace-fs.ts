import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { formatBytes } from '../core/format.js';
import { SAFE_ID, sha256, sha256File } from '../core/identity.js';
import { dirname, join, resolve } from 'node:path';
import { relativeInside } from '../core/paths.js';
import { isRecoveryPath } from '../infrastructure/recovery-tools.js';
import { SNAPSHOT_LIMITS } from './snapshots.js';
import {
  type EnvironmentBaseline,
  type EnvironmentFingerprint,
  type FingerprintEntry,
  type RecoveryEnvelope,
  type SensitiveFileCategory,
  type WorkspaceBudget,
  type WorkspaceExclusion,
  MAX_INLINE_HASH_BYTES,
} from './local-workspace-provider.js';

export function recoveryPath(root: string, relativePath: string): string {
  if (!isRecoveryPath(relativePath)) throw new Error(`Recovery delta path is outside the workspace: ${relativePath}.`);
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`Recovery delta path is outside the workspace: ${relativePath}.`);
  return target;
}

export async function assertNoSymlinkAncestors(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split(/[\\/]/).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Recovery delta path traverses a symbolic link: ${relativePath}.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export async function ensureRegularRecoveryTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Recovery delta target is not a regular file: ${path}.`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function removeRecoveryFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`Recovery delta delete target is not a regular file: ${path}.`);
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
export function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

export function isInside(root: string, candidate: string): boolean {
  const path = relativeInside(root, candidate);
  return path !== undefined && path !== '';
}


export async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }

const PUBLISH_BACKOFF_MS = [0, 30, 80, 160, 320, 640] as const;

/**
 * Publishes a fully copied staging tree as the baseline directory.
 * Windows often returns EPERM on a directory rename while Defender/Search still
 * holds a handle on a file that was just written; retry, then copy as fallback.
 */
export async function publishDirectory(
  staging: string,
  destination: string,
  attemptRename: typeof rename = rename,
): Promise<void> {
  let last: unknown;
  for (const delay of PUBLISH_BACKOFF_MS) {
    if (delay) await sleep(delay);
    try {
      await attemptRename(staging, destination);
      return;
    } catch (error) {
      last = error;
      if (await exists(destination) || !isBusy(error)) throw error;
    }
  }
  if (await exists(destination)) throw last;
  try {
    await cp(staging, destination, { recursive: true, errorOnExist: true });
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Could not publish the isolated baseline. Windows still had a lock on the copied files. Retry the run.', { cause: error });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EAGAIN';
}

export async function removeCaptureArtifacts(stagingRoot: string | undefined, baselineRoot: string, markerPath: string): Promise<void> {
  for (const path of [stagingRoot, baselineRoot, markerPath]) {
    if (path === undefined) continue;
    try {
      await rm(path, { recursive: path !== markerPath, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

/** Returns the source digest recorded when the baseline was captured, or undefined when none exists yet. */
export type BaselineMarker = { sourceFingerprint: string; recovery?: NonNullable<EnvironmentBaseline['recovery']> };

export async function readBaselineMarker(path: string): Promise<BaselineMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }
  const marker = parsed !== null && typeof parsed === 'object' ? parsed as { sourceFingerprint?: unknown; recovery?: unknown } : undefined;
  if (typeof marker?.sourceFingerprint !== 'string' || !marker.sourceFingerprint) throw new Error(`Baseline marker ${path} is unreadable. Delete its directory to recapture the baseline.`);
  return marker.recovery && isRecoveryMarker(marker.recovery) ? { sourceFingerprint: marker.sourceFingerprint, recovery: marker.recovery } : { sourceFingerprint: marker.sourceFingerprint };
}

export function isRecoveryEnvelope(value: RecoveryEnvelope): boolean {
  const unresolvedOk = Array.isArray(value.unresolved) && value.unresolved.every((item) => typeof item === 'string');
  if (value.reportPath !== 'recovery.md' || !unresolvedOk) return false;
  if (value.status === 'ready') return true;
  return value.status === 'blocked' && value.unresolved.length > 0 && value.unresolved.every((item) => item.length > 0);
}

export async function cleanupRecoveryTransients(root: string): Promise<void> {
  await unlink(join(root, 'recovery.md')).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  await unlink(join(root, 'recovery-manifest.json')).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  await rm(join(root, '.reprise', 'recovery-work'), { recursive: true, force: true });
}

const RECOVERY_WORK_PREFIX = '.reprise/recovery-work';

export function assertRecoveryPathBoundary(changed: readonly string[]): void {
  for (const path of changed) {
    if (path === 'recovery.md' || path === 'recovery-manifest.json' || path === RECOVERY_WORK_PREFIX || path.startsWith(`${RECOVERY_WORK_PREFIX}/`)) continue;
    if (!isRecoveryPath(path)) throw new Error(`Recovery changed an unsafe path: ${path}.`);
  }
}

export async function readRecoveryReport(root: string): Promise<string> {
  const report = await readFile(join(root, 'recovery.md'), 'utf8');
  if (!report.trim()) throw new Error('Recovery report is empty.');
  return report;
}

export function changedPaths(before: EnvironmentFingerprint, after: EnvironmentFingerprint): string[] {
  const index = (fingerprint: EnvironmentFingerprint) => new Map(fingerprint.resources.map((entry) => [entry.path, JSON.stringify(entry)]));
  const initial = index(before);
  const current = index(after);
  return [...new Set([...initial.keys(), ...current.keys()])].filter((path) => !path.startsWith('.git/') && initial.get(path) !== current.get(path)).sort();
}

const RECOVERY_SINK_NAMES = new Set(['recovery.md', 'recovery-manifest.json']);

/** Manifest checks ignore Host sinks that `validateRecovery` unlinks before fingerprinting. */
export function candidateChangedPaths(before: EnvironmentFingerprint, after: EnvironmentFingerprint): string[] {
  return changedPaths(before, after).filter((path) => !RECOVERY_SINK_NAMES.has(path) && !isGeneratedWorkspaceNoise(path));
}

function isGeneratedWorkspaceNoise(path: string): boolean {
  const posix = path.replaceAll("\\", "/");
  return (
    posix.includes("/__pycache__/") ||
    posix.startsWith("__pycache__/") ||
    posix.includes(".pytest_cache/") ||
    posix.startsWith(".pytest_cache/") ||
    posix.endsWith(".pyc")
  );
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Rebuilds a runnable baseline from a published provider copy when the live source is gone. */
export async function loadSealedBaseline(
  caseId: string,
  baselineRoot: string,
  recorded: BaselineMarker,
): Promise<EnvironmentBaseline> {
  if (!(await exists(baselineRoot))) return unsupportedBaseline(caseId);
  const { fingerprint, budget } = await fingerprintTree(baselineRoot);
  const expected = recorded.recovery?.recoveredDigest ?? recorded.sourceFingerprint;
  if (fingerprint.digest !== expected) {
    throw new Error(`Sealed baseline for case ${caseId} does not match its published fingerprint.`);
  }
  const recovery = recorded.recovery;
  const excluded = budget.excludedEntries ?? [];
  return {
    baselineId: `baseline-${caseId}`,
    caseId,
    mode: 'canonical',
    match: recovery
      ? recovery.status === 'ready' || recovery.status === 'recovered' ? 'recovered'
        : recovery.status === 'partial' ? 'recovered_partial'
        : 'current_state_fallback'
      : 'matched',
    resources: [],
    readiness: {
      runnable: budget.blockedReasons.length ? 'blocked' : 'isolated',
      strictness: 'strict',
      blockingResourceIds: budget.blockedReasons.length ? ['workspace-budget'] : [],
    },
    fingerprint,
    budget,
    capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
    warnings: [...budget.blockedReasons, ...excluded.map((item) => `${item.path}: ${item.reasonCode}`)],
    createdAt: new Date().toISOString(),
    root: baselineRoot,
    ...(recovery ? { recovery } : {}),
  };
}

export function unsupportedBaseline(caseId: string): EnvironmentBaseline {
  const fingerprint: EnvironmentFingerprint = { capturedAt: new Date().toISOString(), resources: [], digest: sha256('unsupported') };
  return {
    baselineId: `baseline-${caseId}`,
    caseId,
    mode: 'unsupported',
    match: 'observational',
    resources: [],
    readiness: { runnable: 'unsupported', strictness: 'strict', blockingResourceIds: ['workspace'] },
    fingerprint,
    budget: { fileCount: 0, totalBytes: 0, largestFileBytes: 0, blockedReasons: ['Source workspace is unavailable.'] },
    capabilities: { canFork: false, fingerprints: ['file_tree'], externalSideEffects: 'none' },
    warnings: ['Source workspace is unavailable.'],
    createdAt: new Date().toISOString(),
  };
}

function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EACCES' || code === 'EPERM';
}

async function realPathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error) || isAccessDenied(error)) return resolve(path);
    throw error;
  }
}

/**
 * In-root links are materialized as ordinary files/directories. Out-of-root,
 * missing, cyclic, or unreadable links are skipped and never followed.
 */
async function resolveSafeLink(
  sourceRoot: string,
  linkPath: string,
  chain: ReadonlySet<string>,
): Promise<
  | { action: 'file'; from: string }
  | { action: 'directory'; from: string }
  | { action: 'skip'; reasonCode: WorkspaceExclusion['reasonCode'] }
> {
  let raw: string;
  try {
    raw = await readlink(linkPath);
  } catch (error) {
    if (isMissing(error)) return { action: 'skip', reasonCode: 'workspace.target_missing' };
    if (isAccessDenied(error)) return { action: 'skip', reasonCode: 'workspace.permission_denied' };
    return { action: 'skip', reasonCode: 'workspace.symlink_skipped' };
  }
  const target = resolve(dirname(linkPath), raw);
  const source = resolve(sourceRoot);
  if (target !== source && !isInside(source, target)) return { action: 'skip', reasonCode: 'workspace.symlink_skipped' };
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return { action: 'skip', reasonCode: 'workspace.target_missing' };
    if (isAccessDenied(error)) return { action: 'skip', reasonCode: 'workspace.permission_denied' };
    return { action: 'skip', reasonCode: 'workspace.symlink_skipped' };
  }
  if (info.isSymbolicLink()) {
    if (chain.has(target)) return { action: 'skip', reasonCode: 'workspace.cycle_skipped' };
    return resolveSafeLink(sourceRoot, target, new Set(chain).add(linkPath));
  }
  const identity = await realPathOrResolved(target);
  if (chain.has(identity)) return { action: 'skip', reasonCode: 'workspace.cycle_skipped' };
  if (info.isDirectory()) return { action: 'directory', from: target };
  if (info.isFile()) return { action: 'file', from: target };
  return { action: 'skip', reasonCode: 'workspace.unsupported_entry' };
}


function isRecoveryMarker(value: unknown): value is NonNullable<EnvironmentBaseline['recovery']> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<NonNullable<EnvironmentBaseline['recovery']>>;
  return (item.status === 'ready' || item.status === 'blocked' || item.status === 'recovered' || item.status === 'partial' || item.status === 'insufficient_evidence' || item.status === 'failed')
    && Array.isArray(item.unresolved) && typeof item.sourceDigest === 'string' && typeof item.recoveredDigest === 'string';
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await copyTreeFrom(source, destination, source, new Set());
}

async function copyTreeFrom(
  source: string,
  destination: string,
  sourceRoot: string,
  chain: ReadonlySet<string>,
): Promise<void> {
  const identity = await realPathOrResolved(source);
  if (chain.has(identity)) return;
  const nextChain = new Set(chain).add(identity);
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (isAccessDenied(error) || isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    let info;
    try {
      info = await lstat(from);
    } catch (error) {
      if (isAccessDenied(error) || isMissing(error)) continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      const resolved = await resolveSafeLink(sourceRoot, from, nextChain);
      if (resolved.action === 'skip') continue;
      if (resolved.action === 'directory') {
        await mkdir(to);
        await copyTreeFrom(resolved.from, to, sourceRoot, nextChain);
        continue;
      }
      await writeFile(to, await readFile(resolved.from, { flag: 'r' }), { flag: 'wx' });
      continue;
    }
    if (info.isDirectory()) {
      await mkdir(to);
      await copyTreeFrom(from, to, sourceRoot, nextChain);
    } else if (info.isFile()) {
      try {
        await writeFile(to, await readFile(from, { flag: 'r' }), { flag: 'wx' });
      } catch (error) {
        if (isAccessDenied(error) || isMissing(error)) continue;
        throw error;
      }
    }
  }
}


export function calculateWorkspaceBudget(resources: readonly Pick<FingerprintEntry, 'kind' | 'size'>[]): WorkspaceBudget {
  const totals = resources.filter((resource) => resource.kind === 'file').reduce<FingerprintTotals>((result, resource) => ({
    fileCount: result.fileCount + 1,
    totalBytes: result.totalBytes + resource.size,
    largestFileBytes: Math.max(result.largestFileBytes, resource.size),
  }), { fileCount: 0, totalBytes: 0, largestFileBytes: 0 });
  return workspaceBudgetFromTotals(totals);
}

function workspaceBudgetFromTotals({ fileCount, totalBytes, largestFileBytes }: FingerprintTotals): WorkspaceBudget {
  const blockedReasons = [
    ...(fileCount > SNAPSHOT_LIMITS.files ? [`Source has ${fileCount.toLocaleString()} files; the ${SNAPSHOT_LIMITS.files.toLocaleString()} file snapshot limit prevents an unexpectedly large copy.`] : []),
    ...(totalBytes > SNAPSHOT_LIMITS.totalBytes ? [`Source is ${formatBytes(totalBytes)}; the ${formatBytes(SNAPSHOT_LIMITS.totalBytes)} snapshot limit prevents an unexpectedly large copy.`] : []),
    ...(largestFileBytes > SNAPSHOT_LIMITS.fileBytes ? [`Largest source file is ${formatBytes(largestFileBytes)}; the ${formatBytes(SNAPSHOT_LIMITS.fileBytes)} per-file snapshot limit prevents an unexpectedly large copy.`] : []),
  ];
  return { fileCount, totalBytes, largestFileBytes, blockedReasons };
}

type FingerprintTotals = { fileCount: number; totalBytes: number; largestFileBytes: number };
type FingerprintScan = {
  resources: FingerprintEntry[];
  totals: FingerprintTotals;
  sensitiveFileCounts: Record<SensitiveFileCategory, number>;
  budget: WorkspaceBudget;
};

export async function fingerprintTree(root: string): Promise<{ fingerprint: EnvironmentFingerprint; budget: WorkspaceBudget }> {
  const scan = await scanFingerprintTree(root);
  const metadata = [...scan.resources].sort(compareFingerprintEntries);
  if (scan.budget.blockedReasons.length > 0) {
    return { fingerprint: { capturedAt: new Date().toISOString(), resources: metadata, digest: sha256(JSON.stringify(metadata)) }, budget: scan.budget };
  }
  const resources = await Promise.all(scan.resources.map(async (resource) => {
    if (resource.kind !== 'file') return resource;
    const path = join(root, ...resource.path.split('/'));
    const contentHash = resource.size > MAX_INLINE_HASH_BYTES ? await sha256File(path) : sha256(await readFile(path));
    return { ...resource, contentHash };
  }));
  resources.sort(compareFingerprintEntries);
  return { fingerprint: { capturedAt: new Date().toISOString(), resources, digest: sha256(JSON.stringify(resources)) }, budget: scan.budget };
}

async function scanFingerprintTree(root: string): Promise<FingerprintScan> {
  const resources: FingerprintEntry[] = [];
  const totals = { fileCount: 0, totalBytes: 0, largestFileBytes: 0 };
  const sensitiveFileCounts: Record<SensitiveFileCategory, number> = { env: 0, credential: 0, private_key: 0 };
  const excludedEntries: WorkspaceExclusion[] = [];
  try {
    await collectFingerprintMetadata(root, root, '', resources, totals, sensitiveFileCounts, excludedEntries, new Set());
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
  }
  return {
    resources,
    totals,
    sensitiveFileCounts,
    budget: {
      ...workspaceBudgetFromTotals(totals),
      sensitiveFileCounts,
      ...(excludedEntries.length ? { excludedEntries } : {}),
    },
  };
}

async function collectFingerprintMetadata(
  sourceRoot: string,
  currentDir: string,
  prefix: string,
  resources: FingerprintEntry[],
  totals: { fileCount: number; totalBytes: number; largestFileBytes: number },
  sensitiveFileCounts: Record<SensitiveFileCategory, number>,
  excludedEntries: WorkspaceExclusion[],
  chain: ReadonlySet<string>,
): Promise<void> {
  const identity = await realPathOrResolved(currentDir);
  if (chain.has(identity)) {
    if (prefix) excludedEntries.push({ path: prefix, reasonCode: 'workspace.cycle_skipped' });
    return;
  }
  const nextChain = new Set(chain).add(identity);
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isAccessDenied(error)) {
      if (prefix) excludedEntries.push({ path: prefix, reasonCode: 'workspace.permission_denied' });
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(currentDir, entry.name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isAccessDenied(error) || isMissing(error)) {
        excludedEntries.push({ path: relativePath, reasonCode: isAccessDenied(error) ? 'workspace.permission_denied' : 'workspace.target_missing' });
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      const resolved = await resolveSafeLink(sourceRoot, path, nextChain);
      if (resolved.action === 'skip') {
        excludedEntries.push({ path: relativePath, reasonCode: resolved.reasonCode });
        continue;
      }
      if (resolved.action === 'directory') {
        resources.push({ path: relativePath, kind: 'directory', size: 0 });
        await collectFingerprintMetadata(sourceRoot, resolved.from, relativePath, resources, totals, sensitiveFileCounts, excludedEntries, nextChain);
        continue;
      }
      await recordFingerprintFile(relativePath, entry.name, resolved.from, resources, totals, sensitiveFileCounts);
      continue;
    }
    if (info.isDirectory()) {
      resources.push({ path: relativePath, kind: 'directory', size: 0 });
      await collectFingerprintMetadata(sourceRoot, path, relativePath, resources, totals, sensitiveFileCounts, excludedEntries, nextChain);
    } else if (info.isFile()) {
      try {
        await recordFingerprintFile(relativePath, entry.name, path, resources, totals, sensitiveFileCounts);
      } catch (error) {
        if (isAccessDenied(error) || isMissing(error)) {
          excludedEntries.push({ path: relativePath, reasonCode: isAccessDenied(error) ? 'workspace.permission_denied' : 'workspace.target_missing' });
          continue;
        }
        throw error;
      }
    } else {
      excludedEntries.push({ path: relativePath, reasonCode: 'workspace.unsupported_entry' });
    }
  }
}

async function recordFingerprintFile(
  relativePath: string,
  name: string,
  path: string,
  resources: FingerprintEntry[],
  totals: { fileCount: number; totalBytes: number; largestFileBytes: number },
  sensitiveFileCounts: Record<SensitiveFileCategory, number>,
): Promise<void> {
  const size = (await stat(path)).size;
  totals.fileCount += 1;
  totals.totalBytes += size;
  totals.largestFileBytes = Math.max(totals.largestFileBytes, size);
  const sensitiveCategory = sensitiveFileCategory(name);
  if (sensitiveCategory) sensitiveFileCounts[sensitiveCategory] += 1;
  resources.push({ path: relativePath, kind: 'file', size });
  if (totals.fileCount > SNAPSHOT_LIMITS.files || totals.totalBytes > SNAPSHOT_LIMITS.totalBytes || totals.largestFileBytes > SNAPSHOT_LIMITS.fileBytes) {
    throw new BudgetExceeded();
  }
}


function sensitiveFileCategory(name: string): SensitiveFileCategory | undefined {
  const normalized = name.toLowerCase();
  if (normalized === '.env' || normalized.startsWith('.env.')) return 'env';
  if (normalized === 'auth.json' || normalized === '.credentials.json' || normalized === 'credentials.json' || normalized.includes('credential')) return 'credential';
  if (normalized.endsWith('.pem') || normalized.endsWith('.key') || normalized.endsWith('.p12') || normalized.endsWith('.pfx')) return 'private_key';
  return undefined;
}

class BudgetExceeded extends Error {
  constructor() { super('Workspace snapshot budget exceeded.'); }
}

function compareFingerprintEntries(left: FingerprintEntry, right: FingerprintEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
