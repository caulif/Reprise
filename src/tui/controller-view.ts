import { resolve } from "node:path";
import type { CodexIntakeTui } from "./controller.js";
import { isEligibleSession, type SessionDiscoveryProject, type SessionSummary } from "../products/contract.js";
import {
  groupSessionsByProject,
  matchesIntakeQuery,
  matchesProjectQuery,
  type SessionProject,
} from "./pages/intake.js";
import { envNameFromConfig } from "./controller-run.js";
import type { WorkbenchView } from "./workbench.js";
import { projectWorkbenchView } from "./view-projection.js";

export function groupedProjects(c: CodexIntakeTui): SessionProject[] {
  const cached = c.groupedCache;
  const catalogProjects: readonly SessionDiscoveryProject[] = c.activeProductId
    ? c.productDiscovery.get(c.activeProductId)?.projects ?? []
    : [];
  if (
    cached &&
    cached.sessions === c.sessions &&
    cached.filterEligible === c.filterEligible &&
    cached.catalogProjects === catalogProjects
  )
    return cached.projects;
  const projects = groupSessionsByProject(
    c.filterEligible ? c.sessions.filter(isEligibleSession) : c.sessions,
    catalogProjects,
  );
  c.groupedCache = {
    sessions: c.sessions,
    filterEligible: c.filterEligible,
    catalogProjects,
    projects,
  };
  return projects;
}

export function visibleProjects(c: CodexIntakeTui): SessionProject[] {
  return c.groupedProjects().filter((project) =>
    matchesProjectQuery(project, c.searchQuery),
  );
}

export function visibleSessions(c: CodexIntakeTui): readonly SessionSummary[] {
  const pool = c.filterEligible
    ? c.sessions.filter(isEligibleSession)
    : c.sessions;
  const project = c.groupedProjects().find(
    (item) => item.key === c.activeProjectKey,
  );
  const scoped =
    c.intakeLevel === "sessions" && project ? project.sessions : pool;
  return scoped.filter((session) =>
    matchesIntakeQuery(session, c.searchQuery),
  );
}

export function intakeCount(c: CodexIntakeTui): number {
  if (c.intakeLevel === "products") return c.packs.length;
  return c.intakeLevel === "projects" ? c.visibleProjects().length : c.visibleSessions().length;
}

export function productItems(c: CodexIntakeTui): import("./pages/intake.js").ProductIntakeItem[] {
  return c.packs.map((pack) => {
    const state = c.productDiscovery.get(pack.manifest.productId) ?? { status: "idle" as const };
    const root = resolve(c.sessionsRoots[pack.manifest.productId] ?? pack.sessions.defaultRoot);
    const sessions = state.root === root ? c.productSessions.get(pack.manifest.productId) : undefined;
    return { productId: pack.manifest.productId, displayName: pack.manifest.displayName, packVersion: pack.manifest.packVersion,
      discoveryStatus: state.status, ...(sessions ? { sessionCount: sessions.length } : {}), ...(state.scanned !== undefined ? { scanned: state.scanned } : {}),
      ...(state.nextCursor ? { limitReached: true } : {}),
      ...(state.skipped ? { skipped: state.skipped } : {}), ...(state.message ? { diagnostic: state.message } : {}) };
  });
}

export function productContext(c: CodexIntakeTui): { productLabel?: string; productConfigured?: boolean } {
  const highlighted = c.page === 'sessions' && c.intakeLevel === 'products'
    ? c.packs[c.selected]?.manifest.productId ?? ''
    : '';
  const browsing = c.page === 'sessions' || c.page === 'inspection';
  const productId = c.taskCase?.source.productId || (browsing ? (c.activeProductId || highlighted) : '');
  const pack = c.packs.find((item) => item.manifest.productId === productId);
  if (!pack) return {};
  return {
    productLabel: pack.manifest.displayName,
    productConfigured: true,
  };
}

function candidateRunFields(c: CodexIntakeTui) {
  const sourceProductLabel = c.packs.find((pack) => pack.manifest.productId === c.taskCase?.source.productId)?.manifest.displayName;
  const candidateProductLabel = c.packs.find((pack) => pack.manifest.productId === (c.selectedCandidate?.productId || c.candidateProductId))?.manifest.displayName;
  return {
    ...(c.selectedCandidate ? { candidate: c.selectedCandidate } : {}),
    ...(sourceProductLabel ? { sourceProductLabel } : {}),
    ...(candidateProductLabel ? { candidateProductLabel } : {}),
    candidateProducts: c.packs.map((pack) => ({
      productId: pack.manifest.productId,
      displayName: pack.manifest.displayName,
      sourceSession: pack.manifest.productId === c.taskCase?.source.productId,
      availability: c.candidateAvailability[pack.manifest.productId] ?? 'loading' as const,
    })),
    candidateProductCursor: c.candidateProductCursor,
    candidateModelOffers: c.candidateModelOffers,
    candidateModelCursor: c.candidateModelCursor,
    candidateCatalogStatus: c.candidateCatalogStatus,
    ...(c.candidateCatalogError ? { candidateCatalogError: c.candidateCatalogError } : {}),
    ...(c.candidateSuggestedValue ? { candidateSuggestedValue: c.candidateSuggestedValue } : {}),
  };
}

