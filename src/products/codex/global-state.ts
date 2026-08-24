import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, text } from '../../core/json.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DiscoveryDiagnostic } from '../contract.js';
import type { CodexCatalogProject } from './catalog.js';

const GlobalStateSchema = Type.Record(Type.String(), Type.Unknown());

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
    const projects = parseProjects(parsed['local-projects']);
    const byId = new Map(projects.map((project) => [project.id, project]));
    return {
      projects, projectsById: byId,
      assignments: parseAssignments(parsed['thread-project-assignments']),
      projectless: new Set(parseIds(parsed['projectless-thread-ids'])),
      workspaceHints: parseStringMap(parsed['thread-workspace-root-hints']),
    };
  } catch (error) {
    diagnostics.push({ code: 'global-state-unavailable', count: 1, samplePath: '.codex-global-state.json' });
    return empty;
  }
}

function parseProjects(value: unknown): CodexCatalogProject[] {
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = text(item.id); const name = text(item.name);
    const roots = Array.isArray(item.rootPaths) ? item.rootPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0) : [];
    return id && name ? [{ id, name, rootPaths: roots }] : [];
  });
}
function parseIds(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []; }
function parseStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string' && item.length > 0) result[key] = item;
  return result;
}
function parseAssignments(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([thread, assignment]) => {
    const project = isRecord(assignment) ? text(assignment.projectId) : undefined;
    return project ? [[thread, project]] : [];
  }));
}
