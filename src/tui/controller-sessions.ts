import type { IntakeTui } from "./intake-tui.js";
import { compareSessionSummaries } from "../application/intake-catalog.js";
import type { DiscoveryDiagnostic, SessionDiscoveryQuery, SessionSummary } from "../products/contract.js";
import { operatorErrorMessage } from "./format.js";
import { t } from "./i18n.js";
import { productMemory, rememberProjects, rememberSessions } from "./intake-layer-memory.js";

export function sessionDiscoveryQuery(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  readonly cursor?: string;
  readonly excludeSessionIds?: readonly string[];
  readonly excludeSourcePaths?: readonly string[];
}): SessionDiscoveryQuery {
  return {
    root: input.root,
    excludeRoots: [input.dataDir],
    ...(input.excludeSessionIds?.length ? { excludeSessionIds: input.excludeSessionIds } : {}),
    ...(input.excludeSourcePaths?.length ? { excludeSourcePaths: input.excludeSourcePaths } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.refresh ? { refresh: true } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

function mergeDiscoveryDiagnostics(
  previous: readonly DiscoveryDiagnostic[] | undefined,
  next: readonly DiscoveryDiagnostic[],
): readonly DiscoveryDiagnostic[] {
  const totals = new Map<string, { count: number; samplePath?: string }>();
  for (const diagnostic of [...(previous ?? []), ...next]) {
    const current = totals.get(diagnostic.code);
    totals.set(diagnostic.code, {
      count: (current?.count ?? 0) + diagnostic.count,
      ...(current?.samplePath ?? diagnostic.samplePath
        ? { samplePath: current?.samplePath ?? diagnostic.samplePath }
        : {}),
    });
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, value]) => ({
      code: code as DiscoveryDiagnostic["code"],
      count: value.count,
      ...(value.samplePath ? { samplePath: value.samplePath } : {}),
    }));
}

type SessionLoadMode = "initial" | "more" | "refresh";

function rememberCurrentSelection(c: IntakeTui): void {
  if (!c.activeProductId) return;
  const memory = productMemory(c.intakeMemory, c.activeProductId);
  if (c.intakeLevel === "projects") {
    rememberProjects(memory, c.searchQuery, c.searchCursor, c.activeProjectKey || memory.projectKey, c.selected);
    return;
  }
  if (c.intakeLevel === "sessions") {
    const selected = c.visibleSessions()[c.selected];
    rememberSessions(
      memory,
      c.activeProjectKey,
      c.searchQuery,
      c.searchCursor,
      selected?.sessionId ?? "",
      c.selected,
    );
  }
}

export async function loadProductSessions(c: IntakeTui, productId: string, mode: SessionLoadMode = "initial"): Promise<void> {
  const pack = c.packs.find((item) => item.manifest.productId === productId);
  if (!pack?.history) return;
  if (!c.workflow) throw new Error("Experiment workflow is required to discover sessions.");
  const root = c.workflow.sourceRoot(productId, c.sessionsRoots);
  const state = c.productDiscovery.get(productId);
  const cached = c.productSessions.get(productId);
  if (mode === "initial" && state?.status === "ready" && state.root === root && cached) {
    c.activateProductSessions(productId, cached, Boolean(state.nextCursor));
    c.render(true);
    return;
  }
  if (mode === "more" && !state?.nextCursor) return;
  rememberCurrentSelection(c);
  const token = c.beginNavigation();
  c.discoveryAbort?.abort();
  const abort = new AbortController();
  c.discoveryAbort = abort;
  c.activeProductId = productId;
  const previous = state?.status === "ready" ? state : undefined;
  c.productDiscovery.set(productId, {
    status: "loading",
    root,
    ...(state?.nextCursor && mode === "more" ? { nextCursor: state.nextCursor } : {}),
    ...(previous?.diagnostics ? { diagnostics: previous.diagnostics } : {}),
    ...(previous?.scanned !== undefined ? { scanned: previous.scanned } : {}),
    ...(previous?.skipped !== undefined ? { skipped: previous.skipped } : {}),
    ...(previous?.projects ? { projects: previous.projects } : {}),
  });
  c.render();
  try {
    const discovered = await c.workflow.discoverSource(productId, sessionDiscoveryQuery({
      root,
      dataDir: c.dataDir,
      signal: abort.signal,
      ...(mode === "refresh" ? { refresh: true } : {}),
      ...(mode === "more" && state?.nextCursor ? { cursor: state.nextCursor } : {}),
      ...(c.runtimeSessionIds.length ? { excludeSessionIds: c.runtimeSessionIds } : {}),
    }));
    const invalid = discovered.items.find((session) => session.productId !== productId);
    if (invalid) throw new Error(`Session adapter for ${productId} returned ${invalid.productId}.`);
    if (token !== c.generation || abort.signal.aborted) return;
    const listed = mode === "more" && cached
      ? mergeSessionPages(cached, discovered.items)
      : [...discovered.items].sort(compareSessionSummaries);
    const rootDiagnostics = discovered.rootDiagnostics ?? [];
    const pageDiagnostics = discovered.pageDiagnostics ?? (discovered.rootDiagnostics ? [] : discovered.diagnostics);
    const accumulatedPageDiagnostics = mergeDiscoveryDiagnostics(
      mode === "more" ? previous?.pageDiagnostics : undefined,
      pageDiagnostics,
    );
    const diagnostics = mergeDiscoveryDiagnostics(rootDiagnostics, accumulatedPageDiagnostics);
    c.productSessions.set(productId, listed);
    c.productDiscovery.set(productId, {
      status: "ready", root,
      ...(discovered.nextCursor ? { nextCursor: discovered.nextCursor } : {}),
      scanned: discovered.scanned,
      skipped: mode === "more"
        ? (previous?.skipped ?? 0) + discovered.skipped
        : discovered.skipped,
      diagnostics,
      ...(rootDiagnostics.length ? { rootDiagnostics } : {}),
      ...(discovered.projects ? { projects: discovered.projects } : previous?.projects ? { projects: previous.projects } : {}),
      ...(accumulatedPageDiagnostics.length ? { pageDiagnostics: accumulatedPageDiagnostics } : {}),
    });
    c.activateProductSessions(productId, listed, Boolean(discovered.nextCursor));
  } catch (error) {
    if (token !== c.generation || abort.signal.aborted) return;
    const message = operatorErrorMessage(error, c.locale);
    if ((mode === "refresh" || mode === "more") && cached && previous) {
      c.productDiscovery.set(productId, {
        ...previous,
        status: "ready",
        refreshFailed: true,
        message,
      });
      c.activateProductSessions(productId, cached, Boolean(previous.nextCursor));
      c.message = t(c.locale, "refreshFailedStale");
    } else {
      c.productDiscovery.set(productId, { status: "error", root, message });
      c.intakeLevel = "products";
      c.activeProductId = "";
      c.selected = Math.max(0, c.packs.findIndex((item) => item.manifest.productId === productId));
      c.message = t(c.locale, "chooseAgentProduct");
    }
  } finally {
    if (c.discoveryAbort === abort) c.discoveryAbort = undefined;
  }
  c.render(true);
}

function mergeSessionPages(previous: readonly SessionSummary[], next: readonly SessionSummary[]): SessionSummary[] {
  const seen = new Set(previous.map((session) => session.sessionId));
  const merged = [...previous];
  for (const session of next) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    merged.push(session);
  }
  return merged.sort(compareSessionSummaries);
}

export function loadMoreProductSessions(c: IntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "more");
}

export function refreshProductSessions(c: IntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "refresh");
}
