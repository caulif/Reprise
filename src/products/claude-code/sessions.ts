import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SAFE_ID } from '../../core/identity.js';
import { pathContainedBy } from '../../core/paths.js';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import { discoverSessionPage, forEachJsonlSummaryLine, listJsonlFiles, SessionDiscoveryError, parseJsonlRows, readSessionFile, type SessionFileEntry, validSessionTimestamp } from '../shared/session-files.js';
import type {
  ImportDiagnostic,
  ImportedSession,
  SessionDiscoveryPage,
  SessionDiscoveryQuery,
  SessionInspection,
  SessionMessage,
  SessionRef,
  SessionSourceAdapter,
  SessionSummary,
} from '../contract.js';

const PRODUCT_ID = 'claude-code';
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_LINES = 50_000;
const SKIP_TYPES = new Set([
  'attachment', 'last-prompt', 'mode', 'permission-mode', 'ai-title', 'custom-title',
  'agent-name', 'file-history-snapshot', 'file-history-delta', 'queue-operation',
]);
const META_FLAGS = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain'] as const;
const ClaudeHistoryEntrySchema = Type.Object({ sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: true });

export function defaultClaudeSessionsRoot(configDir = process.env.CLAUDE_CONFIG_DIR): string {
  return join(configDir?.trim() || join(homedir(), '.claude'), 'projects');
}

export const claudeSessionAdapter: SessionSourceAdapter = {
  get defaultRoot() { return defaultClaudeSessionsRoot(); },
  discover(query?: SessionDiscoveryQuery) {
    return discoverClaudeSessionPage({ ...query, root: query?.root ?? defaultClaudeSessionsRoot() });
  },
  inspect(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Claude session inspect requires a sourcePath.');
    return inspectClaudeSession(ref.sourcePath);
  },
  import(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Claude session import requires a sourcePath.');
    return importClaudeSession(ref.sourcePath);
  },
};

/** Compatibility wrapper for callers that only need the first page of Claude sessions. */
export async function discoverClaudeSessions(sessionsRoot: string, limit = 50, excludeRoots?: readonly string[]): Promise<readonly SessionSummary[]> {
  return (await discoverClaudeSessionPage({ root: sessionsRoot, limit, ...(excludeRoots ? { excludeRoots } : {}) })).items;
}

async function discoverClaudeSessionPage(query: SessionDiscoveryQuery): Promise<SessionDiscoveryPage> {
  const root = resolve(query.root ?? defaultClaudeSessionsRoot());
  const listing = await listJsonlFiles(root, (name) => name.endsWith('.jsonl'), query.signal);
  const transcriptIds = await collectClaudeTranscriptIds(listing.entries, query.signal);
  const history = await loadClaudeHistoryEntries(join(dirname(root), 'history.jsonl'), transcriptIds, query.signal);
  const ranked = [
    ...listing.entries,
    ...history.entries.map((entry) => ({ path: historyLocator(entry.historyPath, entry.sessionId), mtime: entry.timestampMs, size: 0 })),
  ].sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  return discoverSessionPage({
    root,
    ranked,
    // An omitted limit builds the complete catalog; explicit limits remain compatibility API.
    limit: query.cursor ? (query.limit ?? 50) : (query.limit ?? ranked.length + 1),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.signal ? { signal: query.signal } : {}),
    cacheKey: 'claude-code',
    ...(query.refresh ? { refresh: true } : {}),
    diagnostics: [...listing.diagnostics, ...history.diagnostics],
    inspect: (entry) => summarizeClaudeSource(entry, query.signal, history.entries),
    exclude: (session) => excludedCwd(session.cwd, query.excludeRoots),
  });
}

type ClaudeHistoryEntry = {
  readonly sessionId: string;
  readonly display: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly timestampMs: number;
  readonly historyPath: string;
};

const HISTORY_LOCATOR_MARKER = '#reprise-history=';

function historyLocator(historyPath: string, sessionId: string): string {
  return `${historyPath}${HISTORY_LOCATOR_MARKER}${encodeURIComponent(sessionId)}`;
}

