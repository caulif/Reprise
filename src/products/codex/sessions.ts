import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAFE_ID } from '../../core/identity.js';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import { runProcess } from '../../infrastructure/process-runner.js';
import { discoverSessionPage, forEachJsonlHeadSummaryLine, forEachJsonlSummaryLine, listJsonlFiles, SessionDiscoveryError, parseJsonlRows, readSessionFile, type SessionFileEntry, validSessionTimestamp } from '../shared/session-files.js';
import { isExcludedSession } from '../shared/session-exclusion.js';
import { catalogProjectKey } from '../shared/session-project.js';
import type { TaskCase } from '../../core/schema.js';
import {
  type ImportedSession,
  type SessionDiscoveryPage,
  type SessionDiscoveryProject,
  type SessionDiscoveryQuery,
  type SessionInspection,
  type SessionMessage,
  type SessionPrivacy,
  type SessionRef,
  type SessionSourceAdapter,
  type SessionSummary,
} from '../contract.js';
import { freezeCase, redactText } from '../shared/freeze.js';
import { assertTranscriptSessionId, isSyntheticCatalogSource, unreadableSessionSummary } from '../shared/session-recovery.js';
import { readCodexCatalog } from './catalog.js';

export type CodexSessionSummary = SessionSummary;
export type CodexSessionInspection = SessionInspection;
export type CodexSessionPrivacy = SessionPrivacy;

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_LINES = 50_000;
const GIT_COMMIT = /^[a-f0-9]{7,64}$/i;

/** Compatibility wrapper for callers that only need the first page of Codex rollouts. */
export async function discoverCodexSessions(sessionsRoot: string, limit = 50): Promise<readonly CodexSessionSummary[]> {
  return (await discoverCodexSessionPage({ root: sessionsRoot, limit })).items;
}

async function discoverCodexSessionPage(query: SessionDiscoveryQuery): Promise<SessionDiscoveryPage> {
  const root = resolve(query.root ?? defaultCodexSessionsRoot());
  const listing = await listJsonlFiles(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), query.signal);
  const ranked = [...listing.entries].sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  const catalogPromise = query.cursor ? undefined : readCodexCatalog({ codexHome: resolve(join(root, '..')), sessionsRoot: root });
  const rolloutPage = await discoverSessionPage({
    root, ranked,
    // An omitted limit means the adapter is building the complete catalog. Explicit limits remain a compatibility API.
    limit: query.limit ?? ranked.length + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.signal ? { signal: query.signal } : {}),
    cacheKey: 'codex', ...(query.refresh ? { refresh: true } : {}), diagnostics: listing.diagnostics,
    inspect: (entry) => summarizeCodexSession(entry, query.signal),
    inspectPartial: (entry, signal) => summarizeCodexSessionHead(entry, signal),
    exclude: (session) => isExcludedSession(session, query, [root]),
    failedSummary: (entry) => unreadableSessionSummary('codex', entry),
  });
  if (query.cursor) return rolloutPage;
  const catalog = await catalogPromise!;
  const duplicates: { count: number } = { count: 0 };
  const merged = mergeCodexSources(rolloutPage.items, catalog.sessions, (session) => isExcludedSession(session, query, [root]), duplicates);
  return { ...rolloutPage, items: merged, scanned: Math.max(rolloutPage.scanned, merged.length),
    skipped: rolloutPage.skipped,
    diagnostics: [
      ...rolloutPage.diagnostics,
      ...catalog.diagnostics,
      ...(duplicates.count ? [{ code: 'duplicate-source' as const, count: duplicates.count }] : []),
    ],
    ...(catalog.projects.length ? { projects: catalog.projects.map((project): SessionDiscoveryProject => ({
      key: catalogProjectKey('codex', project.rootPaths[0], project.id),
      label: project.name,
      ...(project.rootPaths[0] ? { path: project.rootPaths[0] } : {}),
    })) } : {}) };
}

