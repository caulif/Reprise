import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAFE_ID } from '../../core/identity.js';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import { runProcess } from '../../infrastructure/process-runner.js';
import { discoverSessionPage, forEachJsonlHeadSummaryLine, forEachJsonlSummaryLine, listJsonlFiles, rankSessionFiles, SessionDiscoveryError, type SessionFileEntry, validSessionTimestamp } from '../shared/session-files.js';
import { isExcludedSession } from '../shared/session-exclusion.js';
import { looksLikeInjectedInstruction } from '../shared/replay-user-input.js';
import { catalogProjectKey } from '../shared/session-project.js';
import type { TaskCase } from '../../core/schema.js';
import type {
  ImportedSession,
  RecoveryDiagnostic,
  RecoveryReadiness,
  SessionDiscoveryPage,
  SessionDiscoveryProject,
  SessionDiscoveryQuery,
  SessionInspection,
  SessionMessage,
  SessionPrivacy,
  SessionRef,
  ProductHistoryReader,
  SessionSummary,
} from '../contract.js';
import { freezeCase } from '../shared/freeze.js';
import { forEachJsonlRecordLenient, withStableJsonlRead } from '../shared/jsonl-io.js';
import {
  assertTranscriptSessionId,
  discoveryFailureSummary,
  evidenceRank,
  isSyntheticCatalogSource,
} from '../shared/session-recovery.js';
import { readCodexCatalog, catalogPathKey } from './catalog.js';

export type CodexSessionSummary = SessionSummary;
export type CodexSessionInspection = SessionInspection;
export type CodexSessionPrivacy = SessionPrivacy;

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
  const ranked = rankSessionFiles(listing.entries);
  const rolloutPage = await discoverSessionPage({
    root, ranked,
    // An omitted limit means the adapter is building the complete catalog. Explicit limits remain a compatibility API.
    limit: query.limit ?? ranked.length + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.signal ? { signal: query.signal } : {}),
    cacheKey: 'codex', ...(query.refresh ? { refresh: true } : {}), diagnostics: listing.diagnostics,
    inspect: (entry) => summarizeCodexSession(entry, query.signal),
    inspectPartial: (entry, signal) => summarizeCodexSessionHead(entry, signal),
    exclude: (session) => isExcludedSession(session, query, [root]),
    failedSummary: (entry, code) => discoveryFailureSummary('codex', entry, code),
  });
  if (query.cursor) return rolloutPage;
  const sessionIdsByPath = new Map<string, string>();
  for (const session of rolloutPage.items) {
    if (isSyntheticCatalogSource(session.sourcePath)) continue;
    sessionIdsByPath.set(catalogPathKey(session.sourcePath), session.sessionId);
    try { sessionIdsByPath.set(catalogPathKey(realpathSync(session.sourcePath)), session.sessionId); } catch { /* listed path may already be gone; catalog will peek or mark source-missing */ }
  }
  const catalog = await readCodexCatalog({
    codexHome: resolve(join(root, '..')),
    sessionsRoot: root,
    sessionIdsByPath,
  });
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
  const idByPath = new Map<string, string>();
  for (const session of catalog) {
    if (excluded(session)) continue;
    rememberMerged(byId, idByPath, session);
  }
  for (const session of rollouts) {
    if (excluded(session)) continue;
    const indexed = lookupMerged(byId, idByPath, session);
    if (indexed && indexed.sourcePath !== session.sourcePath && indexed.sessionId === session.sessionId) duplicates.count += 1;
    const mergedId = indexed?.sessionId ?? session.sessionId;
    if (indexed && indexed.sessionId !== session.sessionId) byId.delete(session.sessionId);
    rememberMerged(byId, idByPath, preferCodexEvidence(indexed, { ...session, sessionId: mergedId }));
  }
  return [...byId.values()].sort(compareCodexSummaries);
}

function preferCodexEvidence(indexed: CodexSessionSummary | undefined, session: CodexSessionSummary): CodexSessionSummary {
  if (!indexed) return withCodexSourceKind(session, undefined);
  const winner = evidenceRank(session) > evidenceRank(indexed) ? session
    : evidenceRank(session) < evidenceRank(indexed) ? indexed
      : sessionRecency(session) >= sessionRecency(indexed) ? session : indexed;
  const loser = winner === session ? indexed : session;
  return combineCodexEvidence(winner, loser);
}

