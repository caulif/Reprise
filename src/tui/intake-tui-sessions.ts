import type { CodexIntakeTui } from "./intake-tui.js";
import { type DiscoveryDiagnostic, type SessionSummary } from "../products/contract.js";
import { type SessionProject, selectDefaultProjectIndex } from "./pages/intake.js";
import { readLocalHistory } from "./local-history.js";
import {
  groupedProjects as groupIntakeProjects,
  visibleProjects as listVisibleProjects,
  visibleSessions as listVisibleSessions,
  intakeCount as countIntakeItems,
  productItems as listProductItems,
} from "./controller-view.js";
import {
  loadProductSessions as fetchProductSessions,
  loadMoreProductSessions as fetchMoreProductSessions,
  refreshProductSessions as refetchProductSessions,
} from "./controller-sessions.js";
import { t, type Locale } from "./i18n.js";
type SessionLoadMode = "initial" | "more" | "refresh";

export async function CodexIntakeTui_loadHome(this: CodexIntakeTui, initialMessage?: string): Promise<void> {
    void this.refreshProductAuth();
    const token = this.beginNavigation();
    try {
      this.recentExperiment = (
        await readLocalHistory(this.dataDir)
      ).experiments[0];
      if (token !== this.generation) return;
    } catch {
      if (token !== this.generation) return;
      this.recentExperiment = undefined;
    }
    this.page = "home";
    this.message = initialMessage ?? t(this.locale, "welcomeBack");
  }

export async function CodexIntakeTui_loadSessions(this: CodexIntakeTui): Promise<void> {
    this.beginNavigation();
    this.intakeLevel = "products";
    const last = this.lastProductId || this.activeProductId;
    this.activeProductId = "";
    const index = last ? this.packs.findIndex((pack) => pack.manifest.productId === last) : 0;
    this.selected = index >= 0 ? index : 0;
    this.searchQuery = "";
    this.searchCursor = 0;
    this.searching = false;
    this.page = "sessions";
    this.message = t(this.locale, "chooseAgentProduct");
    this.render(true);
  }

export async function CodexIntakeTui_loadProductSessions(this: CodexIntakeTui, productId: string, mode: SessionLoadMode = "initial"): Promise<void> {
    return await fetchProductSessions(this, productId, mode);
  }

export function CodexIntakeTui_loadMoreProductSessions(this: CodexIntakeTui): void {
    return fetchMoreProductSessions(this);
  }

export function CodexIntakeTui_refreshProductSessions(this: CodexIntakeTui): void {
    return refetchProductSessions(this);
  }

export function CodexIntakeTui_activateProductSessions(this: CodexIntakeTui, productId: string, sessions: readonly SessionSummary[], limitReached: boolean): void {
    this.activeProductId = productId;
    this.lastProductId = productId;
    this.sessions = sessions;
    this.sessionLimitReached = limitReached;
    this.searchQuery = "";
    this.searchCursor = 0;
    this.searching = false;
    this.intakeLevel = "projects";
    const projects = this.visibleProjects();
    this.selected = selectDefaultProjectIndex(projects, this.displayCwd, this.lastProjectKey, this.dataDir);
    this.activeProjectKey = projects[this.selected]?.key ?? "";
    this.syncIntakeLevel();
    this.page = "sessions";
    this.message = this.sessionsMessage();
  }

export function CodexIntakeTui_openIntakeSelection(this: CodexIntakeTui): { consume: true } {
    if (this.intakeLevel === "products") {
      const pack = this.packs[this.selected];
      if (pack) void this.loadProductSessions(pack.manifest.productId);
      return { consume: true };
    }
    if (this.intakeLevel === "projects") {
      const project = this.visibleProjects()[this.selected];
      if (!project) return { consume: true };
      this.activeProjectKey = project.key;
      this.lastProjectKey = project.key;
      this.intakeLevel = "sessions";
      this.selected = 0;
      this.searching = false;
      this.searchQuery = "";
      this.searchCursor = 0;
      this.message = this.sessionsMessage();
      this.render();
      return { consume: true };
    }
    const selected = this.visibleSessions()[this.selected];
    if (!selected) return { consume: true };
    void CodexIntakeTui_openSessionInspection.call(this, selected);
    return { consume: true };
}

