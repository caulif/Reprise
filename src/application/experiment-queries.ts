import { join, resolve } from "node:path";
import { findProductPack, productPacks, defaultSessionsRoots, packLoadDiagnostics } from "../products/index.js";
import { packHas, packRoles, packRuntime, packSessions } from "../products/pack-access.js";
import type { SessionDiscoveryProject, SessionSummary } from "../products/contract.js";
import { freezeCase } from "../products/shared/freeze.js";
import { importVerifiedSession } from "../products/shared/session-recovery.js";
import { readHarnessModelConfig, publicHarnessConfig, saveHarnessModelConfig, configForDraft, emptyHarnessConfigDraft, type HarnessConfigDraft } from "../infrastructure/harness-model-config.js";
import { readLocalHistory, type HistoryExperiment } from "./experiment-history-list.js";
import { CliError } from "./cli-error.js";

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor?: string };

function paginate<T>(items: readonly T[], limit: number | undefined, cursor: string | undefined, id: (item: T) => string): Page<T> {
  const start = cursor ? items.findIndex((item) => id(item) === cursor) + 1 : 0;
  if (cursor && start === 0) throw new CliError("usage", `Unknown cursor '${cursor}'.`);
  const size = limit && limit > 0 ? limit : items.length;
  const slice = items.slice(start, start + size);
  const last = slice.at(-1);
  const more = start + slice.length < items.length;
  return { items: slice, ...(more && last ? { nextCursor: id(last) } : {}) };
}

export function listProducts(): {
  readonly products: readonly { readonly productId: string; readonly displayName: string; readonly roles: readonly ("source" | "candidate")[] }[];
  readonly diagnostics: typeof packLoadDiagnostics;
} {
  return {
    products: productPacks.map((pack) => ({
      productId: pack.manifest.productId,
      displayName: pack.manifest.displayName,
      roles: packRoles(pack),
    })),
    diagnostics: packLoadDiagnostics,
  };
}

export async function listCandidateModels(productId: string): Promise<readonly { readonly value: string; readonly displayName: string }[]> {
  const pack = findProductPack(productId);
  if (!packHas(pack, "runtime")) throw new CliError("usage", `Product '${productId}' has no runtime capability.`);
  const offers = await packRuntime(pack).listCatalog();
  return offers.map((offer) => ({ value: offer.value, displayName: offer.displayName }));
}