function combineCodexEvidence(primary: CodexSessionSummary, secondary: CodexSessionSummary): CodexSessionSummary {
  const cwd = primary.cwd ?? secondary.cwd;
  const diagnostics = [...(primary.recoveryDiagnostics ?? []), ...(secondary.recoveryDiagnostics ?? [])];
  const catalogued = [primary, secondary].some((item) => item.sourceKind === 'catalog-only' || item.sourceKind === 'catalog+transcript');
  const transcribed = [primary, secondary].some((item) => item.availability !== 'catalog-only' && !isSyntheticCatalogSource(item.sourcePath));
  const sourceKind = catalogued && transcribed ? 'catalog+transcript' as const : primary.sourceKind ?? secondary.sourceKind;
  return {
    ...secondary, ...primary, ...(cwd ? { cwd } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(diagnostics.length ? { recoveryDiagnostics: diagnostics } : {}),
  };
}

function withCodexSourceKind(session: CodexSessionSummary, indexed: CodexSessionSummary | undefined): CodexSessionSummary {
  if (indexed) return combineCodexEvidence(session, indexed);
  if (session.sourceKind) return session;
  return { ...session, sourceKind: session.cwd ? 'rollout-only' : 'projectless' };
}

function rememberMerged(
  byId: Map<string, CodexSessionSummary>,
  idByPath: Map<string, string>,
  session: CodexSessionSummary,
): void {
  byId.set(session.sessionId, session);
  const key = transcriptPathKey(session);
  if (key) idByPath.set(key, session.sessionId);
}

function lookupMerged(
  byId: Map<string, CodexSessionSummary>,
  idByPath: Map<string, string>,
  session: CodexSessionSummary,
): CodexSessionSummary | undefined {
  const bySessionId = byId.get(session.sessionId);
  if (bySessionId) return bySessionId;
  const key = transcriptPathKey(session);
  const pathId = key ? idByPath.get(key) : undefined;
  return pathId ? byId.get(pathId) : undefined;
}

function transcriptPathKey(session: CodexSessionSummary): string | undefined {
  if (isSyntheticCatalogSource(session.sourcePath)) return undefined;
  return catalogPathKey(session.sourcePath);
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
  laterUserSummaries: string[];
  userMessages: number; assistantMessages: number; toolCalls: number; completedTurns: number;
};

async function summarizeCodexSessionHead(entry: SessionFileEntry, signal: AbortSignal | undefined): Promise<CodexSessionSummary> {
  const state: CodexSummaryState = { laterUserSummaries: [], userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
  const sourcePath = resolve(entry.path);
  await forEachJsonlHeadSummaryLine(sourcePath, 'Codex', { maxBytes: 256 * 1024, maxLines: 2_000, ...(signal ? { signal } : {}) }, (row) => consumeCodexSummaryRow(state, row));
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new SessionDiscoveryError('too-large', 'Codex session head has no valid id.');
  return summaryFromCodexState(entry, sourcePath, state, { partial: true, readiness: 'pending', diagnostic: { code: 'summary-window', message: 'List used a bounded head; full inspect is required.' } });
}

async function summarizeCodexSession(entry: SessionFileEntry, signal: AbortSignal | undefined): Promise<CodexSessionSummary> {
  const state: CodexSummaryState = { laterUserSummaries: [], userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
  const sourcePath = resolve(entry.path);
  await forEachJsonlSummaryLine(sourcePath, 'Codex', { maxBytes: MAX_SUMMARY_BYTES, maxLines: MAX_SUMMARY_LINES, ...(signal ? { signal } : {}) }, (row) => consumeCodexSummaryRow(state, row));
  if (!state.sessionId || !SAFE_ID.test(state.sessionId)) throw new Error('Codex session metadata has no valid id.');
  const readiness: RecoveryReadiness = state.userMessages ? 'verified' : 'no-user-input';
  const diagnostic = readiness === 'no-user-input'
    ? { code: 'no-user-input', message: 'Complete discovery summary found no eligible user message.' }
    : undefined;
  return summaryFromCodexState(entry, sourcePath, state, { readiness, ...(diagnostic ? { diagnostic } : {}) });
}

function summaryFromCodexState(
  entry: SessionFileEntry,
  sourcePath: string,
  state: CodexSummaryState,
  extra: { partial?: boolean; readiness: RecoveryReadiness; diagnostic?: RecoveryDiagnostic },
): CodexSessionSummary {
  const fallback = new Date(entry.mtime).toISOString();
  return {
    productId: 'codex', sessionId: state.sessionId!, sourcePath,
    ...(extra.partial ? { partial: true } : {}),
    ...(state.startedAt ? { startedAt: state.startedAt, startedAtSource: 'event' as const } : {}),
    updatedAt: state.updatedAt ?? fallback,
    updatedAtSource: state.updatedAt ? 'event' : 'file-mtime',
    ...(state.cwd ? { cwd: state.cwd } : {}), ...(state.model ? { model: state.model } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    ...(state.laterUserSummaries.length ? { laterUserSummaries: state.laterUserSummaries } : {}),
    signals: { userMessages: state.userMessages, assistantMessages: state.assistantMessages, toolCalls: state.toolCalls, completedTurns: state.completedTurns },
    availability: 'indexed',
    sourceKind: state.cwd ? 'rollout-only' : 'projectless',
    recoveryReadiness: extra.readiness,
    ...(extra.diagnostic ? { recoveryDiagnostics: [extra.diagnostic] } : {}),
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
  const message = consumeCodexMessage(row);
  if (message.role === 'user' && message.text) {
    state.userMessages += 1;
    recordLaterUserSummary(state, message.text);
  } else if (message.role === 'assistant' && message.text) state.assistantMessages += 1;
  const payloadType = text(payload.type);
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') state.toolCalls += 1;
  if (payloadType === 'task_complete') state.completedTurns += 1;
}
type CodexBuildState = {
  sessionId?: string;
  startedAt?: string;
  cwd?: string;
  model?: string;
  version?: string;
  historicalCommit?: string;
  sandbox?: string;
  approvalPolicy?: string;
  transcript: SessionMessage[];
  events?: JsonRecord[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  completedTurns: number;
  skippedEvents: number;
  seenIds: Set<string>;
  diagnostics: RecoveryDiagnostic[];
  recoveryReadiness: RecoveryReadiness;
  commands: Set<string>;
  touchedPaths: Set<string>;
};

function emptyCodexBuild(keepEvents: boolean): CodexBuildState {
  return {
    transcript: [],
    ...(keepEvents ? { events: [] } : {}),
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    completedTurns: 0,
    skippedEvents: 0,
    seenIds: new Set(),
    diagnostics: [],
    recoveryReadiness: 'verified',
    commands: new Set(),
    touchedPaths: new Set(),
  };
}

async function parseCodexBuild(sourcePath: string, keepEvents: boolean, expectedId: string | undefined, signal?: AbortSignal): Promise<CodexBuildState> {
  const source = resolve(sourcePath);
  const stable = await withStableJsonlRead(source, async () => {
    const state = emptyCodexBuild(keepEvents);
    const walk = await forEachJsonlRecordLenient(source, 'Codex', (row, index) => consumeCodexBuildRow(state, row, index), signal);
    return { state, walk };
  });
  const { state, walk } = stable.value;
  state.diagnostics.push(...walk.diagnostics);
  if (walk.truncated && state.recoveryReadiness === 'verified') state.recoveryReadiness = 'best-effort';
  if (walk.diagnostics.some((item) => item.code === 'invalid-jsonl' || item.code === 'corrupt-prefix')) state.recoveryReadiness = 'corrupt';
  if (stable.changed) {
    state.recoveryReadiness = 'pending';
    state.diagnostics.push({ code: 'source-changed', message: 'Source file changed during read; retry the recovery attempt.' });
  }
  if (!state.sessionId && expectedId && SAFE_ID.test(expectedId) && state.seenIds.has(expectedId)) {
    state.sessionId = expectedId;
    state.diagnostics.push({ code: 'catalog-session-id', message: 'Session id taken from a verified catalog id present in the transcript.' });
    if (state.recoveryReadiness === 'verified') state.recoveryReadiness = 'best-effort';
  }
  if (!state.startedAt) {
    const info = await stat(source);
    state.startedAt = new Date(info.mtimeMs).toISOString();
    state.diagnostics.push({ code: 'missing-timestamp', message: 'Session start time fell back to file mtime.' });
    if (state.recoveryReadiness === 'verified') state.recoveryReadiness = 'best-effort';
  }
  if (!state.transcript.some((message) => message.role === 'user') && state.recoveryReadiness !== 'pending' && state.recoveryReadiness !== 'corrupt') {
    state.recoveryReadiness = 'no-user-input';
    state.diagnostics.push({ code: 'no-user-input', message: 'Transcript has no eligible user message.' });
  }
  return state;
}

/** Checks one complete rollout before a user chooses to freeze it. */
export async function inspectCodexSession(sourcePath: string, signal?: AbortSignal, expectedId?: string): Promise<CodexSessionInspection> {
  return inspectionFromBuild(resolve(sourcePath), await parseCodexBuild(sourcePath, false, expectedId, signal));
}

async function importCodexSession(sourcePath: string, signal?: AbortSignal, expectedId?: string): Promise<ImportedSession> {
  return importFromBuild(resolve(sourcePath), await parseCodexBuild(sourcePath, true, expectedId, signal));
}

/** Freezes exactly the inspected rollout, applying caller-supplied literal redactions before any data is written. */
export async function freezeCodexSession(input: { sourcePath: string; casesRoot: string; now: string; privacy: CodexSessionPrivacy; initialMessageId?: string }): Promise<{ taskCase: TaskCase; reused: boolean }> {
  const imported = await importCodexSession(input.sourcePath);
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

export const codexSessionAdapter: ProductHistoryReader = {
  get defaultRoot() { return defaultCodexSessionsRoot(); },
  discover(query?: SessionDiscoveryQuery) {
    return discoverCodexSessionPage({ ...query, root: query?.root ?? defaultCodexSessionsRoot() });
  },
  async inspect(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session inspect requires a sourcePath.');
    if (isSyntheticCatalogSource(ref.sourcePath)) {
      throw new Error('Selected session has catalog metadata but no readable transcript.');
    }
    const inspection = await inspectCodexSession(ref.sourcePath, undefined, ref.sessionId);
    assertTranscriptSessionId(ref.sessionId, inspection.sessionId);
    return inspection;
  },
  async import(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session import requires a sourcePath.');
    if (isSyntheticCatalogSource(ref.sourcePath)) {
      throw new Error('Selected session has catalog metadata but no readable transcript.');
    }
    const imported = await importCodexSession(ref.sourcePath, undefined, ref.sessionId);
    assertTranscriptSessionId(ref.sessionId, imported.source.sessionId);
    return imported;
  },
};

function consumeCodexBuildRow(state: CodexBuildState, row: JsonRecord, index: number): void {
  state.events?.push(row);
  const payload = record(row.payload);
  const payloadId = text(payload.id);
  if (payloadId && SAFE_ID.test(payloadId)) state.seenIds.add(payloadId);
  if (row.type === 'session_meta') {
    const sessionId = text(payload.id);
    const cwd = text(payload.cwd);
    const version = text(payload.cli_version);
    const historicalCommit = commitFromMetadata(payload);
    const startedAt = validSessionTimestamp(text(row.timestamp)) ?? validSessionTimestamp(text(payload.timestamp));
    const sandbox = text(payload.sandbox) ?? text(payload.sandbox_policy);
    const approvalPolicy = text(payload.approvalPolicy) ?? text(payload.approval_policy);
    if (sessionId) state.sessionId ??= sessionId;
    if (cwd) state.cwd ??= cwd;
    if (version) state.version ??= version;
    if (historicalCommit) state.historicalCommit ??= historicalCommit;
    if (startedAt) state.startedAt ??= startedAt;
    if (sandbox) state.sandbox ??= sandbox;
    if (approvalPolicy) state.approvalPolicy ??= approvalPolicy;
  }
  if (row.type === 'turn_context') {
    const model = text(payload.model);
    if (model) state.model ??= model;
    const sandbox = text(payload.sandbox) ?? text(payload.sandbox_policy);
    const approvalPolicy = text(payload.approvalPolicy) ?? text(payload.approval_policy);
    if (sandbox) state.sandbox ??= sandbox;
    if (approvalPolicy) state.approvalPolicy ??= approvalPolicy;
  }
  const message = consumeCodexMessage(row);
  if (message.skipped) state.skippedEvents += 1;
  if (message.unknownBlocks) state.skippedEvents += message.unknownBlocks;
  if (message.role && message.text) {
    const id = message.role === 'tool'
      ? (text(record(row.payload).type)?.includes('output') ? `tool-output-${index}` : `tool-${index}`)
      : `message-${index}`;
    state.transcript.push({ id, role: message.role, text: message.text });
    if (message.role === 'user') state.userMessages += 1;
    else if (message.role === 'assistant') state.assistantMessages += 1;
  }
  const payloadType = text(payload.type);
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    state.toolCalls += 1;
    if (row.type === 'response_item') consumeCodexBehavior(state, payload);
  }
  if (payloadType === 'task_complete') state.completedTurns += 1;
}

const KNOWN_CODEX_ROWS = new Set(['session_meta', 'turn_context', 'event_msg', 'response_item']);
const KNOWN_RESPONSE_ITEMS = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);

function consumeCodexMessage(row: JsonRecord): {
  role?: SessionMessage['role'];
  text?: string;
  skipped?: boolean;
  unknownBlocks?: number;
} {
  const payload = record(row.payload);
  const payloadType = text(payload.type);
  const rowType = text(row.type);
  if (rowType === 'event_msg' && (payloadType === 'user_message' || payloadType === 'agent_message')) {
    const value = text(payload.message);
    if (!value) return {};
    return { role: payloadType === 'user_message' ? 'user' : 'assistant', text: value };
  }
  if (rowType === 'response_item' && payloadType === 'message') {
    const role = text(payload.role);
    const content = extractCodexContentText(payload.content);
    if (role === 'user' && content.text) return { role: 'user', text: content.text, unknownBlocks: content.unknownBlocks };
    if (role === 'assistant' && content.text) return { role: 'assistant', text: content.text, unknownBlocks: content.unknownBlocks };
    if (role === 'developer' || role === 'system') return { skipped: true };
    if (content.unknownBlocks) return { skipped: true, unknownBlocks: content.unknownBlocks };
    return {};
  }
  if (rowType === 'response_item' && (payloadType === 'function_call' || payloadType === 'custom_tool_call')) {
    const name = text(payload.name) ?? 'tool';
    const input = text(payload.arguments) ?? text(payload.input) ?? '';
    return { role: 'tool', text: `${name}${input ? `\n${input}` : ''}` };
  }
  if (rowType === 'response_item' && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
    const output = text(payload.output);
    return output ? { role: 'tool', text: output } : {};
  }
  if (rowType && !KNOWN_CODEX_ROWS.has(rowType)) return { skipped: true };
  if (rowType === 'response_item' && payloadType && !KNOWN_RESPONSE_ITEMS.has(payloadType)) return { skipped: true };
  return {};
}

function extractCodexContentText(content: unknown): { text: string; unknownBlocks: number } {
  if (typeof content === 'string') return { text: content, unknownBlocks: 0 };
  if (!Array.isArray(content)) return { text: '', unknownBlocks: 0 };
  const parts: string[] = [];
  let unknownBlocks = 0;
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (!isRecord(block)) { unknownBlocks += 1; continue; }
    const type = text(block.type);
    const value = text(block.text) ?? text(block.input_text) ?? text(block.output_text);
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === undefined) {
      if (value) parts.push(value);
    } else unknownBlocks += 1;
  }
  return { text: parts.join('\n'), unknownBlocks };
}

function consumeCodexBehavior(state: CodexBuildState, payload: JsonRecord): void {
  const name = text(payload.name);
  if (!name) return;
  const input = toolInput(payload);
  const command = text(input.command);
  if (command && /(?:shell|command|exec)/i.test(name)) state.commands.add(command);
  if (/(?:write|edit|patch|create|delete|move|copy|apply)/i.test(name)) addPath(state.touchedPaths, text(input.path) ?? text(input.filePath) ?? text(input.file_path));
  for (const patch of [text(input.patch), text(input.content)]) addPatchedPaths(state.touchedPaths, patch);
}

function inspectionFromBuild(sourcePath: string, state: CodexBuildState): CodexSessionInspection {
  const { sessionId, startedAt, transcript } = finalizedCodexBuild(state);
  const initial = transcript.find((message) => message.role === 'user');
  const finalMessage = [...transcript].reverse().find((message) => message.role === 'assistant')?.text;
  return {
    productId: 'codex', sessionId, sourcePath, startedAt,
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(initial ? { summary: compact(initial.text) } : {}),
    signals: codexSignals(state), transcript,
    availability: 'indexed',
    sourceKind: state.cwd ? 'rollout-only' : 'projectless',
    recoveryReadiness: state.recoveryReadiness,
    ...(state.diagnostics.length ? { recoveryDiagnostics: state.diagnostics } : {}),
    ...(finalMessage ? { finalMessage } : {}),
    ...(state.version ? { sourceVersion: state.version } : {}),
    ...(state.historicalCommit ? { historicalCommit: state.historicalCommit } : {}),
  };
}

function finalizedCodexBuild(state: CodexBuildState): { sessionId: string; startedAt: string; transcript: SessionMessage[] } {
  const sessionId = state.sessionId;
  if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('Codex session metadata has no valid id.');
  if (!state.startedAt) throw new Error(`Codex session ${sessionId} has no valid start time.`);
  return { sessionId, startedAt: state.startedAt, transcript: state.transcript };
}

function codexSignals(state: CodexBuildState): CodexSessionSummary['signals'] {
  return {
    userMessages: state.userMessages,
    assistantMessages: state.assistantMessages,
    toolCalls: state.toolCalls,
    completedTurns: state.completedTurns,
  };
}

async function importFromBuild(sourcePath: string, state: CodexBuildState): Promise<ImportedSession> {
  const inspection = inspectionFromBuild(sourcePath, state);
  const initial = inspection.transcript.find((message) => message.role === 'user');
  if (!initial) throw new Error('Codex session initial user message disappeared during import.');
  const environment = await historicalEnvironment(inspection.cwd);
  return {
    source: { productId: 'codex', sessionId: inspection.sessionId, sourcePath },
    initialInput: initial,
    transcript: inspection.transcript,
    historicalEvents: state.events ?? [],
    baseline: { status: inspection.finalMessage ? 'available' : 'unavailable', ...(inspection.finalMessage ? { finalMessage: inspection.finalMessage } : {}), artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', ...(inspection.sourceVersion ? { version: inspection.sourceVersion } : {}), ...(inspection.model ? { model: inspection.model } : {}), artifactRefs: [] },
    taskContext: {
      ...(inspection.cwd ? { historicalCwd: inspection.cwd } : {}),
      historicalEnvironment: environment,
      ...(inspection.historicalCommit ? { historicalCommit: inspection.historicalCommit } : {}),
      ...(state.sandbox ? { sandbox: state.sandbox } : {}),
      ...(state.approvalPolicy ? { approvalPolicy: state.approvalPolicy } : {}),
      historicalBehavior: { commands: [...state.commands].sort(), touchedPaths: [...state.touchedPaths].sort() },
      signals: inspection.signals,
    },
    provenance: { packVersion: 'codex-rollout-jsonl/v1' },
    raw: { relativePath: 'raw/session.jsonl', text: '', sourcePath },
    diagnostics: [
      ...state.diagnostics.map((item) => ({ code: item.code, message: item.message })),
      ...(state.skippedEvents ? [{ code: 'unknown-event', message: `Skipped ${state.skippedEvents} unknown event(s).` }] : []),
    ],
    signals: inspection.signals,
    recoveryReadiness: state.recoveryReadiness,
    ...(state.diagnostics.length ? { recoveryDiagnostics: state.diagnostics } : {}),
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
function recordLaterUserSummary(state: { summary?: string | undefined; laterUserSummaries: string[] }, text: string): void {
  if (looksLikeInjectedInstruction(text)) return;
  const compactText = compact(text);
  if (!state.summary) state.summary = compactText;
  else if (state.laterUserSummaries.length < 8) state.laterUserSummaries.push(compactText);
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
