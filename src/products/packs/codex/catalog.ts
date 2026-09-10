import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAFE_ID } from '../../../core/identity.js';
import { isFsAbsolute, pathContainedBy, stripWindowsExtendedPrefix } from '../../../core/paths.js';
import { text } from '../../../core/json.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DiscoveryDiagnostic, SessionSummary } from '../../contract.js';
import { peekJsonlSessionId } from '../../shared/jsonl-io.js';
import { peekCodexSessionMetaId } from './protocol.js';
import { readCodexGlobalState, type CodexGlobalState } from './global-state.js';
import { classifyCodexProject } from './project-attribution.js';

export type CodexCatalogOptions = {
  readonly codexHome?: string;
  readonly sessionsRoot?: string;
  readonly sessionIdsByPath?: ReadonlyMap<string, string>;
};
export type CodexCatalog = { readonly sessions: readonly SessionSummary[]; readonly projects: readonly CodexCatalogProject[]; readonly diagnostics: readonly DiscoveryDiagnostic[] };
export type CodexCatalogProject = { readonly id: string; readonly name: string; readonly rootPaths: readonly string[]; readonly order?: number };

type SqlRow = Record<string, unknown>;
const NullableText = Type.Union([Type.String(), Type.Null()]);
const CodexThreadRowSchema = Type.Object({
  id: Type.String(),
  rollout_path: Type.Optional(NullableText),
  created_at: Type.Optional(Type.Unknown()),
  updated_at: Type.Optional(Type.Unknown()),
  cwd: Type.Optional(NullableText),
  title: Type.Optional(NullableText),
  preview: Type.Optional(NullableText),
  model: Type.Optional(NullableText),
  has_user_event: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
  archived: Type.Optional(Type.Union([Type.Number(), Type.Boolean(), Type.Null()])),
  project_id: Type.Optional(NullableText),
}, { additionalProperties: true });
const CATALOG_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export async function readCodexCatalog(options: CodexCatalogOptions = {}): Promise<CodexCatalog> {
  const codexHome = resolve(options.codexHome ?? join(homedir(), '.codex'));
  const sessionsRoot = resolve(options.sessionsRoot ?? join(codexHome, 'sessions'));
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (!existsSync(join(codexHome, 'state_5.sqlite')) && !existsSync(join(codexHome, '.codex-global-state.json'))) {
    diagnostics.push({ code: 'catalog-unavailable', count: 1, samplePath: codexHome });
    return { sessions: [], projects: [], diagnostics };
  }
  const global = await readCodexGlobalState(codexHome, diagnostics);
  const projects = global.projects;
  const databasePath = join(codexHome, 'state_5.sqlite');
  const sessions = existsSync(databasePath)
    ? readStateThreads(databasePath, sessionsRoot, global, diagnostics, options.sessionIdsByPath)
    : [];
  return { sessions, projects, diagnostics };
}

function readStateThreads(
  databasePath: string,
  sessionsRoot: string,
  global: CodexGlobalState,
  diagnostics: DiscoveryDiagnostic[],
  sessionIdsByPath: ReadonlyMap<string, string> | undefined,
): SessionSummary[] {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String((row as SqlRow).name)));
    if (!tables.has('threads')) {
      diagnostics.push({ code: 'catalog-schema-unsupported', count: 1, samplePath: 'state_5.sqlite' });
      return [];
    }
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((row) => String((row as SqlRow).name)));
    // rollout_path is optional: Desktop index rows without a local transcript remain catalog-only.
    const required = ['id'];
    if (required.some((column) => !columns.has(column))) {
      diagnostics.push({ code: 'catalog-schema-unsupported', count: 1, samplePath: 'state_5.sqlite' });
      return [];
    }
    const selected = ['id', 'rollout_path', 'created_at', 'updated_at', 'cwd', 'title', 'preview', 'model', 'has_user_event', 'archived', 'project_id']
      .filter((column) => columns.has(column));
    const rows = database.prepare(`SELECT ${selected.join(', ')} FROM threads`).all() as SqlRow[];
    return rows.flatMap((row) => Value.Check(CodexThreadRowSchema, row) ? catalogSummary(row, sessionsRoot, global, diagnostics, sessionIdsByPath) : (diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: 'state_5.sqlite' }), []));
  } catch (error) {
    diagnostics.push({ code: 'catalog-read-error', count: 1, samplePath: 'state_5.sqlite' });
    return [];
  } finally {
    database?.close();
  }
}

