import { lstat, mkdir, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ManagedSessionReceiptSchema, type ManagedSessionReceipt, type CandidateLaunchContext, type CandidateSessionHandle } from '../core/schema.js';
import { sha256, writeAtomic } from '../core/identity.js';
import { pathContainedBy, sameFsPath } from '../core/paths.js';
import type { TargetRunner } from '../core/runtime.js';
import { discoverProductSessions } from '../products/history/discover.js';
import { compareSessionSummaries } from '../products/history/normalize.js';
import { sessionGroupingKey } from '../products/shared/session-project.js';
import type { ProductHistoryReader, SessionDiscoveryPage, SessionInspection, SessionRef, SessionSummary, DiscoveryDiagnostic, SessionDiscoveryQuery } from '../products/contract.js';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const archiveRoot = (dataDir: string) => join(resolve(dataDir), 'managed-sessions');
const archiveKey = (productId: string, sessionId: string) => sha256(JSON.stringify([productId, sessionId]));
export const managedProjectKey = (productId: string) => `reprise-managed:${productId}`;

async function ownedRoot(dataDir: string): Promise<string> {
  const root = archiveRoot(dataDir);
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !pathContainedBy(await realpath(dataDir), await realpath(root))) throw new Error('Invalid managed session archive root.');
  return root;
}

async function writeReceipt(dataDir: string, receipt: ManagedSessionReceipt, signal?: AbortSignal): Promise<void> {
  if (!Value.Check(ManagedSessionReceiptSchema, receipt)) throw new Error('Invalid managed session receipt.');
  const root = await ownedRoot(dataDir);
  await writeAtomic(join(root, `${archiveKey(receipt.productId, receipt.sessionId)}.json`), JSON.stringify(receipt), signal);
}

export async function bindManagedSession(dataDir: string, launch: CandidateLaunchContext, runner: TargetRunner): Promise<ManagedSessionReceipt | undefined> {
  const source = runner.historySource?.();
  const session = runner.session();
  if (!source || session.sessionId === 'unstarted') return undefined;
  const receipt: ManagedSessionReceipt = {
    schemaVersion: 1, productId: session.productId, sessionId: session.sessionId,
    experimentId: launch.experimentId, runId: launch.runId, role: 'candidate', origin: 'reprise',
    workspaceRoot: launch.workspaceRoot, nativeRoot: resolve(source.root), requestedModel: launch.requestedModel,
    createdAt: new Date().toISOString(), status: 'recording',
    ...(source.sourcePath ? { nativeSourcePath: source.sourcePath } : {}),
  };
  await writeReceipt(dataDir, receipt);
  return receipt;
}

async function locateNativeSource(root: string, session: Pick<CandidateSessionHandle, 'sessionId'>, hint: string | undefined, signal: AbortSignal): Promise<string> {
  if (hint) {
    if (!hint.endsWith('.jsonl')) throw new Error('Native history path is not a JSONL transcript.');
    if (!pathContainedBy(root, resolve(hint))) throw new Error('Native history path escapes configured root.');
    return resolve(hint);
  }
  const pending = [root];
  let scanned = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++scanned > 100_000) throw new Error('Native history directory exceeds lookup limit.');
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && (entry.name === `${session.sessionId}.jsonl` || entry.name.endsWith(`-${session.sessionId}.jsonl`))) return path;
    }
  }
  throw Object.assign(new Error('Native transcript was not found.'), { code: 'ENOENT' });
}

