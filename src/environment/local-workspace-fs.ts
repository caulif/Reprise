import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { formatBytes } from '../core/format.js';
import { SAFE_ID, sha256, sha256File } from '../core/identity.js';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RecoveryManifestSchema, type RecoveryManifest } from '../core/schema.js';
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
  return (value.status === 'recovered' || value.status === 'partial' || value.status === 'insufficient_evidence')
    && !(value.status === 'recovered' && value.unresolved.length > 0)
    && !((value.status === 'recovered' || value.status === 'partial') && value.evidenceRefs.length === 0)
    && ((value.status === 'insufficient_evidence' && value.manifestPath === undefined) || ((value.status === 'recovered' || value.status === 'partial') && value.manifestPath === 'recovery-manifest.json'))
    && value.reportPath === 'recovery.md' && Array.isArray(value.unresolved) && value.unresolved.every((item) => typeof item === 'string')
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((item) => typeof item === 'string' && /^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item));
}

export async function readRecoveryManifest(root: string, result: RecoveryEnvelope): Promise<RecoveryManifest> {
  if (result.manifestPath !== 'recovery-manifest.json') throw new Error('Recovery manifest is required.');
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, result.manifestPath), 'utf8')) as unknown; }
  catch { throw new Error('Recovery manifest is unreadable.'); }
  if (!Value.Check(RecoveryManifestSchema, value)) throw new Error('Recovery manifest is invalid.');
  return value;
}
export async function validateManifest(
  manifest: RecoveryManifest,
  changed: readonly string[],
  result: RecoveryEnvelope,
  evidence: readonly RecoveryEvidenceVerification[],
  before: EnvironmentFingerprint,
  after: EnvironmentFingerprint,
  root: string,
): Promise<void> {
  const paths = manifest.actions.map((action) => action.path).sort();
  if (manifest.actions.some((action) => !isRecoveryPath(action.path))) throw new Error('Recovery manifest contains an unsafe path.');
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...changed].sort())) throw new Error('Recovery manifest paths must exactly match changed paths.');
  const known = new Map(evidence.map((item) => [item.ref, item]));
  const previous = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  for (const action of manifest.actions) {
    if (action.evidenceRefs.some((ref) => !result.evidenceRefs.includes(ref) || !known.has(ref))) throw new Error('Recovery manifest action uses evidence absent from the envelope.');
    const beforeEntry = previous.get(action.path);
    const afterEntry = current.get(action.path);
    validateActionOperation(action.operation, beforeEntry, afterEntry, action.path);
    validateActionHashes(action.beforeHash, action.afterHash, beforeEntry, afterEntry, action.path);
    if (result.status === 'recovered' && !(await actionHasStrongEvidence(action.path, afterEntry, action.evidenceRefs, known, root))) {
      throw new Error(`Recovered action lacks strong path evidence: ${action.path}.`);
    }
  }
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


function isRecoveryMarker(value: unknown): value is NonNullable<EnvironmentBaseline['recovery']> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<NonNullable<EnvironmentBaseline['recovery']>>;
  return (item.status === 'recovered' || item.status === 'partial' || item.status === 'insufficient_evidence' || item.status === 'failed')
    && Array.isArray(item.unresolved) && typeof item.sourceDigest === 'string' && typeof item.recoveredDigest === 'string';
}

export async function copyTree(source: string, destination: string): Promise<void> {
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
type FingerprintScan = { resources: FingerprintEntry[]; totals: FingerprintTotals; sensitiveFileCounts: Record<SensitiveFileCategory, number>; budget: WorkspaceBudget };

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
  try {
    await collectFingerprintMetadata(root, '', resources, totals, sensitiveFileCounts);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
  }
  return {
    resources,
    totals,
    sensitiveFileCounts,
    budget: { ...workspaceBudgetFromTotals(totals), sensitiveFileCounts },
  };
}

async function collectFingerprintMetadata(
  root: string,
  prefix: string,
  resources: FingerprintEntry[],
  totals: { fileCount: number; totalBytes: number; largestFileBytes: number },
  sensitiveFileCounts: Record<SensitiveFileCategory, number>,
): Promise<void> {
  const entries = await readdir(join(root, ...prefix ? prefix.split('/') : []), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, ...relativePath.split('/'));
    if (entry.isSymbolicLink()) throw new Error(`Environment workspace contains an unsupported symlink: ${path}`);
    if (entry.isDirectory()) {
      resources.push({ path: relativePath, kind: 'directory', size: 0 });
      await collectFingerprintMetadata(root, relativePath, resources, totals, sensitiveFileCounts);
    } else if (entry.isFile()) {
      const size = (await stat(path)).size;
      totals.fileCount += 1;
      totals.totalBytes += size;
      totals.largestFileBytes = Math.max(totals.largestFileBytes, size);
      const sensitiveCategory = sensitiveFileCategory(entry.name);
      if (sensitiveCategory) sensitiveFileCounts[sensitiveCategory] += 1;
      resources.push({ path: relativePath, kind: 'file', size });
      if (totals.fileCount > SNAPSHOT_LIMITS.files || totals.totalBytes > SNAPSHOT_LIMITS.totalBytes || totals.largestFileBytes > SNAPSHOT_LIMITS.fileBytes) {
        throw new BudgetExceeded();
      }
    } else {
      throw new Error(`Unsupported environment entry: ${path}`);
    }
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