export function CodexIntakeTui_sessionsMessage(this: CodexIntakeTui): string {
    if (this.intakeLevel === "products") return t(this.locale, "chooseAgentProduct");
    const discovery = this.activeProductId ? this.productDiscovery.get(this.activeProductId) : undefined;
    if (discovery?.status === "loading") return t(this.locale, "sessionsLoading");
    const projects = this.groupedProjects();
    const loaded = t(this.locale, "catalogLoaded", { projects: projects.length, sessions: this.sessions.length });
    const skipped = discovery?.skipped ?? 0;
    const scanned = discovery?.scanned ?? this.sessions.length;
    const status = t(this.locale, "sessionDiscoveryStatus", { shown: this.sessions.length, skipped, scanned });
    const lines = [
      this.sessions.length
        ? this.intakeLevel === "projects" ? t(this.locale, "chooseProject") : t(this.locale, "chooseSession")
        : t(this.locale, "noSessionsFound"),
      loaded,
      `${status}.`,
      t(this.locale, "loadMoreSessions"),
    ];
    if (discovery?.diagnostics?.length) {
      lines.push(t(this.locale, "sessionDiagnostics", {
        diagnostics: discovery.diagnostics.map((diagnostic: DiscoveryDiagnostic) => `${this.discoveryDiagnosticLabel(this.locale, diagnostic.code)} (${diagnostic.count})`).join(", "),
      }) + ".");
    }
    return lines.join("\n");
  }

export function CodexIntakeTui_discoveryDiagnosticLabel(this: CodexIntakeTui, locale: Locale, code: DiscoveryDiagnostic['code']): string {
  if (code === 'history-without-transcript') return t(locale, 'historyWithoutTranscript');
  if (code === 'source-missing') return t(locale, 'sourceMissingDiagnostic');
  if (code === 'duplicate-source') return t(locale, 'duplicateSourceDiagnostic');
  if (code === 'invalid-jsonl') return t(locale, 'catalogInvalidJsonl');
  if (code === 'catalog-unavailable') return t(locale, 'catalogUnavailable');
  return code;
}

export async function CodexIntakeTui_refreshProductAuth(this: CodexIntakeTui): Promise<void> {
    const statuses = await Promise.all(this.packs.map(async (pack) => ({
      productId: pack.manifest.productId,
      status: await pack.checkAuth(),
    })));
    this.productAuth.clear();
    for (const { productId, status } of statuses) this.productAuth.set(productId, status.configured);
  }

export function CodexIntakeTui_canLeaveProject(this: CodexIntakeTui): boolean {
    return this.intakeLevel !== "products";
  }

export function CodexIntakeTui_backToProjects(this: CodexIntakeTui): { consume: true } {
    if (this.intakeLevel === "projects") {
      this.discoveryAbort?.abort();
      this.beginNavigation();
      this.intakeLevel = "products";
      this.selected = Math.max(0, this.packs.findIndex((pack) => pack.manifest.productId === this.activeProductId));
      this.activeProductId = "";
    } else {
      this.intakeLevel = "projects";
      this.selected = Math.max(0, this.visibleProjects().findIndex((project) => project.key === this.activeProjectKey));
    }
    this.searching = false;
    this.searchQuery = "";
    this.searchCursor = 0;
    this.message = this.sessionsMessage();
    this.render();
    return { consume: true };
  }

export function CodexIntakeTui_syncIntakeLevel(this: CodexIntakeTui): void {
    const projects = this.groupedProjects();
    if (!this.activeProjectKey || !projects.some((project) => project.key === this.activeProjectKey)) {
      this.activeProjectKey = projects[0]?.key ?? "";
    }
    if (this.intakeLevel === "sessions" && !projects.some((project) => project.key === this.activeProjectKey)) {
      this.intakeLevel = "projects";
    }
  }

export function CodexIntakeTui_groupedProjects(this: CodexIntakeTui): SessionProject[] {
    return groupIntakeProjects(this);
  }

export function CodexIntakeTui_visibleProjects(this: CodexIntakeTui): SessionProject[] {
    return listVisibleProjects(this);
  }

export function CodexIntakeTui_visibleSessions(this: CodexIntakeTui): readonly SessionSummary[] {
    return listVisibleSessions(this);
  }

export function CodexIntakeTui_intakeCount(this: CodexIntakeTui): number {
    return countIntakeItems(this);
  }

export function CodexIntakeTui_productItems(this: CodexIntakeTui): import("./pages/intake.js").ProductIntakeItem[] {
    return listProductItems(this);
  }

async function CodexIntakeTui_openSessionInspection(this: CodexIntakeTui, session: SessionSummary): Promise<void> {
  const pack = this.packs.find((item) => item.manifest.productId === session.productId);
  if (!pack) {
    this.showError(new Error(`No Product Pack is registered for session ${session.productId}.`), "sessions");
    this.render(true);
    return;
  }
  const token = this.beginNavigation();
  this.message = t(this.locale, "inspectingSelectedSession");
  this.render(true);
  try {
    const inspected = await pack.sessions.inspect({
      productId: session.productId,
      sessionId: session.sessionId,
      sourcePath: session.sourcePath,
    });
    if (token !== this.generation) return;
    if (!inspected.transcript.some((message) => message.role === "user")) {
      this.showError(new Error(t(this.locale, "notReplayableNoUserInput")), "sessions");
      this.render(true);
      return;
    }
    this.inspection = inspected;
    this.inspectionTaskInput = 0;
    this.page = "inspection";
    this.message = t(this.locale, "chooseSession");
  } catch (error) {
    if (token !== this.generation) return;
    this.showError(error, "sessions");
  }
  this.render(true);
}