export async function listSourceProjects(input: {
  readonly productId: string;
  readonly dataDir: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<Page<SessionDiscoveryProject>> {
  const page = await discoverSource(input);
  const projects = uniqueProjects(page.projects ?? projectsFromSessions(page.items));
  return paginate(projects, input.limit, input.cursor, (item) => item.key);
}

export async function listSourceSessions(input: {
  readonly productId: string;
  readonly dataDir: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly project?: string;
  readonly sourcePath?: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<Page<Pick<SessionSummary, "productId" | "sessionId" | "sourcePath" | "cwd" | "summary">>> {
  const discovered = await discoverSource(input);
  if (input.sourcePath) {
    const matches = discovered.items.filter((session) => session.sourcePath === input.sourcePath);
    if (matches.length === 0) throw new CliError("not_found", `Unknown sourcePath '${input.sourcePath}'.`);
    return { items: matches.map(sessionIdentity) };
  }
  if (input.project) {
    const filtered = discovered.items.filter((session) => sessionProjectMatches(session, input.project!, discovered.projects));
    const page = paginate(filtered, input.limit ?? filtered.length, input.cursor, (item) => item.sourcePath);
    return { items: page.items.map(sessionIdentity), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  return {
    items: discovered.items.map(sessionIdentity),
    ...(discovered.nextCursor ? { nextCursor: discovered.nextCursor } : {}),
  };
}

export async function listHistoryPage(input: {
  readonly dataDir: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<Page<HistoryExperiment> & { readonly cases: number; readonly totalBytes: number }> {
  const history = await readLocalHistory(input.dataDir);
  const page = paginate(history.experiments, input.limit, input.cursor, (item) => item.experimentId);
  return { ...page, cases: history.cases.length, totalBytes: history.totalBytes };
}

export async function readPublicConfig(dataDir: string) {
  return publicHarnessConfig(await readHarnessModelConfig(dataDir));
}

export async function savePublicConfig(dataDir: string, draft: HarnessConfigDraft): Promise<ReturnType<typeof publicHarnessConfig>> {
  await saveHarnessModelConfig(dataDir, configForDraft(draft));
  return readPublicConfig(dataDir);
}

export function emptyConfigDraft(): HarnessConfigDraft {
  return emptyHarnessConfigDraft();
}

export async function readAuthStatus(dataDir: string, sessionsRoots?: Readonly<Record<string, string>>) {
  const harness = await readPublicConfig(dataDir);
  const products = await Promise.all(productPacks.map(async (pack) => ({
    productId: pack.manifest.productId,
    ...(pack.checkAuth ? await pack.checkAuth() : { configured: false }),
    ...(pack.sessions ? { sessionsRoot: sessionsRoots?.[pack.manifest.productId] ?? pack.sessions.defaultRoot } : {}),
  })));
  return { harness, products };
}

async function discoverSource(input: {
  readonly productId: string;
  readonly dataDir: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly cursor?: string;
}) {
  const pack = findProductPack(input.productId);
  if (!packHas(pack, "import")) throw new CliError("usage", `Product '${input.productId}' has no import capability.`);
  const sessions = packSessions(pack);
  const roots = { ...defaultSessionsRoots(), ...input.sessionsRoots };
  const root = resolve(roots[input.productId] ?? sessions.defaultRoot);
  return sessions.discover({
    root,
    excludeRoots: [resolve(input.dataDir)],
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
}

function sessionIdentity(session: SessionSummary) {
  return {
    productId: session.productId,
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.summary ? { summary: session.summary } : {}),
  };
}

function uniqueProjects(projects: readonly SessionDiscoveryProject[]): SessionDiscoveryProject[] {
  const seen = new Map<string, SessionDiscoveryProject>();
  for (const project of projects) seen.set(project.key, project);
  return [...seen.values()];
}

function projectsFromSessions(sessions: readonly SessionSummary[]): SessionDiscoveryProject[] {
  return uniqueProjects(sessions.map((session) => ({
    key: session.cwd ?? session.sourcePath,
    label: session.cwd ?? session.sourcePath,
    ...(session.cwd ? { path: session.cwd } : {}),
  })));
}

function sessionProjectMatches(session: SessionSummary, projectKey: string, projects: readonly SessionDiscoveryProject[] | undefined): boolean {
  if (projects?.some((project) => project.key === projectKey && (project.path ? session.cwd === project.path : true))) return true;
  return session.cwd === projectKey || session.sourcePath === projectKey;
}

export async function inspectSourceSession(input: {
  readonly productId: string;
  readonly dataDir: string;
  readonly sourcePath: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
}) {
  const listed = await listSourceSessions(input);
  const session = listed.items[0];
  if (!session) throw new CliError("not_found", `Unknown sourcePath '${input.sourcePath}'.`);
  return packSessions(findProductPack(input.productId)).inspect({
    productId: session.productId,
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
  });
}

export async function importSourceSession(input: {
  readonly productId: string;
  readonly dataDir: string;
  readonly sourcePath: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly now?: string;
}) {
  const listed = await listSourceSessions(input);
  const session = listed.items[0];
  if (!session) throw new CliError("not_found", `Unknown sourcePath '${input.sourcePath}'.`);
  const pack = findProductPack(input.productId);
  const imported = await importVerifiedSession(packSessions(pack), session, session.sourcePath);
  return freezeCase(imported, join(input.dataDir, "cases"), { allowModelText: true, allowBinary: false, redactions: [] }, input.now ?? new Date().toISOString(), { reuseExisting: true });
}
