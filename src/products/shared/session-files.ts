import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isRecord, type JsonRecord } from '../../core/json.js';
import { compareSessionSummaries, type DiscoveryDiagnostic, type DiscoveryDiagnosticCode, type SessionDiscoveryPage, type SessionSummary } from '../contract.js';

const DIRECTORY_CONCURRENCY = 8;
const SUMMARY_INDEX_CACHE_LIMIT = 4;
const summaryIndexCache = new Map<string, Map<string, IndexedSession>>();
let discoveryCacheUnchanged = 0;
let discoveryCacheReread = 0;
const discoveryDetailCounts = new Map<string, number>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SessionFileEntry = { path: string; mtime: number; size: number };
export type SessionFileListing = { readonly entries: readonly SessionFileEntry[]; readonly diagnostics: readonly DiscoveryDiagnostic[] };
export type JsonlSummaryReadOptions = { readonly maxBytes: number; readonly maxLines: number; readonly signal?: AbortSignal };

/** Development-only counters for verifying the bounded in-memory summary cache. */
export function resetSessionDiscoveryCacheStats(): void {
  discoveryCacheUnchanged = 0;
  discoveryCacheReread = 0;
  discoveryDetailCounts.clear();
}

export function sessionDiscoveryCacheStats(): { readonly unchanged: number; readonly reread: number } {
  return { unchanged: discoveryCacheUnchanged, reread: discoveryCacheReread };
}

export function sessionDiscoveryDiagnosticDetails(): Readonly<Record<string, number>> {
  return Object.fromEntries(discoveryDetailCounts);
}

function recordDiscoveryDetail(error: unknown): void {
  const message = errorMessage(error).toLowerCase();
  const detail = message.includes('invalid timestamp') ? 'invalid-timestamp'
    : message.includes('no valid id') || message.includes('no valid session id') ? 'missing-session-id'
    : message.includes('no user message') ? 'missing-user-message'
    : message.includes('invalid jsonl') ? 'partial-head-json'
    : message.includes('exceeds the discovery') || message.includes('head exceeds') || message.includes('line limit') ? 'head-read-limit'
    : message.includes('cannot be read') ? 'head-read-error'
    : 'other';
  discoveryDetailCounts.set(detail, (discoveryDetailCounts.get(detail) ?? 0) + 1);
}

/** A discovery failure that is safe to aggregate without exposing local error details in the TUI. */
export class SessionDiscoveryError extends Error {
  constructor(readonly code: DiscoveryDiagnosticCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionDiscoveryError';
  }
}

/** Returns a canonical UTC instant only for a complete, calendar-valid ISO-8601 timestamp. */
export function validSessionTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, '0'));
  const offset = zone === 'Z' ? undefined : zone!.slice(1).split(':').map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offset && (offset[0]! > 23 || offset[1]! > 59)) return undefined;
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

