import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SAFE_ID } from '../../core/identity.js';
import { text } from '../../core/json.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DiscoveryDiagnostic, SessionSummary } from '../contract.js';
import { readCodexGlobalState, type CodexGlobalState } from './global-state.js';

export type CodexCatalogOptions = { readonly codexHome?: string; readonly sessionsRoot?: string };
export type CodexCatalog = { readonly sessions: readonly SessionSummary[]; readonly projects: readonly CodexCatalogProject[]; readonly diagnostics: readonly DiscoveryDiagnostic[] };
export type CodexCatalogProject = { readonly id: string; readonly name: string; readonly rootPaths: readonly string[]; readonly order?: number };

type SqlRow = Record<string, unknown>;
const NullableText = Type.Union([Type.String(), Type.Null()]);
const CodexThreadRowSchema = Type.Object({
  id: Type.String(),
  rollout_path: NullableText,
  created_at: Type.Unknown(),
  updated_at: Type.Unknown(),
  cwd: NullableText,
  title: NullableText,
  preview: NullableText,
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
  if (!existsSync(join(codexHome, 'state_5.sqlite')) && !existsSync(join(codexHome, '.codex-global-state.json'))) return { sessions: [], projects: [], diagnostics };
  const global = await readCodexGlobalState(codexHome, diagnostics);
  const projects = global.projects;
  const databasePath = join(codexHome, 'state_5.sqlite');
  const sessions = existsSync(databasePath) ? readStateThreads(databasePath, sessionsRoot, global, diagnostics) : [];
  return { sessions, projects, diagnostics };
}

function readStateThreads(databasePath: string, sessionsRoot: string, global: CodexGlobalState, diagnostics: DiscoveryDiagnostic[]): SessionSummary[] {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String((row as SqlRow).name)));
    if (!tables.has('threads')) {
      diagnostics.push({ code: 'catalog-schema-unsupported', count: 1, samplePath: 'state_5.sqlite' });
      return [];
    }
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((row) => String((row as SqlRow).name)));
    const required = ['id', 'rollout_path'];
    if (required.some((column) => !columns.has(column))) {
      diagnostics.push({ code: 'catalog-schema-unsupported', count: 1, samplePath: 'state_5.sqlite' });
      return [];
    }
    const selected = ['id', 'rollout_path', 'created_at', 'updated_at', 'cwd', 'title', 'preview', 'model', 'has_user_event', 'archived', 'project_id']
      .filter((column) => columns.has(column));
    const rows = database.prepare(`SELECT ${selected.join(', ')} FROM threads`).all() as SqlRow[];
    return rows.flatMap((row) => Value.Check(CodexThreadRowSchema, row) ? catalogSummary(row, sessionsRoot, global, diagnostics) : (diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: 'state_5.sqlite' }), []));
  } catch (error) {
    diagnostics.push({ code: 'catalog-read-error', count: 1, samplePath: 'state_5.sqlite' });
    return [];
  } finally {
    database?.close();
  }
}

function catalogSummary(row: SqlRow, sessionsRoot: string, global: CodexGlobalState, diagnostics: DiscoveryDiagnostic[]): SessionSummary[] {
  const id = text(row.id);
  if (!id || !SAFE_ID.test(id) || !CATALOG_ID.test(id)) {
    diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: 'state_5.sqlite' });
    return [];
  }
  const rolloutPath = safeRolloutPath(text(row.rollout_path), sessionsRoot);
  if (text(row.rollout_path) && !rolloutPath) diagnostics.push({ code: 'source-missing', count: 1, samplePath: 'state_5.sqlite' });
  const assigned = global.assignments[id];
  const databaseProject = text(row.project_id);
  const project = assigned ? global.projectsById.get(assigned) : databaseProject ? global.projectsById.get(databaseProject) : undefined;
  const cwd = project?.rootPaths[0] ?? global.workspaceHints[id] ?? text(row.cwd);
  const projectless = global.projectless.has(id) || (!project && !cwd);
  const sourcePath = rolloutPath ?? join(sessionsRoot, '.catalog', `${id}.jsonl`);
  const createdAt = instant(row.created_at);
  const updatedAt = instant(row.updated_at) ?? createdAt;
  return [{
    productId: 'codex', sessionId: id, sourcePath,
    ...(createdAt ? { startedAt: createdAt, startedAtSource: 'event' as const } : {}),
    ...(updatedAt ? { updatedAt, updatedAtSource: 'event' as const } : {}),
    ...(cwd ? { cwd } : {}), ...(text(row.model) ? { model: text(row.model) } : {}),
    ...(text(row.title) || text(row.preview) ? { summary: text(row.title) ?? text(row.preview) } : {}),
    partial: true, evidenceLevel: 'history',
    sourceKind: rolloutPath ? (projectless ? 'projectless' : 'catalog+transcript') : (projectless ? 'projectless' : 'catalog-only'),
    availability: rolloutPath ? 'indexed' : 'catalog-only',
    signals: { userMessages: Number(row.has_user_event) > 0 ? 1 : 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  } as SessionSummary];
}

function safeRolloutPath(value: string | undefined, sessionsRoot: string): string | undefined {
  if (!value) return undefined;
  const resolved = resolve(sessionsRoot, value);
  const rel = relative(sessionsRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${resolved.includes('\\') ? '\\' : '/'}`) || isAbsolute(rel)) return undefined;
  try { if (!lstatSync(resolved).isFile() || resolve(realpathSync(resolved)) !== resolve(realpathSync(sessionsRoot), relative(sessionsRoot, resolved))) return undefined; } catch { return undefined; }
  return resolved;
}
function instant(value: unknown): string | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const millis = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