function historyLocatorSessionId(sourcePath: string): string | undefined {
  const marker = sourcePath.lastIndexOf(HISTORY_LOCATOR_MARKER);
  if (marker < 0) return undefined;
  try {
    const sessionId = decodeURIComponent(sourcePath.slice(marker + HISTORY_LOCATOR_MARKER.length));
    return SAFE_ID.test(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function historyPathFromLocator(sourcePath: string): string | undefined {
  const marker = sourcePath.lastIndexOf(HISTORY_LOCATOR_MARKER);
  return marker < 0 ? undefined : sourcePath.slice(0, marker);
}

async function collectClaudeTranscriptIds(entries: readonly SessionFileEntry[], signal: AbortSignal | undefined): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    try {
      await forEachJsonlSummaryLine(entry.path, 'Claude transcript metadata', { maxBytes: MAX_SUMMARY_BYTES, maxLines: MAX_SUMMARY_LINES, ...(signal ? { signal } : {}) }, (row) => {
        const sessionId = text(row.sessionId);
        if (sessionId && SAFE_ID.test(sessionId)) ids.add(sessionId);
      });
    } catch (error) {
      if (error instanceof SessionDiscoveryError && error.code === 'too-large') continue;
      throw error;
    }
    const fileId = basename(entry.path, '.jsonl');
    if (SAFE_ID.test(fileId)) ids.add(fileId);
  }
  return ids;
}

async function loadClaudeHistoryEntries(historyPath: string, transcriptIds: ReadonlySet<string>, signal: AbortSignal | undefined): Promise<{ entries: readonly ClaudeHistoryEntry[]; diagnostics: readonly { code: 'invalid-metadata' | 'unreadable-file' | 'invalid-jsonl' | 'too-large'; count: number }[] }> {
  try {
    const info = await stat(historyPath);
    if (!info.isFile()) return { entries: [], diagnostics: [] };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { entries: [], diagnostics: [] };
    return { entries: [], diagnostics: [{ code: 'unreadable-file', count: 1 }] };
  }
  const entries = new Map<string, ClaudeHistoryEntry>();
  let invalid = 0;
  try {
    await forEachJsonlSummaryLine(historyPath, 'Claude history', { maxBytes: MAX_SUMMARY_BYTES, maxLines: MAX_SUMMARY_LINES, ...(signal ? { signal } : {}) }, (row) => {
      if (!Value.Check(ClaudeHistoryEntrySchema, row)) { invalid += 1; return; }
      const historyRow = record(row);
      const sessionId = text(historyRow.sessionId);
      const display = text(historyRow.display)?.trim();
      if (!sessionId || !SAFE_ID.test(sessionId) || !display) { invalid += 1; return; }
      if (transcriptIds.has(sessionId)) return;
      const timestamp = historyTimestamp(historyRow.timestamp);
      const cwd = text(historyRow.project);
      const next: ClaudeHistoryEntry = {
        sessionId,
        display,
        ...(cwd ? { cwd } : {}),
        ...(timestamp.startedAt ? { startedAt: timestamp.startedAt } : {}),
        timestampMs: timestamp.timestampMs,
        historyPath,
      };
      const previous = entries.get(sessionId);
      if (!previous || previous.timestampMs <= next.timestampMs) entries.set(sessionId, next);
    });
  } catch (error) {
    if (error instanceof SessionDiscoveryError) return { entries: [], diagnostics: [{ code: error.code as 'invalid-jsonl' | 'too-large', count: 1 }] };
    throw error;
  }
  return { entries: [...entries.values()], diagnostics: invalid ? [{ code: 'invalid-metadata', count: invalid }] : [] };
}

function historyTimestamp(value: unknown): { timestampMs: number; startedAt?: string } {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { timestampMs: 0 };
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { timestampMs: value, startedAt: date.toISOString() } : { timestampMs: 0 };
}

async function summarizeClaudeSource(entry: SessionFileEntry, signal: AbortSignal | undefined, historyEntries: readonly ClaudeHistoryEntry[]): Promise<SessionSummary> {
  const sessionId = historyLocatorSessionId(entry.path);
  return sessionId ? summarizeClaudeHistorySession(entry.path, sessionId, historyEntries) : summarizeClaudeSession(entry, signal);
}

async function summarizeClaudeHistorySession(sourcePath: string, sessionId: string, historyEntries: readonly ClaudeHistoryEntry[]): Promise<SessionSummary> {
  if (!historyPathFromLocator(sourcePath)) throw new Error('Claude history locator is invalid.');
  const entry = historyEntries.find((candidate) => candidate.sessionId === sessionId);
  if (!entry) throw new Error('Claude history entry is no longer available.');
  return {
    productId: PRODUCT_ID,
    sessionId: entry.sessionId,
    sourcePath,
    ...(entry.startedAt ? { startedAt: entry.startedAt, startedAtSource: 'event' as const, updatedAt: entry.startedAt, updatedAtSource: 'event' as const } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    summary: compact(entry.display),
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    evidenceLevel: 'history',
    sourceKind: entry.cwd ? 'unknown' : 'projectless',
    availability: 'unindexed',
  };
}

async function inspectClaudeSession(sourcePath: string): Promise<SessionInspection> {
  const imported = await importClaudeSession(sourcePath);
  const cwd = cwdFrom(imported);
  const model = modelFrom(imported);
  const version = versionFrom(imported);
  const commit = commitFrom(imported);
  const summary = imported.initialInput.text ? compact(imported.initialInput.text) : undefined;
  const finalMessage = imported.baseline.finalMessage;
  return {
    productId: PRODUCT_ID,
    sessionId: imported.source.sessionId,
    sourcePath: imported.source.sourcePath ?? sourcePath,
    startedAt: startedAtFrom(imported),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    signals: imported.signals,
    evidenceLevel: imported.evidenceLevel ?? 'transcript',
    transcript: imported.transcript,
    ...(finalMessage ? { finalMessage } : {}),
    ...(version ? { sourceVersion: version } : {}),
    ...(commit ? { historicalCommit: commit } : {}),
  };
}

export async function importClaudeSession(sourcePath: string): Promise<ImportedSession> {
  const historySessionId = historyLocatorSessionId(sourcePath);
  if (historySessionId) return importClaudeHistorySession(sourcePath, historySessionId);
  const source = resolve(sourcePath);
  const bytes = await readSessionFile(source, 'Claude', MAX_SESSION_BYTES);
  return importFromBytes(source, bytes);
}

async function importClaudeHistorySession(sourcePath: string, sessionId: string): Promise<ImportedSession> {
  const historyPath = historyPathFromLocator(sourcePath);
  if (!historyPath) throw new Error('Claude history locator is invalid.');
  const history = await loadClaudeHistoryEntries(historyPath, new Set(), undefined);
  const entry = history.entries.find((candidate) => candidate.sessionId === sessionId);
  if (!entry) throw new Error('Claude history entry is no longer available.');
  const initialInput: SessionMessage = { id: 'history-initial', role: 'user', text: entry.display };
  const raw = JSON.stringify({ display: entry.display, ...(entry.cwd ? { project: entry.cwd } : {}), ...(entry.startedAt ? { timestamp: entry.startedAt } : {}) });
  return {
    source: { productId: PRODUCT_ID, sessionId: entry.sessionId, sourcePath },
    initialInput,
    transcript: [initialInput],
    historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: PRODUCT_ID, artifactRefs: [] },
    taskContext: { ...(entry.cwd ? { historicalCwd: entry.cwd } : {}), ...(entry.startedAt ? { historyStartedAt: entry.startedAt } : {}), historyOnly: true },
    provenance: { packVersion: 'claude-code-history-jsonl/v1' },
    raw: { relativePath: 'raw/history.json', text: raw },
    diagnostics: [],
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    evidenceLevel: 'history',
  };
}

type ClaudeSummaryState = {
  sessionId?: string | undefined; startedAt?: string | undefined; updatedAt?: string | undefined; cwd?: string | undefined; model?: string | undefined; summary?: string | undefined;
  userMessages: number; assistantMessages: number; toolCalls: number; completedTurns: number;
};

/** Listing reads one JSONL row at a time and keeps only metadata/counts, never a transcript. */
async function summarizeClaudeSession(entry: SessionFileEntry, signal: AbortSignal | undefined): Promise<SessionSummary> {
  const state: ClaudeSummaryState = { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
  const sourcePath = resolve(entry.path);
  await forEachJsonlSummaryLine(sourcePath, 'Claude', { maxBytes: MAX_SUMMARY_BYTES, maxLines: MAX_SUMMARY_LINES, ...(signal ? { signal } : {}) }, (row, index) => consumeClaudeSummaryRow(state, row, index));
  const fileId = basename(sourcePath, '.jsonl');
  state.sessionId ??= SAFE_ID.test(fileId) ? fileId : undefined;
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new Error('Claude session metadata has no valid id.');
  if (!state.userMessages) throw new Error('Claude session has no user message eligible for replay.');
  const fallback = new Date(entry.mtime).toISOString();
  return {
    productId: PRODUCT_ID, sessionId: state.sessionId, sourcePath,
    ...(state.startedAt ? { startedAt: state.startedAt, startedAtSource: 'event' as const } : {}),
    updatedAt: state.updatedAt ?? fallback,
    updatedAtSource: state.updatedAt ? 'event' : 'file-mtime',
    ...(state.cwd ? { cwd: state.cwd } : {}), ...(state.model ? { model: state.model } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    signals: { userMessages: state.userMessages, assistantMessages: state.assistantMessages, toolCalls: state.toolCalls, completedTurns: state.completedTurns },
    evidenceLevel: 'transcript',
    sourceKind: state.cwd ? 'rollout-only' : 'projectless',
    availability: 'indexed',
  };
}

function consumeClaudeSummaryRow(state: ClaudeSummaryState, row: JsonRecord, index: number): void {
  state.sessionId ??= text(row.sessionId);
  const sourceTimestamp = text(row.timestamp);
  const timestamp = validSessionTimestamp(sourceTimestamp);
  if (sourceTimestamp && !timestamp) throw new SessionDiscoveryError('invalid-metadata', 'Claude session has an invalid timestamp.');
  if (timestamp && (!state.startedAt || timestamp < state.startedAt)) state.startedAt = timestamp;
  if (timestamp && (!state.updatedAt || timestamp > state.updatedAt)) state.updatedAt = timestamp;
  state.cwd ??= text(row.cwd);
  const type = text(row.type);
  if (type === 'user') {
    const parsed = parseUserRow(row, index);
    if (parsed.kind === 'user') {
      state.userMessages += 1;
      if (!parsed.meta) state.summary ??= compact(parsed.message.text);
    }
    return;
  }
  if (type !== 'assistant') return;
  const parsed = parseAssistantRow(row, index);
  state.toolCalls += parsed.toolCalls;
  state.completedTurns += parsed.completedTurn ? 1 : 0;
  if (parsed.model && parsed.model !== '<synthetic>') state.model = parsed.model;
  state.assistantMessages += parsed.assistantMessages;
}
type ClaudeImportState = {
  diagnostics: ImportDiagnostic[];
  unknownTypes: number;
  sessionId: string | undefined;
  startedAt: string | undefined;
  cwd: string | undefined;
  version: string | undefined;
  gitBranch: string | undefined;
  effort: string | undefined;
  permissionMode: string | undefined;
  compaction: boolean;
  model: string | undefined;
  transcript: SessionMessage[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  completedTurns: number;
  eligibleUsers: SessionMessage[];
};

function ingestClaudeImportRow(state: ClaudeImportState, row: JsonRecord, index: number): void {
  const type = text(row.type);
  const rowSessionId = text(row.sessionId);
  if (rowSessionId) {
    if (state.sessionId && rowSessionId !== state.sessionId) {
      state.diagnostics.push({ code: 'session-id-mismatch', message: `Row ${index + 1} sessionId ${rowSessionId} differs from ${state.sessionId}.` });
    }
    state.sessionId ??= rowSessionId;
  }
  const timestamp = validSessionTimestamp(text(row.timestamp));
  if (timestamp && (!state.startedAt || timestamp < state.startedAt)) state.startedAt = timestamp;
  state.cwd ??= text(row.cwd);
  state.version ??= text(row.version);
  state.gitBranch ??= text(row.gitBranch);
  state.effort ??= text(row.effort) ?? text(record(row.message).effort);
  state.permissionMode ??= text(row.permissionMode) ?? text(row['permission-mode']);

  if (!type || SKIP_TYPES.has(type)) return;
  if (type === 'system') {
    if (text(row.subtype) === 'compact_boundary') {
      state.compaction = true;
      state.diagnostics.push({ code: 'compact-boundary', message: 'Transcript has an unrecoverable compaction gap.' });
    }
    return;
  }
  if (type === 'user') {
    const parsed = parseUserRow(row, index);
    if (parsed.kind === 'user') {
      state.userMessages += 1;
      state.transcript.push(parsed.message);
      if (!parsed.meta) state.eligibleUsers.push(parsed.message);
    } else if (parsed.kind === 'tool') {
      state.transcript.push(parsed.message);
    }
    return;
  }
  if (type === 'assistant') {
    const parsed = parseAssistantRow(row, index);
    state.toolCalls += parsed.toolCalls;
    state.completedTurns += parsed.completedTurn ? 1 : 0;
    if (parsed.model && parsed.model !== '<synthetic>') state.model = parsed.model;
    if (parsed.apiError) return;
    state.assistantMessages += parsed.assistantMessages;
    state.transcript.push(...parsed.messages);
    return;
  }
  state.unknownTypes += 1;
}

async function importFromBytes(sourcePath: string, bytes: Buffer): Promise<ImportedSession> {
  const fileId = basename(sourcePath, '.jsonl');
  const rows = parseJsonlRows(bytes, sourcePath, 'Claude');
  const state: ClaudeImportState = {
    diagnostics: [],
    unknownTypes: 0,
    sessionId: undefined,
    startedAt: undefined,
    cwd: undefined,
    version: undefined,
    gitBranch: undefined,
    effort: undefined,
    permissionMode: undefined,
    compaction: false,
    model: undefined,
    transcript: [],
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    completedTurns: 0,
    eligibleUsers: [],
  };

  for (const [index, row] of rows.entries()) ingestClaudeImportRow(state, row, index);

  if (state.unknownTypes) state.diagnostics.push({ code: 'unknown-types', message: `Skipped ${state.unknownTypes} unknown row type(s).` });
  if (!state.sessionId) state.sessionId = SAFE_ID.test(fileId) ? fileId : undefined;
  if (state.sessionId && fileId && state.sessionId !== fileId) {
    state.diagnostics.push({ code: 'filename-mismatch', message: `Filename ${fileId} does not match sessionId ${state.sessionId}.` });
  }
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new Error('Claude session metadata has no valid id.');
  if (!state.startedAt) throw new Error(`Claude session ${state.sessionId} has no valid start time.`);
  const initial = state.eligibleUsers[0] ?? state.transcript.find((message) => message.role === 'user');
  if (!initial) throw new Error('Claude session has no user message eligible for replay.');
  const finalMessage = [...state.transcript].reverse().find((message) => message.role === 'assistant')?.text;
  const signals = { userMessages: state.userMessages, assistantMessages: state.assistantMessages, toolCalls: state.toolCalls, completedTurns: state.completedTurns };
  return {
    source: { productId: PRODUCT_ID, sessionId: state.sessionId, sourcePath },
    initialInput: initial,
    transcript: state.transcript,
    historicalEvents: rows,
    baseline: { status: finalMessage ? 'available' : 'unavailable', ...(finalMessage ? { finalMessage } : {}), artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: PRODUCT_ID, ...(state.version ? { version: state.version } : {}), ...(state.model ? { model: state.model } : {}), artifactRefs: [] },
    taskContext: {
      ...(state.cwd ? { historicalCwd: state.cwd } : {}),
      ...(state.gitBranch ? { gitBranch: state.gitBranch } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
      ...(state.compaction ? { compaction: true } : {}),
      historicalBehavior: historicalBehavior(rows),
      signals,
    },
    provenance: { packVersion: 'claude-code-session-jsonl/v1' },
    raw: { relativePath: 'raw/session.jsonl', text: bytes.toString('utf8') },
    diagnostics: state.diagnostics,
    signals,
  };
}

function parseUserRow(row: JsonRecord, index: number): { kind: 'user'; message: SessionMessage; meta: boolean } | { kind: 'tool'; message: SessionMessage } | { kind: 'skip' } {
  const content = row.message && isRecord(row.message) ? row.message.content : row.content;
  const meta = META_FLAGS.some((flag) => row[flag] === true);
  if (typeof content === 'string' && content.trim()) {
    return { kind: 'user', message: { id: `message-${index}`, role: 'user', text: content }, meta };
  }
  if (!Array.isArray(content)) return { kind: 'skip' };
  const toolResults = content.filter((part) => isRecord(part) && part.type === 'tool_result');
  if (toolResults.length) {
    const texts = toolResults.map((part) => {
      const block = record(part);
      const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      return block.is_error === true ? `[error] ${body}` : body;
    });
    return { kind: 'tool', message: { id: `tool-${index}`, role: 'tool', text: texts.join('\n') } };
  }
  const texts = content.map((part) => (isRecord(part) && part.type === 'text' ? text(part.text) : undefined)).filter((value): value is string => Boolean(value?.trim()));
  if (!texts.length) return { kind: 'skip' };
  return { kind: 'user', message: { id: `message-${index}`, role: 'user', text: texts.join('\n') }, meta };
}

function parseAssistantRow(row: JsonRecord, index: number): {
  messages: SessionMessage[];
  assistantMessages: number;
  toolCalls: number;
  completedTurn: boolean;
  apiError: boolean;
  model?: string;
} {
  const message = record(row.message);
  const model = text(message.model);
  const apiError = row.isApiErrorMessage === true || model === '<synthetic>';
  const stopReason = text(message.stop_reason);
  const completedTurn = stopReason === 'end_turn';
  const content = message.content;
  const messages: SessionMessage[] = [];
  let assistantMessages = 0;
  let toolCalls = 0;
  if (typeof content === 'string' && content.trim()) {
    messages.push({ id: `message-${index}`, role: 'assistant', text: content });
    assistantMessages += 1;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const [blockIndex, part] of content.entries()) {
      if (!isRecord(part)) continue;
      if (part.type === 'text' && text(part.text)?.trim()) texts.push(text(part.text)!);
      if (part.type === 'thinking' && text(part.thinking)?.trim()) thoughts.push(text(part.thinking)!);
      if (part.type === 'tool_use') {
        toolCalls += 1;
        const name = text(part.name) ?? 'tool';
        const input = part.input === undefined ? '' : typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
        messages.push({ id: `tool-${index}-${blockIndex}`, role: 'tool', text: `${name}${input ? `\n${input}` : ''}` });
      }
    }
    if (texts.length) {
      messages.push({ id: `message-${index}`, role: 'assistant', text: texts.join('\n') });
      assistantMessages += 1;
    }
    if (thoughts.length && !apiError) {
      messages.push({ id: `thought-${index}`, role: 'assistant', text: thoughts.join('\n') });
    }
  }
  return { messages: apiError ? [] : messages, assistantMessages: apiError ? 0 : assistantMessages, toolCalls, completedTurn, apiError, ...(model ? { model } : {}) };
}

function excludedCwd(cwd: string | undefined, roots: readonly string[] | undefined): boolean {
  if (!cwd || !roots?.length) return false;
  return roots.some((root) => pathContainedBy(root, cwd));
}

function startedAtFrom(imported: ImportedSession): string {
  const historyStartedAt = text(record(imported.taskContext).historyStartedAt);
  if (historyStartedAt && validSessionTimestamp(historyStartedAt)) return historyStartedAt;
  const startedAt = imported.historicalEvents
    .map((event) => validSessionTimestamp(text(record(event).timestamp)))
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  if (!startedAt) throw new Error(`Claude session ${imported.source.sessionId} has no valid start time.`);
  return startedAt;
}

function cwdFrom(imported: ImportedSession): string | undefined {
  const value = imported.taskContext?.historicalCwd;
  return typeof value === 'string' ? value : undefined;
}

function modelFrom(imported: ImportedSession): string | undefined {
  return imported.sourceRuntimeEvidence.model;
}

function versionFrom(imported: ImportedSession): string | undefined {
  return imported.sourceRuntimeEvidence.version;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Delete']);

function historicalBehavior(rows: readonly JsonRecord[]): { commands: readonly string[]; touchedPaths: readonly string[] } {
  const touchedPaths = new Set<string>();
  for (const row of rows) {
    const content = record(row.message).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'tool_use') continue;
      const name = text(part.name);
      if (!name || !WRITE_TOOLS.has(name)) continue;
      const input = record(part.input);
      const path = text(input.file_path) ?? text(input.path);
      const normalized = path?.trim().replaceAll('\\', '/');
      if (normalized && normalized.length <= 1_024) touchedPaths.add(normalized);
    }
  }
  return { commands: [], touchedPaths: [...touchedPaths].sort() };
}

function commitFrom(imported: ImportedSession): string | undefined {
  const value = imported.taskContext?.historicalCommit;
  return typeof value === 'string' ? value : undefined;
}

function compact(value: string): string { return value.replace(/\s+/g, ' ').slice(0, 160); }
