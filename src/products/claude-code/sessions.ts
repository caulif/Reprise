import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { SAFE_ID } from '../../core/identity.js';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import type {
  ImportDiagnostic,
  ImportedSession,
  SessionDiscoveryQuery,
  SessionInspection,
  SessionMessage,
  SessionRef,
  SessionSourceAdapter,
  SessionSummary,
} from '../contract.js';

const PRODUCT_ID = 'claude-code';
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const SKIP_TYPES = new Set([
  'attachment', 'last-prompt', 'mode', 'permission-mode', 'ai-title', 'custom-title',
  'agent-name', 'file-history-snapshot', 'file-history-delta', 'queue-operation',
]);
const META_FLAGS = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain'] as const;

export function defaultClaudeSessionsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export const claudeSessionAdapter: SessionSourceAdapter = {
  get defaultRoot() { return defaultClaudeSessionsRoot(); },
  discover(query?: SessionDiscoveryQuery) {
    return discoverClaudeSessions(query?.root ?? defaultClaudeSessionsRoot(), query?.limit ?? 50, query?.excludeRoots);
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

export async function discoverClaudeSessions(sessionsRoot: string, limit = 50, excludeRoots?: readonly string[]): Promise<readonly SessionSummary[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Session discovery limit must be a positive integer.');
  const ranked = (await jsonlEntries(resolve(sessionsRoot)))
    .filter((entry) => entry.size <= MAX_SESSION_BYTES)
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  const summaries: SessionSummary[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, ranked.length) }, async () => {
    while (summaries.length < limit) {
      const index = cursor;
      cursor += 1;
      const entry = ranked[index];
      if (!entry) return;
      const summary = await inspectForDiscovery(entry.path);
      if (!summary || excludedCwd(summary.cwd, excludeRoots)) continue;
      summaries.push(summary);
    }
  });
  await Promise.all(workers);
  return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);
}

export async function inspectClaudeSession(sourcePath: string): Promise<SessionInspection> {
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
    transcript: imported.transcript,
    ...(finalMessage ? { finalMessage } : {}),
    ...(version ? { sourceVersion: version } : {}),
    ...(commit ? { historicalCommit: commit } : {}),
  };
}

export async function importClaudeSession(sourcePath: string): Promise<ImportedSession> {
  const source = resolve(sourcePath);
  const bytes = await readSession(source);
  return importFromBytes(source, bytes);
}

async function inspectForDiscovery(sourcePath: string): Promise<SessionSummary | undefined> {
  try {
    const inspection = await inspectClaudeSession(sourcePath);
    return {
      productId: inspection.productId,
      sessionId: inspection.sessionId,
      sourcePath: inspection.sourcePath,
      startedAt: inspection.startedAt,
      ...(inspection.cwd ? { cwd: inspection.cwd } : {}),
      ...(inspection.model ? { model: inspection.model } : {}),
      ...(inspection.summary ? { summary: inspection.summary } : {}),
      signals: inspection.signals,
    };
  } catch {
    return undefined;
  }
}