type DirectoryListing = {
  readonly directories: readonly string[];
  readonly entries: readonly SessionFileEntry[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
};

/** Enumerates session candidates in breadth-first batches with no more than eight open directories. */
export async function listJsonlFiles(root: string, accept: (name: string) => boolean, signal?: AbortSignal): Promise<SessionFileListing> {
  const entries: SessionFileEntry[] = [];
  const diagnostics = new DiscoveryDiagnostics([], root);
  const pending = [root];
  while (pending.length) {
    throwIfAborted(signal);
    const batch = pending.splice(0, DIRECTORY_CONCURRENCY);
    const listings = await Promise.all(batch.map((directory) => listDirectory(directory, root, accept, signal)));
    for (const listing of listings) {
      entries.push(...listing.entries);
      for (const diagnostic of listing.diagnostics) diagnostics.merge(diagnostic);
      pending.push(...listing.directories);
    }
    pending.sort((left, right) => left.localeCompare(right));
  }
  return { entries, diagnostics: diagnostics.values() };
}

async function listDirectory(directory: string, root: string, accept: (name: string) => boolean, signal?: AbortSignal): Promise<DirectoryListing> {
  throwIfAborted(signal);
  const entries: SessionFileEntry[] = [];
  const diagnostics = new DiscoveryDiagnostics([], root);
  const directories: string[] = [];
  let handle;
  try { handle = await opendir(directory); } catch (error) {
    if (directory === root && isMissing(error)) return { entries, directories, diagnostics: diagnostics.values() };
    // A configured root that is not readable is an operator-facing configuration error;
    // child-directory failures remain non-fatal discovery diagnostics.
    if (directory === root) throw error;
    diagnostics.add('unreadable-directory', directory);
    return { entries, directories, diagnostics: diagnostics.values() };
  }
  try {
    for await (const entry of handle) {
      throwIfAborted(signal);
      const path = join(directory, entry.name);
      // Never recurse through reparse points: a linked directory can escape the configured
      // root or form a cycle, and session discovery has no need to follow it.
      if (entry.isSymbolicLink()) {
        diagnostics.add('unsupported-entry', path);
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) {
        diagnostics.add('unsupported-entry', path);
        continue;
      }
      if (!accept(entry.name)) continue;
      try {
        const info = await stat(path);
        if (info.isFile()) entries.push({ path, mtime: info.mtimeMs, size: info.size });
        else diagnostics.add('unsupported-entry', path);
      } catch {
        diagnostics.add('unreadable-file', path);
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    diagnostics.add('unreadable-directory', directory);
  }
  return { entries, directories, diagnostics: diagnostics.values() };
}

export async function forEachJsonlHeadSummaryLine(path: string, product: string, options: JsonlSummaryReadOptions, onRow: (row: JsonRecord, line: number) => void): Promise<void> {
  throwIfAborted(options.signal);
  const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: Math.max(0, options.maxBytes - 1) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      throwIfAborted(options.signal);
      if (!line.trim()) continue;
      lineNumber += 1;
      if (lineNumber > options.maxLines) throw new SessionDiscoveryError('too-large', `${product} session head exceeds the line limit: ${path}`);
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch (error) {
        if (stream.bytesRead >= options.maxBytes) break;
        throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} has invalid JSONL at line ${lineNumber}: ${errorMessage(error)}`, { cause: error });
      }
      if (!isRecord(parsed)) throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} has a non-object row at line ${lineNumber}`);
      onRow(parsed, lineNumber - 1);
    }
  } catch (error) {
    if (error instanceof SessionDiscoveryError || isAbortError(error)) throw error;
    throw new SessionDiscoveryError('unreadable-file', `${product} session cannot be read: ${path}`, { cause: error });
  } finally { lines.close(); stream.destroy(); }
  if (!lineNumber) throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} is empty.`);
}

export async function forEachJsonlSummaryLine(path: string, product: string, options: JsonlSummaryReadOptions, onRow: (row: JsonRecord, line: number) => void): Promise<void> {
  throwIfAborted(options.signal);
  let info;
  try { info = await stat(path); } catch (error) { throw new SessionDiscoveryError('unreadable-file', `${product} session cannot be read: ${path}`, { cause: error }); }
  if (!info.isFile()) throw new SessionDiscoveryError('unsupported-entry', `${product} session is not a file: ${path}`);
  if (info.size > options.maxBytes) throw new SessionDiscoveryError('too-large', `${product} session exceeds the discovery limit: ${path}`);
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let any = false;
  try {
    for await (const line of lines) {
      throwIfAborted(options.signal);
      if (!line.trim()) continue;
      lineNumber += 1;
      if (lineNumber > options.maxLines) throw new SessionDiscoveryError('too-large', `${product} session exceeds the discovery line limit: ${path}`);
      any = true;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch (error) {
        throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} has invalid JSONL at line ${lineNumber}: ${errorMessage(error)}`, { cause: error });
      }
      if (!isRecord(parsed)) throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} has invalid JSONL at line ${lineNumber}: row is not an object`);
      onRow(parsed, lineNumber - 1);
    }
  } catch (error) {
    if (error instanceof SessionDiscoveryError || isAbortError(error)) throw error;
    throw new SessionDiscoveryError('unreadable-file', `${product} session cannot be read: ${path}`, { cause: error });
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!any) throw new SessionDiscoveryError('invalid-jsonl', `${product} session ${path} is empty.`);
}

export async function readSessionFile(path: string, product: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${product} session is not a file: ${path}`);
  if (info.size > maxBytes) throw new Error(`${product} session exceeds the ${maxBytes / 1024 / 1024} MiB inspection limit: ${path}`);
  return readFile(path);
}

