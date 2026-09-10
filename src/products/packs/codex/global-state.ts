import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, text } from '../../../core/json.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DiscoveryDiagnostic } from '../../contract.js';
import type { CodexCatalogProject } from './catalog.js';

const GlobalStateSchema = Type.Object({
  'local-projects': Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  'project-order': Type.Optional(Type.Array(Type.String())),
  'projectless-thread-ids': Type.Optional(Type.Array(Type.String())),
  'thread-project-assignments': Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  'thread-workspace-root-hints': Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: true });

export type CodexGlobalState = {
  readonly projects: readonly CodexCatalogProject[];
  readonly projectsById: ReadonlyMap<string, CodexCatalogProject>;
  readonly assignments: Readonly<Record<string, string>>;
  readonly projectless: ReadonlySet<string>;
  readonly workspaceHints: Readonly<Record<string, string>>;
};

export async function readCodexGlobalState(codexHome = join(homedir(), '.codex'), diagnostics: DiscoveryDiagnostic[] = []): Promise<CodexGlobalState> {
  const empty: CodexGlobalState = { projects: [], projectsById: new Map(), assignments: {}, projectless: new Set(), workspaceHints: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'));
    if (!Value.Check(GlobalStateSchema, parsed) || !isRecord(parsed)) throw new Error('global state must be an object');
    const order = parseIds(parsed['project-order']);
    const projects = parseProjects(parsed['local-projects'], order, diagnostics);
    const byId = new Map(projects.map((project) => [project.id, project]));
    return {
      projects, projectsById: byId,
      assignments: parseAssignments(parsed['thread-project-assignments'], byId, diagnostics),
      projectless: new Set(parseIds(parsed['projectless-thread-ids'])),
      workspaceHints: parseStringMap(parsed['thread-workspace-root-hints']),
    };
  } catch (error) {
    diagnostics.push({ code: 'global-state-unavailable', count: 1, samplePath: '.codex-global-state.json' });
    return empty;
  }
}

function parseProjects(value: unknown, order: readonly string[], diagnostics: DiscoveryDiagnostic[]): CodexCatalogProject[] {
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((item) => {
    if (!isRecord(item)) { diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: '.codex-global-state.json' }); return []; }
    const id = text(item.id); const name = text(item.name);
    const roots = Array.isArray(item.rootPaths) ? item.rootPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0) : [];
    if (!id || !name) { diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: '.codex-global-state.json' }); return []; }
    const position = order.indexOf(id);
    return [{ id, name, rootPaths: roots, ...(position >= 0 ? { order: position } : {}) }];
  }).sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
}
function parseIds(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []; }
function parseStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string' && item.length > 0) result[key] = item;
  return result;
}
function parseAssignments(value: unknown, projects: ReadonlyMap<string, CodexCatalogProject>, diagnostics: DiscoveryDiagnostic[]): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([thread, assignment]) => {
    const project = isRecord(assignment) ? text(assignment.projectId) : undefined;
    if (!project) {
      diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: '.codex-global-state.json' });
      return [];
    }
    if (!projects.has(project)) diagnostics.push({ code: 'invalid-metadata', count: 1, samplePath: '.codex-global-state.json' });
    return [[thread, project]];
  }));
}