function catalogSummary(
  row: SqlRow,
  sessionsRoot: string,
  global: CodexGlobalState,
  diagnostics: DiscoveryDiagnostic[],
  sessionIdsByPath: ReadonlyMap<string, string> | undefined,
): SessionSummary[] {
  const id = text(row.id);
  if (!id || !SAFE_ID.test(id) || !CATALOG_ID.test(id)) {
    diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: 'state_5.sqlite' });
    return [];
  }
  const candidate = safeRolloutPath(text(row.rollout_path), sessionsRoot);
  const rolloutPath = candidate && rolloutMatchesThread(id, candidate, sessionIdsByPath) ? candidate : undefined;
  if (text(row.rollout_path) && !rolloutPath) diagnostics.push({ code: 'source-missing', count: 1, samplePath: 'state_5.sqlite' });
  const assigned = global.assignments[id];
  const databaseProject = text(row.project_id);
  const workspaceHint = global.workspaceHints[id];
  const rowCwd = text(row.cwd);
  const attribution = classifyCodexProject({
    threadId: id,
    projectless: global.projectless,
    projectsById: global.projectsById,
    ...(assigned ? { assignment: assigned } : {}),
    ...(databaseProject ? { sqliteProjectId: databaseProject } : {}),
    ...(workspaceHint ? { workspaceHint } : {}),
    ...(rowCwd ? { cwd: rowCwd } : {}),
  });
  if (assigned && databaseProject && assigned !== databaseProject) diagnostics.push({ code: 'conflicting-project-source', count: 1, samplePath: 'state_5.sqlite' });
  if (attribution.projectRoot && workspaceHint && !pathContainedBy(attribution.projectRoot, workspaceHint) && !pathContainedBy(workspaceHint, attribution.projectRoot)) {
    diagnostics.push({ code: 'conflicting-project-source', count: 1, samplePath: '.codex-global-state.json' });
  }
  if (attribution.projectRoot && rowCwd && !pathContainedBy(attribution.projectRoot, rowCwd)) {
    diagnostics.push({ code: 'conflicting-project-source', count: 1, samplePath: 'state_5.sqlite' });
  }
  const cwd = attribution.projectRoot ?? workspaceHint ?? rowCwd;
  const sourcePath = rolloutPath ?? join(sessionsRoot, '.catalog', `${id}.jsonl`);
  const createdAt = instant(row.created_at);
  const updatedAt = instant(row.updated_at) ?? createdAt;
  const sourceKind = attribution.classification === 'projectless'
    ? 'projectless'
    : attribution.classification === 'unknown' ? 'unknown' : rolloutPath ? 'catalog+transcript' : 'catalog-only';
  return [{
    productId: 'codex', sessionId: id, sourcePath,
    ...(createdAt ? { startedAt: createdAt, startedAtSource: 'event' as const } : {}),
    ...(updatedAt ? { updatedAt, updatedAtSource: 'event' as const } : {}),
    ...(cwd ? { cwd } : {}), ...(text(row.model) ? { model: text(row.model) } : {}),
    ...(text(row.title) || text(row.preview) ? { summary: text(row.title) ?? text(row.preview) } : {}),
    partial: true, ...(rolloutPath ? { evidenceLevel: 'transcript' as const } : {}),
    sourceKind,
    availability: rolloutPath ? 'indexed' : 'catalog-only',
    signals: { userMessages: Number(row.has_user_event) > 0 ? 1 : 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  } as SessionSummary];
}

function safeRolloutPath(value: string | undefined, sessionsRoot: string): string | undefined {
  if (!value) return undefined;
  const stripped = stripWindowsExtendedPrefix(value);
  const resolved = isFsAbsolute(stripped) ? stripped : resolve(sessionsRoot, stripped);
  if (!pathContainedBy(sessionsRoot, resolved)) return undefined;
  try {
    if (!lstatSync(resolved).isFile()) return undefined;
    const realFile = stripWindowsExtendedPrefix(realpathSync(resolved));
    const realRoot = stripWindowsExtendedPrefix(realpathSync(sessionsRoot));
    if (!pathContainedBy(realRoot, realFile)) return undefined;
    return realFile;
  } catch {
    return undefined;
  }
}

function rolloutMatchesThread(
  threadId: string,
  candidate: string,
  sessionIdsByPath: ReadonlyMap<string, string> | undefined,
): boolean {
  const known = sessionIdsByPath?.get(catalogPathKey(candidate));
  if (known) return known === threadId;
  return peekJsonlSessionId(candidate, peekCodexSessionMetaId) === threadId;
}

export function catalogPathKey(path: string): string {
  return stripWindowsExtendedPrefix(path).replaceAll('\\', '/').toLowerCase();
}

function instant(value: unknown): string | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const millis = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