export function parseJsonlRows(bytes: Buffer, sourcePath: string, product: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('row is not an object');
      rows.push(parsed);
    } catch (error) {
      throw new Error(`${product} session ${sourcePath} has invalid JSONL at line ${index + 1}: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (!rows.length) throw new Error(`${product} session ${sourcePath} is empty.`);
  return rows;
}

type DiscoveryCursor = { readonly version: 2; readonly root: string; readonly fingerprint: string; readonly path: string };
type IndexedSession = { readonly entry: SessionFileEntry; readonly session?: SessionSummary; readonly errorCode?: DiscoveryDiagnosticCode; readonly excluded?: true };

export type DiscoverSessionPageInput = {
  readonly root: string;
  readonly ranked: readonly SessionFileEntry[];
  readonly limit: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
  /** Product-scoped key for the bounded in-memory summary index. */
  readonly cacheKey?: string;
  /** Discards the matching in-memory index before rebuilding it. */
  readonly refresh?: boolean;
  /** Discovery-index diagnostics repeated with every page, so pagination never double counts them. */
  readonly diagnostics?: readonly DiscoveryDiagnostic[];
  readonly inspect: (entry: SessionFileEntry) => Promise<SessionSummary>;
  /** Optional safe list-level fallback for files exceeding the complete-summary limits. */
  readonly inspectPartial?: (entry: SessionFileEntry, signal: AbortSignal | undefined) => Promise<SessionSummary>;
  readonly exclude?: (session: SessionSummary) => boolean;
};

/** Builds a bounded, product-neutral summary index before applying globally ordered cursor pages. */
export async function discoverSessionPage(input: DiscoverSessionPageInput): Promise<SessionDiscoveryPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error('Session discovery limit must be a positive integer.');
  throwIfAborted(input.signal);
  const root = fingerprintRoot(input.root);
  const fingerprint = fingerprintRankedEntries(input.ranked);
  const cursor = decodeCursor(input.cursor, root, fingerprint);
  const indexDiagnostics = new DiscoveryDiagnostics(input.diagnostics, input.root);
  const cacheKey = input.cacheKey ? `${input.cacheKey}\0${root}` : undefined;
  const indexed = await loadSummaryIndex(input.ranked, input.inspect, input.inspectPartial, input.signal, cacheKey, input.refresh);
  const summaries: SessionSummary[] = [];
  for (const result of indexed) {
    if (result.errorCode) indexDiagnostics.add(result.errorCode, result.entry.path);
    else if (result.session && input.exclude?.(result.session)) indexDiagnostics.add('excluded', result.entry.path);
    else if (result.session) summaries.push(result.session);
  }
  summaries.sort(compareSessionSummaries);
  const start = cursor ? summaries.findIndex((session) => session.sourcePath === cursor.path) + 1 : 0;
  if (cursor && start === 0) throw new Error('Session discovery cursor is stale for this root.');
  const items = summaries.slice(start, start + input.limit);
  const diagnostics = indexDiagnostics.values();
  const hasMore = start + items.length < summaries.length;
  const last = items.at(-1);
  return {
    items,
    ...(hasMore && last ? { nextCursor: encodeCursor({ version: 2, root, fingerprint, path: last.sourcePath }) } : {}),
    scanned: input.ranked.length,
    skipped: indexDiagnostics.count(),
    diagnostics,
    ...(diagnostics.length ? { rootDiagnostics: diagnostics } : {}),
  };
}

async function loadSummaryIndex(
  entries: readonly SessionFileEntry[],
  inspect: (entry: SessionFileEntry) => Promise<SessionSummary>,
  inspectPartial: ((entry: SessionFileEntry, signal: AbortSignal | undefined) => Promise<SessionSummary>) | undefined,
  signal: AbortSignal | undefined,
  cacheKey: string | undefined,
  refresh: boolean | undefined,
): Promise<readonly IndexedSession[]> {
  if (cacheKey && refresh) summaryIndexCache.delete(cacheKey);
  const cached = cacheKey ? summaryIndexCache.get(cacheKey) : undefined;
  const previous = cached ?? new Map<string, IndexedSession>();
  const current = new Map<string, IndexedSession>();
  for (let start = 0; start < entries.length; start += DIRECTORY_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = entries.slice(start, start + DIRECTORY_CONCURRENCY);
    const results = await Promise.all(batch.map(async (entry) => {
      const old = previous.get(entry.path);
      if (old && old.entry.size === entry.size && old.entry.mtime === entry.mtime) {
        discoveryCacheUnchanged += 1;
        return old;
      }
      discoveryCacheReread += 1;
      return indexSessionSummary(entry, inspect, inspectPartial, signal);
    }));
    for (const result of results) current.set(result.entry.path, result);
  }
  if (cacheKey) cacheSummaryIndex(cacheKey, current);
  return [...current.values()];
}

async function indexSessionSummary(entry: SessionFileEntry, inspect: (entry: SessionFileEntry) => Promise<SessionSummary>, inspectPartial: ((entry: SessionFileEntry, signal: AbortSignal | undefined) => Promise<SessionSummary>) | undefined, signal: AbortSignal | undefined): Promise<IndexedSession> {
  try {
    return { entry, session: await inspect(entry) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (inspectPartial && error instanceof SessionDiscoveryError && error.code === 'too-large') {
      try { return { entry, session: await inspectPartial(entry, signal) }; }
      catch (partialError) {
        if (isAbortError(partialError)) throw partialError;
        recordDiscoveryDetail(partialError);
      }
    }
    recordDiscoveryDetail(error);
    return { entry, errorCode: discoveryErrorCode(error) };
  }
}

function cacheSummaryIndex(cacheKey: string, indexed: Map<string, IndexedSession>): void {
  summaryIndexCache.delete(cacheKey);
  summaryIndexCache.set(cacheKey, indexed);
  while (summaryIndexCache.size > SUMMARY_INDEX_CACHE_LIMIT) summaryIndexCache.delete(summaryIndexCache.keys().next().value!);
}

function discoveryErrorCode(error: unknown): DiscoveryDiagnosticCode {
  if (error instanceof SessionDiscoveryError) return error.code;
  const message = errorMessage(error).toLowerCase();
  if (message.includes('inspection limit') || message.includes('exceeds the')) return 'too-large';
  if (message.includes('eacces') || message.includes('eperm') || message.includes('enoent') || message.includes('not a file')) return 'unreadable-file';
  if (message.includes('jsonl')) return 'invalid-jsonl';
  return 'invalid-metadata';
}

class DiscoveryDiagnostics {
  readonly #entries = new Map<DiscoveryDiagnosticCode, { count: number; samplePath?: string }>();

  constructor(initial: readonly DiscoveryDiagnostic[] = [], private readonly root?: string) {
    for (const entry of initial) this.#entries.set(entry.code, { count: entry.count, ...(entry.samplePath ? { samplePath: entry.samplePath } : {}) });
  }

  add(code: DiscoveryDiagnosticCode, samplePath?: string): void {
    const existing = this.#entries.get(code);
    const firstPath = existing?.samplePath ?? diagnosticRelativePath(this.root, samplePath);
    this.#entries.set(code, { count: (existing?.count ?? 0) + 1, ...(firstPath ? { samplePath: firstPath } : {}) });
  }

  merge(diagnostic: DiscoveryDiagnostic): void {
    const existing = this.#entries.get(diagnostic.code);
    const samplePath = existing?.samplePath ?? diagnostic.samplePath;
    this.#entries.set(diagnostic.code, { count: (existing?.count ?? 0) + diagnostic.count, ...(samplePath ? { samplePath } : {}) });
  }

  count(): number { return [...this.#entries.values()].reduce((total, entry) => total + entry.count, 0); }

  values(): readonly DiscoveryDiagnostic[] {
    return [...this.#entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, entry]) => ({ code, count: entry.count, ...(entry.samplePath ? { samplePath: entry.samplePath } : {}) }));
  }
}

function fingerprintRoot(root: string): string { return resolve(root).replaceAll('\\', '/').toLowerCase(); }
function fingerprintRankedEntries(entries: readonly SessionFileEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.mtime}\0${entry.size}\n`);
  return hash.digest('base64url');
}
function diagnosticRelativePath(root: string | undefined, path: string | undefined): string | undefined {
  if (!root || !path) return path;
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith('..\\') || value.startsWith('../') || isAbsolute(value)) return undefined;
  return value.replaceAll('\\', '/');
}
function encodeCursor(cursor: DiscoveryCursor): string { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'); }

function decodeCursor(value: string | undefined, root: string, fingerprint: string): DiscoveryCursor | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch (error) {
    throw new Error(`Session discovery cursor is invalid: ${errorMessage(error)}`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 2 || parsed.root !== root || parsed.fingerprint !== fingerprint || typeof parsed.path !== 'string') throw new Error('Session discovery cursor is stale for this root.');
  return { version: 2, root, fingerprint, path: parsed.path };
}

function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new DOMException('Session discovery was cancelled.', 'AbortError'); }