export async function archiveManagedSession(input: {
  dataDir: string; receipt: ManagedSessionReceipt; runner: TargetRunner; history: ProductHistoryReader;
  redactions: readonly string[]; signal: AbortSignal;
}): Promise<ManagedSessionReceipt> {
  const { receipt, runner, history, signal } = input;
  try {
    signal.throwIfAborted();
    const source = runner.historySource?.();
    if (!source || !sameFsPath(source.root, receipt.nativeRoot)) throw new Error('Native transcript root changed.');
    const path = await locateNativeSource(receipt.nativeRoot, runner.session(), source.sourcePath, signal);
    if (!path.endsWith('.jsonl') || !pathContainedBy(await realpath(receipt.nativeRoot), await realpath(path))) throw new Error('Invalid native transcript source.');
    const before = await stat(path);
    if (!before.isFile() || before.size > MAX_ARCHIVE_BYTES) throw new Error('Native transcript exceeds archive size limit.');
    const inspection = await history.inspect({ productId: receipt.productId, sessionId: receipt.sessionId, sourcePath: path });
    if (inspection.productId !== receipt.productId || inspection.sessionId !== receipt.sessionId || !inspection.cwd || !sameFsPath(inspection.cwd, receipt.workspaceRoot)) throw new Error('Native transcript workspace mismatch.');
    const raw = await readFile(path, { signal });
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || raw.length !== before.size) throw new Error('Native transcript changed during archive.');
    const bytes = input.redactions.length ? Buffer.from(input.redactions.reduce((text, secret) => {
      const encoded = JSON.stringify(secret).slice(1, -1);
      const redacted = text.split(encoded).join('[REDACTED]');
      return encoded === secret ? redacted : redacted.split(secret).join('[REDACTED]');
    }, raw.toString('utf8'))) : raw;
    const root = await ownedRoot(input.dataDir);
    const destination = join(root, `${archiveKey(receipt.productId, receipt.sessionId)}.jsonl`);
    signal.throwIfAborted();
    let preview: ManagedSessionReceipt['preview'];
    const pending = join(root, `${archiveKey(receipt.productId, receipt.sessionId)}.pending.jsonl`);
    try {
      await writeAtomic(pending, bytes, signal);
      const verified = await history.inspect({ productId: receipt.productId, sessionId: receipt.sessionId, sourcePath: pending });
      if (verified.productId !== receipt.productId || verified.sessionId !== receipt.sessionId || !verified.cwd || !sameFsPath(verified.cwd, receipt.workspaceRoot)) throw new Error('Archived transcript workspace mismatch.');
      preview = { signals: verified.signals, ...(verified.model ? { model: verified.model } : {}), ...(verified.summary ? { summary: verified.summary.slice(0, 512) } : {}), ...(verified.startedAt ? { startedAt: verified.startedAt } : {}), ...(verified.updatedAt ? { updatedAt: verified.updatedAt } : {}) };
      signal.throwIfAborted();
      await writeAtomic(destination, bytes, signal);
    } finally { await unlink(pending).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }); }
    const archived: ManagedSessionReceipt = { ...receipt, status: 'archived', byteLength: bytes.length, digest: sha256(bytes), archivedAt: new Date().toISOString(), ...(preview ? { preview } : {}) };
    await writeReceipt(input.dataDir, archived, signal);
    return archived;
  } catch (error) {
    signal.throwIfAborted();
    const unavailable: ManagedSessionReceipt = { ...receipt, status: 'unavailable', diagnostic: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'native-transcript-missing' : 'native-transcript-archive-failed' };
    await writeReceipt(input.dataDir, unavailable, signal);
    return unavailable;
  }
}

async function readReceipts(dataDir: string, productId: string): Promise<{ receipts: ManagedSessionReceipt[]; diagnostics: DiscoveryDiagnostic[] }> {
  const root = archiveRoot(dataDir);
  let entries;
  try { entries = await readdir(root); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { receipts: [], diagnostics: [] };
    throw error;
  }
  if ((await lstat(root)).isSymbolicLink() || !pathContainedBy(await realpath(dataDir), await realpath(root))) throw new Error('Invalid managed session archive root.');
  const receipts: ManagedSessionReceipt[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  for (const name of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(root, name);
    let contents: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid managed session receipt path.');
      if (info.size > 64 * 1024) {
        diagnostics.push({ code: 'too-large', count: 1, samplePath: path });
        continue;
      }
      contents = await readFile(path, 'utf8');
    } catch {
      // A single inaccessible or replaced receipt must not hide other local sessions.
      diagnostics.push({ code: 'unreadable-file', count: 1, samplePath: path });
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(contents); } catch {
      // Interrupted/externally edited sidecars remain visible as discovery diagnostics.
      diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: path });
      continue;
    }
    if (!Value.Check(ManagedSessionReceiptSchema, value) || name !== `${archiveKey(value.productId, value.sessionId)}.json`) {
      diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: path });
      continue;
    }
    if (value.productId === productId) receipts.push(value);
  }
  return { receipts, diagnostics };
}