function mergeCodexSources(
  rollouts: readonly CodexSessionSummary[],
  catalog: readonly CodexSessionSummary[],
  excluded: (session: CodexSessionSummary) => boolean,
  duplicates: { count: number },
): CodexSessionSummary[] {
  const byId = new Map<string, CodexSessionSummary>();
  for (const session of catalog) if (!excluded(session)) byId.set(session.sessionId, session);
  for (const session of rollouts) {
    if (excluded(session)) continue;
    const indexed = byId.get(session.sessionId);
    if (indexed && indexed.availability !== 'catalog-only' && indexed.sourcePath !== session.sourcePath) {
      duplicates.count += 1;
      if (sessionRecency(indexed) > sessionRecency(session)) continue;
    }
    const { partial: _catalogPartial, ...catalogBase } = indexed ?? {};
    const cwd = session.cwd ?? indexed?.cwd;
    const sourceKind = indexed
      ? indexed.sourceKind === 'projectless' || indexed.sourceKind === 'unknown'
        ? indexed.sourceKind
        : 'catalog+transcript'
      : 'rollout-only';
    const evidenceLevel = session.availability === 'unreadable' ? session.evidenceLevel : 'transcript';
    byId.set(session.sessionId, { ...catalogBase, ...session, ...(cwd ? { cwd } : {}),
      sourceKind, availability: indexed ? 'indexed' : session.availability === 'unreadable' ? 'unreadable' : 'unindexed',
      ...(evidenceLevel ? { evidenceLevel } : {}),
      ...(session.partial !== undefined ? { partial: session.partial } : {}) });
  }
  return [...byId.values()].sort(compareCodexSummaries);
}