export function view(c: CodexIntakeTui): WorkbenchView {
  const envName = envNameFromConfig(c.modelConfig, c.configDraft);
  const product = c.productContext();
  const discoveryStatus = c.productDiscovery.get(c.activeProductId)?.status;
  return projectWorkbenchView({
    page: c.page,
    cwd: c.displayCwd,
    modelConfig: c.modelConfig,
    hasSavedModelConfig: c.hasSavedModelConfig,
    locale: c.locale,
    harnessAuthOk: c.harnessAuthOk,
    ...(envName ? { envName } : {}),
    ...product,
    taskCase: c.taskCase,
    message: c.message,
    inlineHelp: c.inlineHelp,
    cancelling: c.cancelling,
    recentExperiment: c.recentExperiment,
    composer: c.composer,
    composerCursor: c.composerCursor,
    showSuggestions: c.showSuggestions,
    commandOverlay: Boolean(c.commandOverlay),
    configDraft: c.configDraft,
    configSelected: c.configSelected,
    configEditing: c.configEditing,
    configBuffer: c.configBuffer,
    configCursor: c.configCursor,
    configDirty: c.configDirty(),
    configPendingToggle: c.configPendingToggle,
    historyTotalBytes: c.historyTotalBytes,
    historyTab: c.historyTab,
    historyItems: c.historyItems(),
    historySelected: c.historySelected,
    historyDetail: c.historyDetail,
    intakeLevel: c.intakeLevel,
    products: c.productItems(),
    visibleProjects: c.visibleProjects(),
    activeProjectKey: c.activeProjectKey,
    visibleSessions: c.visibleSessions(),
    selected: c.selected,
    filterEligible: c.filterEligible,
    searchQuery: c.searchQuery,
    searchCursor: c.searchCursor,
    searching: c.searching,
    ...(discoveryStatus ? { discoveryStatus } : {}),
    inspection: c.inspection,
    privacy: c.privacy,
    inspectionTaskInput: c.inspectionTaskInput,
    inspectionShowOutcome: c.inspectionShowOutcome,
    sourceRoot: c.sourceRoot,
    sourceCursor: c.sourceCursor,
    preflight: c.preflight,
    ...candidateRunFields(c),
    recoveryAttempt: c.recoveryAttempt,
    effort: c.modelConfig.effort,
    policy: c.workflow?.policy,
    ...(c.preparePhase
      ? {
          preparePhase: c.preparePhase,
          ...(c.prepareDetail
            ? { prepareDetail: c.prepareDetail }
            : {}),
        }
      : {}),
    ...(c.runPhase ? { runPhase: c.runPhase } : {}),
    ...(c.lastRuntimeEventAt ? { lastRuntimeEventAt: c.lastRuntimeEventAt } : {}),
    ...(c.lastRuntimeEventKind ? { lastRuntimeEventKind: c.lastRuntimeEventKind } : {}),
    ...(c.modelOutputSeen ? { modelOutputSeen: true } : {}),
    ...(c.reconnectCount ? { reconnectCount: c.reconnectCount } : {}),
    ...(c.reconnectTotal ? { reconnectTotal: c.reconnectTotal } : {}),
    timeline: c.timeline,
    visibleTimeline: c.visibleTimeline(),
    timelineSelected: c.timelineSelected,
    timelineFilterIndex: c.timelineFilterIndex,
    timelineFollowing: c.timelineFollowing,
    paneFocus: c.paneFocus,
    expandedFolds: c.expandedFolds,
    detailExpanded: c.detailExpanded,
    runStartedAt: c.runStartedAt,
    nowMs: c.nowMs(),
    result: c.result,
    ...(c.viewer ? { viewer: c.viewer } : {}),
    ...(c.actorsOpen ? { actorsOpen: true } : {}),
    ...(c.finding
      ? {
          finding: true,
          findQuery: c.findQuery,
          findCursor: c.findCursor,
        }
      : {}),
  });
}