function managedSummary(receipt: ManagedSessionReceipt, sourcePath: string, inspection?: SessionSummary): SessionSummary {
  const updatedAt = inspection?.updatedAt ?? receipt.preview?.updatedAt;
  const model = inspection?.model ?? receipt.preview?.model;
  return {
    productId: receipt.productId, sessionId: receipt.sessionId,
    signals: inspection?.signals ?? receipt.preview?.signals ?? { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    sourcePath, cwd: receipt.workspaceRoot, ...(model ? { model } : {}),
    projectKey: managedProjectKey(receipt.productId),
    managed: { experimentId: receipt.experimentId, runId: receipt.runId, role: receipt.role, origin: receipt.origin, status: receipt.status },
    summary: inspection?.summary ?? receipt.preview?.summary ?? `${receipt.experimentId} / ${receipt.runId}`,
    availability: inspection?.availability ?? (receipt.status === 'archived' ? 'indexed' : 'unindexed'),
    recoveryReadiness: inspection?.recoveryReadiness ?? 'pending',
    ...(!inspection && !receipt.preview ? { partial: true } : {}),
    startedAt: inspection?.startedAt ?? receipt.preview?.startedAt ?? receipt.createdAt,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export async function inspectManagedSession(dataDir: string, history: ProductHistoryReader, ref: SessionRef): Promise<SessionInspection | undefined> {
  const receipt = (await readReceipts(dataDir, ref.productId)).receipts.find(item => item.sessionId === ref.sessionId);
  if (!receipt) {
    if (ref.sourcePath && pathContainedBy(archiveRoot(dataDir), resolve(ref.sourcePath))) throw new Error('Managed session receipt missing.');
    return undefined;
  }
  const path = join(archiveRoot(dataDir), `${archiveKey(receipt.productId, receipt.sessionId)}.jsonl`);
  if (ref.sourcePath && !sameFsPath(ref.sourcePath, path)) throw new Error('Managed session source mismatch.');
  return inspectReceipt(dataDir, history, ref, receipt);
}

async function inspectReceipt(dataDir: string, history: ProductHistoryReader, ref: SessionRef, receipt: ManagedSessionReceipt): Promise<SessionInspection> {
  const path = join(archiveRoot(dataDir), `${archiveKey(receipt.productId, receipt.sessionId)}.jsonl`);
  if (receipt.status !== 'archived') {
    const native = await locateNativeSource(receipt.nativeRoot, receipt, receipt.nativeSourcePath, new AbortController().signal);
    if (!pathContainedBy(await realpath(receipt.nativeRoot), await realpath(native))) throw new Error('Native transcript path escapes configured root.');
    const inspection = await history.inspect({ productId: ref.productId, sessionId: ref.sessionId, sourcePath: native });
    if (inspection.productId !== receipt.productId || inspection.sessionId !== receipt.sessionId || !inspection.cwd || !sameFsPath(inspection.cwd, receipt.workspaceRoot)) throw new Error('Native transcript workspace mismatch.');
    return { ...inspection, ...managedSummary(receipt, path, inspection) };
  }
  if (!pathContainedBy(await realpath(archiveRoot(dataDir)), await realpath(path))) throw new Error('Managed transcript path escapes archive.');
  const info = await stat(path);
  if (info.size > MAX_ARCHIVE_BYTES || info.size !== receipt.byteLength) throw new Error('Managed transcript integrity mismatch.');
  const bytes = await readFile(path);
  if (bytes.length !== receipt.byteLength || sha256(bytes) !== receipt.digest) throw new Error('Managed transcript integrity mismatch.');
  const inspection = await history.inspect({ ...ref, sourcePath: path });
  if (inspection.productId !== receipt.productId || inspection.sessionId !== receipt.sessionId || !inspection.cwd || !sameFsPath(inspection.cwd, receipt.workspaceRoot)) throw new Error('Managed transcript identity mismatch.');
  return { ...inspection, ...managedSummary(receipt, path, inspection) };
}

export async function mergeManagedSessions(dataDir: string, productId: string, _history: ProductHistoryReader, page: SessionDiscoveryPage): Promise<SessionDiscoveryPage> {
  const { receipts, diagnostics } = await readReceipts(dataDir, productId);
  if (!receipts.length && !diagnostics.length) return page;
  const items = new Map(page.items.map(item => [item.sessionId, item]));
  for (const receipt of receipts) {
    const path = join(archiveRoot(dataDir), `${archiveKey(productId, receipt.sessionId)}.jsonl`);
    let summary = managedSummary(receipt, path, receipt.status === 'archived' ? undefined : items.get(receipt.sessionId));
    if (receipt.status === 'archived') {
      try {
        if (!pathContainedBy(await realpath(archiveRoot(dataDir)), await realpath(path))) throw new Error('Invalid archive path.');
        const info = await stat(path);
        if (!info.isFile() || info.size !== receipt.byteLength || info.size > MAX_ARCHIVE_BYTES) throw new Error('Invalid archive size.');
      } catch {
        // Listing checks the sidecar and file metadata; full integrity is verified only when opened.
        summary = { ...summary, availability: 'unreadable', recoveryReadiness: 'corrupt' };
        diagnostics.push({ code: 'unreadable-file', count: 1, samplePath: path });
      }
    }
    items.set(receipt.sessionId, summary);
  }
  const nativeProjects = page.projects ?? [...new Map(page.items.filter(session => !receipts.some(receipt => receipt.sessionId === session.sessionId)).map(session => {
    const key = sessionGroupingKey(session);
    return [key, { key, label: session.cwd ?? session.sourcePath, ...(session.cwd ? { path: session.cwd } : {}) }] as const;
  })).values()];
  return { ...page, items: [...items.values()],
    diagnostics: [...page.diagnostics, ...diagnostics], rootDiagnostics: [...(page.rootDiagnostics ?? page.diagnostics), ...diagnostics],
    projects: [...nativeProjects, ...(receipts.length ? [{ key: managedProjectKey(productId), label: 'Reprise' }] : [])],
  };
}

export async function assertNotManagedImport(dataDir: string, ref: SessionRef): Promise<void> {
  if ((await readReceipts(dataDir, ref.productId)).receipts.some(item => item.sessionId === ref.sessionId)) throw new Error('Managed candidate sessions are read-only run evidence; import the original task instead.');
}

export async function discoverManagedSessions(dataDir: string, productId: string, history: ProductHistoryReader, query: SessionDiscoveryQuery): Promise<SessionDiscoveryPage> {
  query.signal?.throwIfAborted();
  const { receipts } = await readReceipts(dataDir, productId);
  if (!receipts.length) return mergeManagedSessions(dataDir, productId, history, await discoverProductSessions(history, { ...query, dataDir }));
  const { limit, cursor, ...fullQuery } = query;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('Session discovery limit must be a positive integer.');
  const native = await discoverProductSessions(history, { ...fullQuery, dataDir });
  const merged = await mergeManagedSessions(dataDir, productId, history, native);
  query.signal?.throwIfAborted();
  const ordered = merged.items.filter(item => !query.excludeSessionIds?.includes(item.sessionId)
    && !query.excludeSourcePaths?.some(path => sameFsPath(path, item.sourcePath))).sort(compareSessionSummaries);
  const fingerprint = sha256(JSON.stringify([resolve(query.root ?? history.defaultRoot), productId, query.excludeSessionIds, query.excludeSourcePaths, query.excludeRoots, ordered.map(item => [item.sessionId, item.sourcePath, item.updatedAt, item.managed?.status])]));
  let offset = 0;
  if (cursor) {
    const match = /^managed-v1:([a-f0-9]{64}):(\d+)$/.exec(cursor);
    if (!match || match[1] !== fingerprint || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > ordered.length) throw new Error('Session discovery cursor is stale for this root.');
    offset = Number(match[2]);
  }
  const items = ordered.slice(offset, offset + (limit ?? ordered.length));
  const next = offset + items.length;
  const { nextCursor: _nativeCursor, ...page } = merged;
  return { ...page, items, ...(next < ordered.length ? { nextCursor: `managed-v1:${fingerprint}:${next}` } : {}) };
}
