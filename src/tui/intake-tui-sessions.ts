import type { IntakeTui } from "./intake-tui.js";
import { importPacks } from "../application/intake-catalog.js";
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
import { productMemory, rememberProjects, rememberSessions, restoreById } from "./intake-layer-memory.js";
type SessionLoadMode = "initial" | "more" | "refresh";

export async function IntakeTui_loadHome(this: IntakeTui, initialMessage?: string): Promise<void> {
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
    this.homeFocus = this.recentExperiment && this.hasSavedModelConfig && this.harnessAuthOk
      ? "new-replay"
      : (!this.hasSavedModelConfig || this.harnessAuthOk === false ? "config" : "new-replay");
    this.message = initialMessage ?? t(this.locale, "welcomeBack");
  }

export async function IntakeTui_loadSessions(this: IntakeTui): Promise<void> {
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

export async function IntakeTui_loadProductSessions(this: IntakeTui, productId: string, mode: SessionLoadMode = "initial"): Promise<void> {
    return await fetchProductSessions(this, productId, mode);
  }

export function IntakeTui_loadMoreProductSessions(this: IntakeTui): void {
    return fetchMoreProductSessions(this);
  }

export function IntakeTui_refreshProductSessions(this: IntakeTui): void {
    return refetchProductSessions(this);
  }

export function IntakeTui_activateProductSessions(this: IntakeTui, productId: string, sessions: readonly SessionSummary[], limitReached: boolean): void {
    const previousLevel = this.intakeLevel;
    const previousProjectKey = this.activeProjectKey;
    const keepLayer = previousLevel === "sessions" || previousLevel === "projects";
    this.activeProductId = productId;
    this.lastProductId = productId;
    this.sessions = sessions;
    this.sessionLimitReached = limitReached;
    this.intakeLevel = keepLayer ? previousLevel : "projects";
    const memory = productMemory(this.intakeMemory, productId);
    if (!keepLayer || previousLevel === "projects") {
      this.searchQuery = memory.projectQuery;
      this.searchCursor = memory.projectCursor;
      this.searching = this.searchQuery.length > 0;
      const projects = this.visibleProjects();
      const restored = restoreById(
        projects.map((project) => ({ id: project.key })),
        memory.projectKey || this.lastProjectKey || previousProjectKey,
        memory.projectSelectedIndex,
      );
      const fallback = selectDefaultProjectIndex(projects, this.displayCwd, memory.projectKey || this.lastProjectKey, this.dataDir);
      const rememberedKey = memory.projectKey || this.lastProjectKey;
      this.selected = rememberedKey ? restored.index : fallback;
      this.activeProjectKey = projects[this.selected]?.key ?? memory.projectKey ?? previousProjectKey;
      if (restored.lost && rememberedKey) {
        this.message = t(this.locale, "projectSelectionLost");
      } else {
        this.message = this.sessionsMessage();
      }
    } else {
      this.activeProjectKey = previousProjectKey || memory.projectKey;
      const saved = memory.sessionByProject.get(this.activeProjectKey);
      this.searchQuery = saved?.query ?? this.searchQuery;
      this.searchCursor = saved?.cursor ?? this.searchCursor;
      this.searching = this.searchQuery.length > 0;
      const sessionList = this.visibleSessions();
      const restored = restoreById(
        sessionList.map((session) => ({ id: session.sessionId })),
        saved?.sessionId ?? "",
        saved?.selectedIndex ?? this.selected,
      );
      this.selected = restored.index;
      this.message = restored.lost ? t(this.locale, "sessionSelectionLost") : this.sessionsMessage();
    }
    this.syncIntakeLevel();
    this.page = "sessions";
  }

export function IntakeTui_openIntakeSelection(this: IntakeTui): { consume: true } {
    if (this.intakeLevel === "products") {
      const pack = importPacks(this.packs)[this.selected];
      if (pack) void this.loadProductSessions(pack.manifest.productId);
      else this.message = t(this.locale, "emptyMatchBlocked");
      return { consume: true };
    }
    if (this.intakeLevel === "projects") return enterProjectSessions(this);
    const selected = this.visibleSessions()[this.selected];
    if (!selected) {
      this.message = t(this.locale, "emptyMatchBlocked");
      this.render();
      return { consume: true };
    }
    void IntakeTui_openSessionInspection.call(this, selected);
    return { consume: true };
}

function enterProjectSessions(c: IntakeTui): { consume: true } {
  const project = c.visibleProjects()[c.selected];
  if (!project) {
    c.message = t(c.locale, "emptyMatchBlocked");
    c.render();
    return { consume: true };
  }
  const memory = productMemory(c.intakeMemory, c.activeProductId);
  rememberProjects(memory, c.searchQuery, c.searchCursor, project.key, c.selected);
  c.activeProjectKey = project.key;
  c.lastProjectKey = project.key;
  const saved = memory.sessionByProject.get(project.key);
  c.intakeLevel = "sessions";
  c.searchQuery = saved?.query ?? "";
  c.searchCursor = saved?.cursor ?? 0;
  c.searching = c.searchQuery.length > 0;
  const sessions = c.visibleSessions();
  const restored = restoreById(
    sessions.map((session) => ({ id: session.sessionId })),
    saved?.sessionId ?? "",
    saved?.selectedIndex ?? 0,
  );
  c.selected = restored.index;
  c.message = restored.lost ? t(c.locale, "sessionSelectionLost") : c.sessionsMessage();
  c.render();
  return { consume: true };
}

export function IntakeTui_sessionsMessage(this: IntakeTui): string {
    if (this.intakeLevel === "products") return t(this.locale, "chooseAgentProduct");
    const discovery = this.activeProductId ? this.productDiscovery.get(this.activeProductId) : undefined;
    if (discovery?.status === "loading") return t(this.locale, "sessionsLoading");
    const projects = this.groupedProjects();
    const guide = this.sessions.length
      ? this.intakeLevel === "projects" ? t(this.locale, "chooseProject") : t(this.locale, "chooseSession")
      : t(this.locale, "noSessionsFound");
    const counts = t(this.locale, "catalogLoaded", { projects: projects.length, sessions: this.sessions.length });
    if (discovery?.refreshFailed) return `${guide}\n${t(this.locale, "refreshFailedStale")}`;
    if (discovery?.nextCursor) return `${guide}\n${counts}\n${t(this.locale, "loadMoreSessionsHint")}`;
    return `${guide}\n${counts}`;
  }

export function IntakeTui_discoveryDiagnosticLabel(this: IntakeTui, locale: Locale, code: DiscoveryDiagnostic['code']): string {
  if (code === 'history-without-transcript') return t(locale, 'historyWithoutTranscript');
  if (code === 'source-missing') return t(locale, 'sourceMissingDiagnostic');
  if (code === 'duplicate-source') return t(locale, 'duplicateSourceDiagnostic');
  if (code === 'invalid-jsonl') return t(locale, 'catalogInvalidJsonl');
  if (code === 'catalog-unavailable') return t(locale, 'catalogUnavailable');
  if (code === 'unreadable-directory') return t(locale, 'discoveryUnreadableDirectory');
  if (code === 'unreadable-file') return t(locale, 'discoveryUnreadableFile');
  if (code === 'catalog-read-error') return t(locale, 'discoveryReadFailed');
  if (code === 'too-large') return t(locale, 'discoveryTooLarge');
  if (code === 'invalid-metadata') return t(locale, 'discoveryInvalidMetadata');
  if (code === 'unsupported-entry') return t(locale, 'discoveryUnsupportedEntry');
  if (code === 'catalog-schema-unsupported') return t(locale, 'discoveryCatalogSchema');
  if (code === 'global-state-unavailable') return t(locale, 'discoveryGlobalState');
  if (code === 'conflicting-project-source') return t(locale, 'discoveryConflictingSource');
  if (code === 'excluded') return t(locale, 'discoveryExcluded');
  if (code === 'stale-cursor') return t(locale, 'discoveryStaleCursor');
  return code;
}

export async function IntakeTui_refreshProductAuth(this: IntakeTui): Promise<void> {
    const statuses = await Promise.all(this.packs.map(async (pack) => ({
      productId: pack.manifest.productId,
      status: await (pack.checkAuth?.() ?? Promise.resolve({ configured: false })),
    })));
    this.productAuth.clear();
    for (const { productId, status } of statuses) this.productAuth.set(productId, status.configured);
  }

export function IntakeTui_canLeaveProject(this: IntakeTui): boolean {
    return this.intakeLevel !== "products";
  }

export function IntakeTui_backToProjects(this: IntakeTui): { consume: true } {
    if (this.intakeLevel === "projects") {
      this.discoveryAbort?.abort();
      if (this.activeProductId) {
        const memory = productMemory(this.intakeMemory, this.activeProductId);
        rememberProjects(memory, this.searchQuery, this.searchCursor, this.activeProjectKey, this.selected);
      }
      this.beginNavigation();
      this.intakeLevel = "products";
      this.selected = Math.max(0, this.packs.findIndex((pack) => pack.manifest.productId === this.activeProductId));
      this.activeProductId = "";
      this.searching = false;
      this.searchQuery = "";
      this.searchCursor = 0;
    } else {
      const memory = productMemory(this.intakeMemory, this.activeProductId);
      const selected = this.visibleSessions()[this.selected];
      rememberSessions(memory, this.activeProjectKey, this.searchQuery, this.searchCursor, selected?.sessionId ?? "", this.selected);
      rememberProjects(memory, memory.projectQuery, memory.projectCursor, this.activeProjectKey, memory.projectSelectedIndex);
      this.intakeLevel = "projects";
      this.searchQuery = memory.projectQuery;
      this.searchCursor = memory.projectCursor;
      this.searching = this.searchQuery.length > 0;
      const projects = this.visibleProjects();
      const restored = restoreById(
        projects.map((project) => ({ id: project.key })),
        this.activeProjectKey,
        memory.projectSelectedIndex,
      );
      this.selected = restored.index;
    }
    this.message = this.sessionsMessage();
    this.render();
    return { consume: true };
  }

export function IntakeTui_syncIntakeLevel(this: IntakeTui): void {
    const projects = this.groupedProjects();
    if (!this.activeProjectKey || !projects.some((project) => project.key === this.activeProjectKey)) {
      this.activeProjectKey = projects[0]?.key ?? "";
    }
    if (this.intakeLevel === "sessions" && !projects.some((project) => project.key === this.activeProjectKey)) {
      this.intakeLevel = "projects";
    }
  }

export function IntakeTui_groupedProjects(this: IntakeTui): SessionProject[] {
    return groupIntakeProjects(this);
  }

export function IntakeTui_visibleProjects(this: IntakeTui): SessionProject[] {
    return listVisibleProjects(this);
  }

export function IntakeTui_visibleSessions(this: IntakeTui): readonly SessionSummary[] {
    return listVisibleSessions(this);
  }

export function IntakeTui_intakeCount(this: IntakeTui): number {
    return countIntakeItems(this);
  }

export function IntakeTui_productItems(this: IntakeTui): import("./pages/intake.js").ProductIntakeItem[] {
    return listProductItems(this);
  }

async function IntakeTui_openSessionInspection(this: IntakeTui, session: SessionSummary): Promise<void> {
  const pack = this.packs.find((item) => item.manifest.productId === session.productId);
  if (!pack) {
    this.showError(new Error(`No Product Pack is registered for session ${session.productId}.`), "sessions");
    this.render(true);
    return;
  }
  if (this.activeProductId) {
    const memory = productMemory(this.intakeMemory, this.activeProductId);
    rememberSessions(memory, this.activeProjectKey, this.searchQuery, this.searchCursor, session.sessionId, this.selected);
  }
  const token = this.beginNavigation();
  this.message = t(this.locale, "inspectingSelectedSession");
  this.render(true);
  try {
    if (!this.workflow) throw new Error('Experiment workflow is required to inspect a session.');
    const inspected = await this.workflow.inspectSource({
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
    this.inspectionShowOutcome = false;
    this.page = "inspection";
    this.message = t(this.locale, "chooseSession");
  } catch (error) {
    if (token !== this.generation) return;
    this.showError(error, "sessions");
  }
  this.render(true);
}
