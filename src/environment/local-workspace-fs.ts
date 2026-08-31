import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { formatBytes } from '../core/format.js';
import { SAFE_ID, sha256, sha256File } from '../core/identity.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type RecoveryManifest } from '../core/schema.js';
import { gitFileHash, isRecoveryPath, type RecoveryEvidenceVerification } from '../infrastructure/recovery-tools.js';
import {
  MAX_INLINE_HASH_BYTES,
  SNAPSHOT_LIMITS,
  type EnvironmentBaseline,
  type EnvironmentFingerprint,
  type FingerprintEntry,
  type RecoveryEnvelope,
  type SensitiveFileCategory,
  type WorkspaceBudget,
  type WorkspaceExclusion,
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
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
type BaselineMarker = { sourceFingerprint: string; recovery?: NonNullable<EnvironmentBaseline['recovery']> };

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
  const refsOk = Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((item) => typeof item === 'string' && /^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item));
  const unresolvedOk = Array.isArray(value.unresolved) && value.unresolved.every((item) => typeof item === 'string');
  if (value.reportPath !== 'recovery.md' || !refsOk || !unresolvedOk) return false;
  if (value.status === 'recovered') return value.unresolved.length === 0 && value.evidenceRefs.length > 0;
  return value.status === 'partial' || value.status === 'insufficient_evidence';
}

export function hostManifestFromFingerprint(
  changed: readonly string[],
  before: EnvironmentFingerprint,
  after: EnvironmentFingerprint,
  evidenceRefs: readonly string[],
): RecoveryManifest {
  const previous = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  return {
    actions: changed.map((path) => {
      const beforeEntry = previous.get(path);
      const afterEntry = current.get(path);
      const operation = !beforeEntry && afterEntry ? 'create' : beforeEntry && !afterEntry ? 'delete' : 'modify';
      return {
        operation,
        path,
        evidenceRefs: [...evidenceRefs],
        ...(beforeEntry?.contentHash ? { beforeHash: beforeEntry.contentHash } : {}),
        ...(afterEntry?.contentHash ? { afterHash: afterEntry.contentHash } : {}),
      };
    }),
    unresolved: [],
  };
}

export async function validateManifest(
  _manifest: RecoveryManifest,
  changed: readonly string[],
  result: RecoveryEnvelope,
  evidence: readonly RecoveryEvidenceVerification[],
  before: EnvironmentFingerprint,
  after: EnvironmentFingerprint,
  root: string,
): Promise<readonly string[]> {
  const ownedRefs = result.evidenceRefs.filter((ref) => evidence.some((item) => item.ref === ref));
  const paths = [...changed].sort();
  const known = new Map(evidence.map((item) => [item.ref, item]));
  const previous = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  const actions = hostManifestFromFingerprint(paths, before, after, ownedRefs).actions;
  if (actions.some((action) => !isRecoveryPath(action.path))) throw new Error('Recovery manifest contains an unsafe path.');
  if (result.status === 'recovered' && paths.length === 0) throw new Error('Recovery manifest paths must exactly match changed paths.');
  for (const action of actions) {
    const beforeEntry = previous.get(action.path);
    const afterEntry = current.get(action.path);
    validateActionOperation(action.operation, beforeEntry, afterEntry, action.path);
    validateActionHashes(action.beforeHash, action.afterHash, beforeEntry, afterEntry, action.path);
    if (result.status === 'recovered' && !(await actionHasStrongEvidence(action.path, afterEntry, ownedRefs, known, root))) {
      throw new Error(`Recovered action lacks strong path evidence: ${action.path}.`);
    }
  }
  return [];
}

function validateActionOperation(
  operation: RecoveryManifest['actions'][number]['operation'],
  before: FingerprintEntry | undefined,
  after: FingerprintEntry | undefined,
  path: string,
): void {
  const beforeExists = Boolean(before);
  const afterExists = Boolean(after);
  if ((operation === 'create' && (beforeExists || !afterExists)) || (operation === 'delete' && (!beforeExists || afterExists)) || ((operation === 'modify' || operation === 'restore') && (!beforeExists || !afterExists))) {
    throw new Error(`Recovery manifest operation does not match the observed change: ${path}.`);
  }
}

function validateActionHashes(
  beforeHash: string | undefined,
  afterHash: string | undefined,
  before: FingerprintEntry | undefined,
  after: FingerprintEntry | undefined,
  path: string,
): void {
  if (beforeHash && before?.contentHash !== beforeHash) throw new Error(`Recovery manifest beforeHash does not match: ${path}.`);
  if (afterHash && after?.contentHash !== afterHash) throw new Error(`Recovery manifest afterHash does not match: ${path}.`);
}

async function actionHasStrongEvidence(
  path: string,
  after: FingerprintEntry | undefined,
  refs: readonly string[],
  evidence: ReadonlyMap<string, RecoveryEvidenceVerification>,
  root: string,
): Promise<boolean> {
  for (const ref of refs) {
    const item = evidence.get(ref);
    if (!item) continue;
    if (item.kind === 'checkpoint' && item.path === path && item.entryKind === after?.kind && item.hash === after?.contentHash) return true;
    if (item.kind === 'preimage' && item.path === path && after?.contentHash === item.hash) return true;
    if (item.kind === 'git_commit' && after?.contentHash && await gitFileHash(root, item.commit, path) === after.contentHash) return true;
  }
  return false;
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
  return changedPaths(before, after).filter((path) => !RECOVERY_SINK_NAMES.has(path));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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
  return (item.status === 'recovered' || item.status === 'partial' || item.status === 'insufficient_evidence' || item.status === 'failed')
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