function sessionRecency(session: CodexSessionSummary): number {
  const value = Date.parse(session.updatedAt ?? session.startedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}
function compareCodexSummaries(left: CodexSessionSummary, right: CodexSessionSummary): number {
  const leftTime = Date.parse(left.updatedAt ?? left.startedAt ?? ''); const rightTime = Date.parse(right.updatedAt ?? right.startedAt ?? '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  return left.sessionId.localeCompare(right.sessionId);
}
/** Listing reads one JSONL row at a time and keeps only metadata/counts, never a transcript. */
type CodexSummaryState = {
  sessionId?: string | undefined; startedAt?: string | undefined; updatedAt?: string | undefined; cwd?: string | undefined; model?: string | undefined; summary?: string | undefined;
  userMessages: number; assistantMessages: number; toolCalls: number; completedTurns: number;
};

async function summarizeCodexSessionHead(entry: SessionFileEntry, signal: AbortSignal | undefined): Promise<CodexSessionSummary> {
  const state: CodexSummaryState = { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
  const sourcePath = resolve(entry.path);
  await forEachJsonlHeadSummaryLine(sourcePath, 'Codex', { maxBytes: 256 * 1024, maxLines: 2_000, ...(signal ? { signal } : {}) }, (row) => consumeCodexSummaryRow(state, row));
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new SessionDiscoveryError('too-large', 'Codex session head has no valid id.');
  if (!state.userMessages) throw new SessionDiscoveryError('too-large', 'Codex session head has no user message.');
  return {
    productId: 'codex', sessionId: state.sessionId, sourcePath, partial: true,
    ...(state.startedAt ? { startedAt: state.startedAt, startedAtSource: 'event' as const } : {}),
    updatedAt: state.updatedAt ?? new Date(entry.mtime).toISOString(),
    updatedAtSource: state.updatedAt ? 'event' : 'file-mtime',
    ...(state.cwd ? { cwd: state.cwd } : {}), ...(state.model ? { model: state.model } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    signals: { userMessages: state.userMessages, assistantMessages: state.assistantMessages, toolCalls: state.toolCalls, completedTurns: state.completedTurns },
  };
}

async function summarizeCodexSession(entry: SessionFileEntry, signal: AbortSignal | undefined): Promise<CodexSessionSummary> {
  const state: CodexSummaryState = { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
  const sourcePath = resolve(entry.path);
  await forEachJsonlSummaryLine(sourcePath, 'Codex', { maxBytes: MAX_SUMMARY_BYTES, maxLines: MAX_SUMMARY_LINES, ...(signal ? { signal } : {}) }, (row) => consumeCodexSummaryRow(state, row));
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new Error('Codex session metadata has no valid id.');
  if (!state.userMessages) throw new Error('Codex session has no user message eligible for replay.');
  const fallback = new Date(entry.mtime).toISOString();
  return {
    productId: 'codex', sessionId: state.sessionId, sourcePath,
    ...(state.startedAt ? { startedAt: state.startedAt, startedAtSource: 'event' as const } : {}),
    updatedAt: state.updatedAt ?? fallback,
    updatedAtSource: state.updatedAt ? 'event' : 'file-mtime',
    ...(state.cwd ? { cwd: state.cwd } : {}), ...(state.model ? { model: state.model } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    signals: { userMessages: state.userMessages, assistantMessages: state.assistantMessages, toolCalls: state.toolCalls, completedTurns: state.completedTurns },
  };
}

function consumeCodexSummaryRow(state: CodexSummaryState, row: JsonRecord): void {
  const payload = record(row.payload);
  const sourceTimestamp = text(row.timestamp) ?? text(payload.timestamp);
  const timestamp = validSessionTimestamp(sourceTimestamp);
  if (sourceTimestamp && !timestamp) throw new SessionDiscoveryError('invalid-metadata', 'Codex session has an invalid timestamp.');
  if (timestamp && (!state.startedAt || timestamp < state.startedAt)) state.startedAt = timestamp;
  if (timestamp && (!state.updatedAt || timestamp > state.updatedAt)) state.updatedAt = timestamp;
  if (row.type === 'session_meta') {
    state.sessionId ??= text(payload.id);
    state.cwd ??= text(payload.cwd);
  }
  if (row.type === 'turn_context') state.model ??= text(payload.model);
  const payloadType = text(payload.type);
  if (row.type === 'event_msg') {
    const value = text(payload.message);
    if (value && payloadType === 'user_message') {
      state.userMessages += 1;
      state.summary ??= compact(value);
    } else if (value && payloadType === 'agent_message') state.assistantMessages += 1;
  }
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') state.toolCalls += 1;
  if (payloadType === 'task_complete') state.completedTurns += 1;
}
/** Checks one complete rollout before a user chooses to freeze it. */
export async function inspectCodexSession(sourcePath: string): Promise<CodexSessionInspection> {
  const source = resolve(sourcePath);
  return inspectionFromRows(source, parseJsonlRows(await readSessionFile(source, 'Codex', MAX_SESSION_BYTES), source, 'Codex'));
}

async function importCodexSession(sourcePath: string, privacy?: SessionPrivacy): Promise<ImportedSession> {
  const source = resolve(sourcePath);
  const bytes = await readSessionFile(source, 'Codex', MAX_SESSION_BYTES);
  const raw = privacy ? redactText(bytes.toString('utf8'), privacy.redactions) : bytes.toString('utf8');
  return importFromBytes(source, Buffer.from(raw, 'utf8'));
}

/** Freezes exactly the inspected rollout, applying caller-supplied literal redactions before any data is written. */
export async function freezeCodexSession(input: { sourcePath: string; casesRoot: string; now: string; privacy: CodexSessionPrivacy; initialMessageId?: string }): Promise<{ taskCase: TaskCase; reused: boolean }> {
  const imported = await importCodexSession(input.sourcePath, input.privacy);
  if (!imported.signals.completedTurns) throw new Error('Codex session has no completed turn and cannot become a historical TaskCase.');
  try {
    return await freezeCase(imported, input.casesRoot, input.privacy, input.now, {
      ...(input.initialMessageId ? { initialMessageId: input.initialMessageId } : {}),
      reuseExisting: true,
      errorLabel: 'Codex session',
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Selected task input')) {
      throw new Error('Selected task input is not a user message in this Codex session.', { cause: error });
    }
    throw error;
  }
}

function defaultCodexSessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

export const codexSessionAdapter: SessionSourceAdapter = {
  get defaultRoot() { return defaultCodexSessionsRoot(); },
  discover(query?: SessionDiscoveryQuery) {
    return discoverCodexSessionPage({ ...query, root: query?.root ?? defaultCodexSessionsRoot() });
  },
  async inspect(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session inspect requires a sourcePath.');
    if (isSyntheticCatalogSource(ref.sourcePath)) {
      throw new Error('Selected session has catalog metadata but no readable transcript.');
    }
    const inspection = await inspectCodexSession(ref.sourcePath);
    assertTranscriptSessionId(ref.sessionId, inspection.sessionId);
    return inspection;
  },
  async import(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session import requires a sourcePath.');
    if (isSyntheticCatalogSource(ref.sourcePath)) {
      throw new Error('Selected session has catalog metadata but no readable transcript.');
    }
    const imported = await importCodexSession(ref.sourcePath);
    assertTranscriptSessionId(ref.sessionId, imported.source.sessionId);
    return imported;
  },
};

function inspectionFromRows(sourcePath: string, rows: readonly JsonRecord[]): CodexSessionInspection {
  const metadata = metadataFrom(rows);
  const transcript = transcriptFrom(rows);
  const initial = transcript.find((message) => message.role === 'user');
  const finalMessage = [...transcript].reverse().find((message) => message.role === 'assistant')?.text;
  return {
    productId: 'codex', sessionId: metadata.sessionId, sourcePath, startedAt: metadata.startedAt,
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(initial ? { summary: compact(initial.text) } : {}),
    signals: signalsFrom(rows, transcript), transcript,
    ...(finalMessage ? { finalMessage } : {}),
    ...(metadata.version ? { sourceVersion: metadata.version } : {}),
    ...(metadata.historicalCommit ? { historicalCommit: metadata.historicalCommit } : {}),
  };
}

function metadataFrom(rows: readonly JsonRecord[]): { sessionId: string; startedAt: string; cwd?: string; model?: string; version?: string; historicalCommit?: string } {
  const meta = rows.find((row) => row.type === 'session_meta');
  const payload = record(meta?.payload);
  const id = text(payload.id);
  if (!id || !SAFE_ID.test(id)) throw new Error('Codex session metadata has no valid id.');
  const startedAt = validSessionTimestamp(text(meta?.timestamp)) ?? validSessionTimestamp(text(payload.timestamp));
  if (!startedAt) throw new Error(`Codex session ${id} has no valid start time.`);
  const context = record(rows.find((row) => row.type === 'turn_context')?.payload);
  const cwd = text(payload.cwd);
  const model = text(context.model);
  const version = text(payload.cli_version);
  const historicalCommit = commitFromMetadata(payload);
  return { sessionId: id, startedAt, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(version ? { version } : {}), ...(historicalCommit ? { historicalCommit } : {}) };
}

function transcriptFrom(rows: readonly JsonRecord[]): SessionMessage[] {
  const transcript: SessionMessage[] = [];
  for (const [index, row] of rows.entries()) {
    const payload = record(row.payload);
    if (row.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message')) {
      const value = text(payload.message);
      if (value) transcript.push({ id: `message-${index}`, role: payload.type === 'user_message' ? 'user' : 'assistant', text: value });
    }
    if (row.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      const name = text(payload.name) ?? 'tool';
      const input = text(payload.arguments) ?? text(payload.input) ?? '';
      transcript.push({ id: `tool-${index}`, role: 'tool', text: `${name}${input ? `\n${input}` : ''}` });
    }
    if (row.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
      const output = text(payload.output);
      if (output) transcript.push({ id: `tool-output-${index}`, role: 'tool', text: output });
    }
  }
  if (!transcript.some((message) => message.role === 'user')) throw new Error('Codex session has no user message eligible for replay.');
  return transcript;
}

function signalsFrom(rows: readonly JsonRecord[], transcript: readonly SessionMessage[]): CodexSessionSummary['signals'] {
  return {
    userMessages: transcript.filter((message) => message.role === 'user').length,
    assistantMessages: transcript.filter((message) => message.role === 'assistant').length,
    toolCalls: rows.filter((row) => ['function_call', 'custom_tool_call'].includes(text(record(row.payload).type) ?? '')).length,
    completedTurns: rows.filter((row) => text(record(row.payload).type) === 'task_complete').length,
  };
}

async function importFromBytes(sourcePath: string, bytes: Buffer): Promise<ImportedSession> {
  const rows = parseJsonlRows(bytes, sourcePath, 'Codex');
  const inspection = inspectionFromRows(sourcePath, rows);
  const initial = inspection.transcript.find((message) => message.role === 'user');
  if (!initial) throw new Error('Codex session initial user message disappeared during import.');
  const environment = await historicalEnvironment(inspection.cwd);
  const behavior = historicalBehavior(rows);
  return {
    source: { productId: 'codex', sessionId: inspection.sessionId, sourcePath },
    initialInput: initial,
    transcript: [...inspection.transcript],
    historicalEvents: [...rows],
    baseline: { status: inspection.finalMessage ? 'available' : 'unavailable', ...(inspection.finalMessage ? { finalMessage: inspection.finalMessage } : {}), artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', ...(inspection.sourceVersion ? { version: inspection.sourceVersion } : {}), ...(inspection.model ? { model: inspection.model } : {}), artifactRefs: [] },
    taskContext: {
      ...(inspection.cwd ? { historicalCwd: inspection.cwd } : {}),
      historicalEnvironment: environment,
      ...(inspection.historicalCommit ? { historicalCommit: inspection.historicalCommit } : {}),
      historicalBehavior: behavior,
      signals: inspection.signals,
    },
    provenance: { packVersion: 'codex-rollout-jsonl/v1' },
    raw: { relativePath: 'raw/session.jsonl', text: bytes.toString('utf8') },
    diagnostics: [],
    signals: inspection.signals,
  };
}


/** Captures only the current, read-only state of the historical cwd; it cannot recreate the historical start state. */
async function historicalEnvironment(cwd: string | undefined): Promise<JsonRecord> {
  if (!cwd) return { cwd: { status: 'unavailable' } };
  let info;
  try { info = await stat(cwd); } catch (error) { return { cwd: { status: isMissing(error) ? 'missing' : 'unavailable' } }; }
  if (!info.isDirectory()) return { cwd: { status: 'not_directory' } };
  const repository = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (repository !== 'true') return { cwd: { status: 'available', git: { isRepository: false } } };
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const status = await git(cwd, ['status', '--porcelain']);
  return { cwd: { status: 'available', git: { isRepository: true, ...(head && GIT_COMMIT.test(head) ? { head } : {}), ...(status !== undefined ? { dirty: Boolean(status) } : {}) } } };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runProcess({
      operation: 'historical_environment_git_probe',
      executableKind: 'git',
      command: 'git',
      args: ['-C', cwd, ...args],
      timeoutMs: 5_000,
    });
    return result.stdout.trim();
  } catch {
    // Historical environment is optional imported-session context; classified failures degrade it to unavailable.
    return undefined;
  }
}

/** Only structured write tools and unified patches count as touched paths; shell commands are retained without guessing their effects. */
function historicalBehavior(rows: readonly JsonRecord[]): JsonRecord {
  const commands = new Set<string>();
  const touchedPaths = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'response_item') continue;
    const payload = record(row.payload);
    const name = text(payload.name);
    if (!name || !['function_call', 'custom_tool_call'].includes(text(payload.type) ?? '')) continue;
    const input = toolInput(payload);
    const command = text(input.command);
    if (command && /(?:shell|command|exec)/i.test(name)) commands.add(command);
    if (/(?:write|edit|patch|create|delete|move|copy|apply)/i.test(name)) addPath(touchedPaths, text(input.path) ?? text(input.filePath) ?? text(input.file_path));
    for (const patch of [text(input.patch), text(input.content)]) addPatchedPaths(touchedPaths, patch);
  }
  return { commands: [...commands].sort(), touchedPaths: [...touchedPaths].sort() };
}

function toolInput(payload: JsonRecord): JsonRecord {
  const value = payload.arguments ?? payload.input;
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed: unknown = JSON.parse(value); return record(parsed); } catch { return {}; }
}

function addPatchedPaths(paths: Set<string>, patch: string | undefined): void {
  if (!patch) return;
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) addPath(paths, match[1]);
}

function addPath(paths: Set<string>, path: string | undefined): void {
  const normalized = path?.trim().replaceAll('\\', '/');
  if (normalized && normalized.length <= 1_024) paths.add(normalized);
}

function commitFromMetadata(payload: JsonRecord): string | undefined {
  const git = record(payload.git);
  const value = text(git.commit) ?? text(git.commitHash) ?? text(payload.git_commit) ?? text(payload.gitCommit) ?? text(payload.commit);
  return value && GIT_COMMIT.test(value) ? value : undefined;
}

function compact(value: string): string { return value.replace(/\s+/g, ' ').slice(0, 160); }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