async function importFromBytes(sourcePath: string, bytes: Buffer): Promise<ImportedSession> {
  const fileId = basename(sourcePath, '.jsonl');
  const rows = parseRows(bytes, sourcePath);
  const diagnostics: ImportDiagnostic[] = [];
  let unknownTypes = 0;
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let gitBranch: string | undefined;
  let effort: string | undefined;
  let permissionMode: string | undefined;
  let compaction = false;
  let model: string | undefined;
  const transcript: SessionMessage[] = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let completedTurns = 0;
  const eligibleUsers: SessionMessage[] = [];

  for (const [index, row] of rows.entries()) {
    const type = text(row.type);
    const rowSessionId = text(row.sessionId);
    if (rowSessionId) {
      if (sessionId && rowSessionId !== sessionId) {
        diagnostics.push({ code: 'session-id-mismatch', message: `Row ${index + 1} sessionId ${rowSessionId} differs from ${sessionId}.` });
      }
      sessionId ??= rowSessionId;
    }
    startedAt ??= text(row.timestamp);
    cwd ??= text(row.cwd);
    version ??= text(row.version);
    gitBranch ??= text(row.gitBranch);
    effort ??= text(row.effort) ?? text(record(row.message).effort);
    permissionMode ??= text(row.permissionMode) ?? text(row['permission-mode']);

    if (!type || SKIP_TYPES.has(type)) continue;
    if (type === 'system') {
      if (text(row.subtype) === 'compact_boundary') {
        compaction = true;
        diagnostics.push({ code: 'compact-boundary', message: 'Transcript has an unrecoverable compaction gap.' });
      }
      continue;
    }
    if (type === 'user') {
      const parsed = parseUserRow(row, index);
      if (parsed.kind === 'user') {
        userMessages += 1;
        transcript.push(parsed.message);
        if (!parsed.meta) eligibleUsers.push(parsed.message);
      } else if (parsed.kind === 'tool') {
        transcript.push(parsed.message);
      }
      continue;
    }
    if (type === 'assistant') {
      const parsed = parseAssistantRow(row, index);
      toolCalls += parsed.toolCalls;
      completedTurns += parsed.completedTurn ? 1 : 0;
      if (parsed.model && parsed.model !== '<synthetic>') model = parsed.model;
      if (parsed.apiError) {
        continue;
      }
      assistantMessages += parsed.assistantMessages;
      transcript.push(...parsed.messages);
      continue;
    }
    unknownTypes += 1;
  }

  if (unknownTypes) diagnostics.push({ code: 'unknown-types', message: `Skipped ${unknownTypes} unknown row type(s).` });
  if (!sessionId) sessionId = SAFE_ID.test(fileId) ? fileId : undefined;
  if (sessionId && fileId && sessionId !== fileId) {
    diagnostics.push({ code: 'filename-mismatch', message: `Filename ${fileId} does not match sessionId ${sessionId}.` });
  }
  if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('Claude session metadata has no valid id.');
  if (!startedAt?.match(/^\d{4}-\d{2}-\d{2}T/)) throw new Error(`Claude session ${sessionId} has no valid start time.`);
  const initial = eligibleUsers[0] ?? transcript.find((message) => message.role === 'user');
  if (!initial) throw new Error('Claude session has no user message eligible for replay.');
  const finalMessage = [...transcript].reverse().find((message) => message.role === 'assistant')?.text;
  const signals = { userMessages, assistantMessages, toolCalls, completedTurns };
  return {
    source: { productId: PRODUCT_ID, sessionId, sourcePath },
    initialInput: initial,
    transcript,
    historicalEvents: rows,
    baseline: { status: finalMessage ? 'available' : 'unavailable', ...(finalMessage ? { finalMessage } : {}), artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: PRODUCT_ID, ...(version ? { version } : {}), ...(model ? { model } : {}), artifactRefs: [] },
    taskContext: {
      ...(cwd ? { historicalCwd: cwd } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(effort ? { effort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(compaction ? { compaction: true } : {}),
      historicalBehavior: historicalBehavior(rows),
      signals,
    },
    provenance: { packVersion: 'claude-code-session-jsonl/v1' },
    raw: { relativePath: 'raw/session.jsonl', text: bytes.toString('utf8') },
    diagnostics,
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

async function jsonlEntries(root: string): Promise<Array<{ path: string; mtime: number; size: number }>> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return jsonlEntries(path);
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return [];
    try {
      const info = await stat(path);
      return [{ path, mtime: info.mtimeMs, size: info.size }];
    } catch { return []; }
  }))).flat();
}

async function readSession(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Claude session is not a file: ${path}`);
  if (info.size > MAX_SESSION_BYTES) throw new Error(`Claude session exceeds the ${MAX_SESSION_BYTES / 1024 / 1024} MiB inspection limit: ${path}`);
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
      throw new Error(`Claude session ${sourcePath} has invalid JSONL at line ${index + 1}: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (!rows.length) throw new Error(`Claude session ${sourcePath} is empty.`);
  return rows;
}

function excludedCwd(cwd: string | undefined, roots: readonly string[] | undefined): boolean {
  if (!cwd || !roots?.length) return false;
  const resolved = resolve(cwd);
  return roots.some((root) => {
    const base = resolve(root);
    return resolved === base || resolved.startsWith(`${base}${sep}`);
  });
}

function startedAtFrom(imported: ImportedSession): string {
  const first = imported.historicalEvents[0];
  return text(record(first).timestamp) ?? new Date(0).toISOString();
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
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
