import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SAFE_ID } from '../../core/identity.js';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import type { TaskCase } from '../../core/schema.js';
import {
  isEligibleSession,
  type ImportedSession,
  type SessionDiscoveryQuery,
  type SessionInspection,
  type SessionMessage,
  type SessionPrivacy,
  type SessionRef,
  type SessionSourceAdapter,
  type SessionSummary,
} from '../contract.js';
import { freezeCase, redactText } from '../shared/freeze.js';

export type CodexSessionSummary = SessionSummary;
export type CodexSessionInspection = SessionInspection;
export type CodexSessionPrivacy = SessionPrivacy;

/** Completed sessions with a user task and at least one assistant message or tool call. */
export const isEligible = isEligibleSession;

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const GIT_COMMIT = /^[a-f0-9]{7,64}$/i;
const execFileAsync = promisify(execFile);

/** Newest rollouts by file mtime, then inspect only until `limit` summaries exist. Does not parse the whole tree. */
export async function discoverCodexSessions(sessionsRoot: string, limit = 50): Promise<readonly CodexSessionSummary[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Session discovery limit must be a positive integer.');
  const ranked = (await rolloutEntries(resolve(sessionsRoot)))
    .filter((entry) => entry.size <= MAX_SESSION_BYTES)
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  const summaries: CodexSessionSummary[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, ranked.length) }, async () => {
    while (summaries.length < limit) {
      const index = cursor;
      cursor += 1;
      const entry = ranked[index];
      if (!entry) return;
      const summary = await inspectForDiscovery(entry.path);
      if (summary) summaries.push(summary);
    }
  });
  await Promise.all(workers);
  return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);
}

/** Discovery skips unreadable or oversized local rollouts so one archival file cannot break the whole TUI. */
async function inspectForDiscovery(sourcePath: string): Promise<CodexSessionSummary | undefined> {
  try { return await summarizeCodexSession(sourcePath); } catch { return undefined; }
}

/** Listing only needs metadata, the first user prompt, and counts — not the full transcript. */
async function summarizeCodexSession(sourcePath: string): Promise<CodexSessionSummary> {
  const source = resolve(sourcePath);
  return summaryFromBytes(source, await readSession(source));
}

function summaryFromBytes(sourcePath: string, bytes: Buffer): CodexSessionSummary {
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let summary: string | undefined;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let completedTurns = 0;
  let any = false;
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    any = true;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (error) {
      throw new Error(`Codex session ${sourcePath} has invalid JSONL at line ${index + 1}: ${errorMessage(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`Codex session ${sourcePath} has invalid JSONL at line ${index + 1}: row is not an object`);
    const payload = record(parsed.payload);
    if (parsed.type === 'session_meta') {
      sessionId = text(payload.id);
      startedAt = text(parsed.timestamp) ?? text(payload.timestamp);
      cwd = text(payload.cwd);
    }
    if (parsed.type === 'turn_context') model ??= text(payload.model);
    const payloadType = text(payload.type);
    if (parsed.type === 'event_msg') {
      const value = text(payload.message);
      if (value && payloadType === 'user_message') {
        userMessages += 1;
        summary ??= compact(value);
      } else if (value && payloadType === 'agent_message') {
        assistantMessages += 1;
      }
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') toolCalls += 1;
    if (payloadType === 'task_complete') completedTurns += 1;
  }
  if (!any) throw new Error(`Codex session ${sourcePath} is empty.`);
  if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('Codex session metadata has no valid id.');
  if (!startedAt?.match(/^\d{4}-\d{2}-\d{2}T/)) throw new Error(`Codex session ${sessionId} has no valid start time.`);
  if (!userMessages) throw new Error('Codex session has no user message eligible for replay.');
  return {
    productId: 'codex', sessionId, sourcePath, startedAt,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    signals: { userMessages, assistantMessages, toolCalls, completedTurns },
  };
}

/** Checks one complete rollout before a user chooses to freeze it. */
export async function inspectCodexSession(sourcePath: string): Promise<CodexSessionInspection> {
  const source = resolve(sourcePath);
  return inspectionFromRows(source, parseRows(await readSession(source), source));
}

export async function importCodexSession(sourcePath: string, privacy?: SessionPrivacy): Promise<ImportedSession> {
  const source = resolve(sourcePath);
  const bytes = await readSession(source);
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

export function defaultCodexSessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

export const codexSessionAdapter: SessionSourceAdapter = {
  get defaultRoot() { return defaultCodexSessionsRoot(); },
  discover(query?: SessionDiscoveryQuery) {
    return discoverCodexSessions(query?.root ?? defaultCodexSessionsRoot(), query?.limit ?? 50).then((sessions) => (
      query?.excludeRoots?.length ? sessions.filter((session) => !excludedCwd(session.cwd, query.excludeRoots)) : sessions
    ));
  },
  inspect(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session inspect requires a sourcePath.');
    return inspectCodexSession(ref.sourcePath);
  },
  import(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Codex session import requires a sourcePath.');
    return importCodexSession(ref.sourcePath);
  },
};

function excludedCwd(cwd: string | undefined, roots: readonly string[] | undefined): boolean {
  if (!cwd || !roots?.length) return false;
  const resolved = resolve(cwd);
  return roots.some((root) => {
    const base = resolve(root);
    return resolved === base || resolved.startsWith(`${base}${sep}`);
  });
}

async function rolloutEntries(root: string): Promise<Array<{ path: string; mtime: number; size: number }>> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return rolloutEntries(path);
    if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) return [];
    try {
      const info = await stat(path);
      return [{ path, mtime: info.mtimeMs, size: info.size }];
    } catch { return []; }
  }))).flat();
}

async function readSession(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Codex session is not a file: ${path}`);
  if (info.size > MAX_SESSION_BYTES) throw new Error(`Codex session exceeds the ${MAX_SESSION_BYTES / 1024 / 1024} MiB inspection limit: ${path}`);
  return readFile(path);
}

function parseRows(bytes: Buffer, sourcePath: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('row is not an object');
      rows.push(parsed);
    } catch (error) {
      throw new Error(`Codex session ${sourcePath} has invalid JSONL at line ${index + 1}: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (!rows.length) throw new Error(`Codex session ${sourcePath} is empty.`);
  return rows;
}

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
  const startedAt = text(meta?.timestamp) ?? text(payload.timestamp);
  if (!startedAt?.match(/^\d{4}-\d{2}-\d{2}T/)) throw new Error(`Codex session ${id} has no valid start time.`);
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
  const rows = parseRows(bytes, sourcePath);
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
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    return stdout.trim();
  } catch { return undefined; }
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
