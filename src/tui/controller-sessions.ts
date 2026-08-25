import { resolve } from "node:path";
import type { CodexIntakeTui } from "./controller.js";
import { compareSessionSummaries } from "../products/contract.js";
import type { DiscoveryDiagnostic } from "../products/contract.js";
import { operatorErrorMessage } from "./format.js";
import { t } from "./i18n.js";

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

export async function loadProductSessions(c: CodexIntakeTui, productId: string, mode: SessionLoadMode = "initial"): Promise<void> {
  const pack = c.packs.find((item) => item.manifest.productId === productId);
  if (!pack) return;
  const root = resolve(c.sessionsRoots[productId] ?? pack.sessions.defaultRoot);
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
    const discovered = await pack.sessions.discover({
      root,
      excludeRoots: [c.dataDir, process.cwd()],
      signal: abort.signal,
      ...(mode === "refresh" ? { refresh: true } : {}),
    });
    const invalid = discovered.items.find((session) => session.productId !== productId);
    if (invalid) throw new Error(`Session adapter for ${productId} returned ${invalid.productId}.`);
    if (token !== c.generation || abort.signal.aborted) return;
    const sessions = [...discovered.items]
      .sort(compareSessionSummaries);
    const rootDiagnostics = discovered.rootDiagnostics ?? [];
    const pageDiagnostics = discovered.pageDiagnostics ?? (discovered.rootDiagnostics ? [] : discovered.diagnostics);
    const accumulatedPageDiagnostics = mergeDiscoveryDiagnostics(
      undefined,
      pageDiagnostics,
    );
    const diagnostics = mergeDiscoveryDiagnostics(rootDiagnostics, accumulatedPageDiagnostics);
    c.productSessions.set(productId, sessions);
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
    c.activateProductSessions(productId, sessions, false);
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

export function loadMoreProductSessions(c: CodexIntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "more");
}

export function refreshProductSessions(c: CodexIntakeTui): void {
  if (c.activeProductId) void c.loadProductSessions(c.activeProductId, "refresh");
}
