import { resolve } from "node:path";
import type { IntakeTui } from "./intake-tui.js";
import { packHistory } from "../products/pack-access.js";
import { compareSessionSummaries, type DiscoveryDiagnostic, type SessionDiscoveryQuery } from "../products/contract.js";
import { operatorErrorMessage } from "./format.js";
import { t } from "./i18n.js";

export function sessionDiscoveryQuery(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
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

export async function loadProductSessions(c: IntakeTui, productId: string, mode: SessionLoadMode = "initial"): Promise<void> {
  const pack = c.packs.find((item) => item.manifest.productId === productId);
  if (!pack?.history) return;
  const sessions = packHistory(pack);
  const root = resolve(c.sessionsRoots[productId] ?? sessions.defaultRoot);
  const state = c.productDiscovery.get(productId);
  const cached = c.productSessions.get(productId);
  if (mode === "initial" && state?.status === "ready" && state.root === root && cached) {
    c.activateProductSessions(productId, cached, Boolean(state.nextCursor));
    c.render(true);
    return;
  }
  if (mode === "more") return;
  const token = c.beginNavigation();
  c.discoveryAbort?.abort();
  const abort = new AbortController();
  c.discoveryAbort = abort;
  c.activeProductId = productId;
  c.productDiscovery.set(productId, { status: "loading", root, ...(state?.nextCursor ? { nextCursor: state.nextCursor } : {}) });
  c.render();
  try {
    const discovered = await sessions.discover(sessionDiscoveryQuery({
      root,
      dataDir: c.dataDir,
      signal: abort.signal,
      ...(mode === "refresh" ? { refresh: true } : {}),
      ...(c.runtimeSessionIds.length ? { excludeSessionIds: c.runtimeSessionIds } : {}),
    }));
    const invalid = discovered.items.find((session) => session.productId !== productId);
    if (invalid) throw new Error(`Session adapter for ${productId} returned ${invalid.productId}.`);
    if (token !== c.generation || abort.signal.aborted) return;
    const listed = [...discovered.items]
      .sort(compareSessionSummaries);
    const rootDiagnostics = discovered.rootDiagnostics ?? [];
    const pageDiagnostics = discovered.pageDiagnostics ?? (discovered.rootDiagnostics ? [] : discovered.diagnostics);
    const accumulatedPageDiagnostics = mergeDiscoveryDiagnostics(
      undefined,
      pageDiagnostics,
    );
    const diagnostics = mergeDiscoveryDiagnostics(rootDiagnostics, accumulatedPageDiagnostics);
    c.productSessions.set(productId, listed);
    c.productDiscovery.set(productId, {
      status: "ready", root,
      ...(discovered.nextCursor ? { nextCursor: discovered.nextCursor } : {}),
      scanned: discovered.scanned,
      skipped: discovered.skipped,
      diagnostics,
      ...(rootDiagnostics.length ? { rootDiagnostics } : {}),
      ...(discovered.projects ? { projects: discovered.projects } : {}),
      ...(accumulatedPageDiagnostics.length ? { pageDiagnostics: accumulatedPageDiagnostics } : {}),
    });
    c.activateProductSessions(productId, listed, false);
  } catch (error) {
    if (token !== c.generation || abort.signal.aborted) return;
    const message = operatorErrorMessage(error);
    c.productDiscovery.set(productId, { status: "error", root, message });
    c.intakeLevel = "products";
    c.activeProductId = "";
    c.selected = Math.max(0, c.packs.findIndex((item) => item.manifest.productId === productId));
    c.message = t(c.locale, "chooseAgentProduct");
  } finally {
    if (c.discoveryAbort === abort) c.discoveryAbort = undefined;
  }
  c.render(true);
}

export function loadMoreProductSessions(c: IntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "more");
}

export function refreshProductSessions(c: IntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "refresh");
}
