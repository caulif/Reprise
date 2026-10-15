import { resolve } from "node:path";
import type { IntakeTui } from "./intake-tui.js";
import { importPacks, isEligibleSession, runtimePacks } from "../application/intake-catalog.js";
import type { SessionDiscoveryProject, SessionSummary } from "../products/contract.js";
import {
  groupSessionsByProject,
  matchesIntakeQuery,
  matchesProjectQuery,
  type SessionProject,
} from "./pages/intake.js";
import { envNameFromConfig } from "./controller-run.js";
import type { WorkbenchView } from "./workbench.js";
import { projectWorkbenchView } from "./view-projection.js";
import { activeNodes } from './activity-index.js';

export function groupedProjects(c: IntakeTui): SessionProject[] {
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

export function visibleProjects(c: IntakeTui): SessionProject[] {
  return c.groupedProjects().filter((project) =>
    matchesProjectQuery(project, c.searchQuery),
  );
}

export function visibleSessions(c: IntakeTui): readonly SessionSummary[] {
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

export function intakeCount(c: IntakeTui): number {
  if (c.intakeLevel === "products") return importPacks(c.packs).length;
  return c.intakeLevel === "projects" ? c.visibleProjects().length : c.visibleSessions().length;
}

export function productItems(c: IntakeTui): import("./pages/intake.js").ProductIntakeItem[] {
  return importPacks(c.packs).map((pack) => {
    const state = c.productDiscovery.get(pack.manifest.productId) ?? { status: "idle" as const };
    const root = resolve(c.sessionsRoots[pack.manifest.productId] ?? pack.history?.defaultRoot ?? "");
    const sessions = state.root === root ? c.productSessions.get(pack.manifest.productId) : undefined;
    return { productId: pack.manifest.productId, displayName: pack.manifest.displayName, packVersion: pack.manifest.packVersion,
      discoveryStatus: state.status, ...(sessions ? { sessionCount: sessions.length } : {}), ...(state.scanned !== undefined ? { scanned: state.scanned } : {}),
      ...(state.nextCursor ? { limitReached: true } : {}),
      ...(state.skipped ? { skipped: state.skipped } : {}), ...(state.message ? { diagnostic: state.message } : {}) };
  });
}

export function productContext(c: IntakeTui): { productLabel?: string; productConfigured?: boolean } {
  const highlighted = c.page === 'sessions' && c.intakeLevel === 'products'
    ? importPacks(c.packs)[c.selected]?.manifest.productId ?? ''
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

function candidateRunFields(c: IntakeTui) {
  const sourceProductLabel = c.packs.find((pack) => pack.manifest.productId === c.taskCase?.source.productId)?.manifest.displayName;
  const candidateProductLabel = c.packs.find((pack) => pack.manifest.productId === (c.selectedCandidate?.productId || c.candidateProductId))?.manifest.displayName;
  return {
    ...(c.selectedCandidate ? { candidate: c.selectedCandidate } : {}),
    ...(sourceProductLabel ? { sourceProductLabel } : {}),
    ...(candidateProductLabel ? { candidateProductLabel } : {}),
    candidateProducts: runtimePacks(c.packs).map((pack) => ({
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

function runDiagnosticsFields(c: IntakeTui) {
  return {
    ...(c.preparePhase
      ? {
          preparePhase: c.preparePhase,
          ...(c.prepareDetail ? { prepareDetail: c.prepareDetail } : {}),
        }
      : {}),
    ...(c.runDiagnostics.state.runPhase ? { runPhase: c.runDiagnostics.state.runPhase } : {}),
    ...(c.runDiagnostics.state.machineState ? { machineState: c.runDiagnostics.state.machineState } : {}),
    ...(c.runDiagnostics.state.runFailed ? { runFailed: true } : {}),
    ...(c.runDiagnostics.state.cleanupStatus ? { cleanupStatus: c.runDiagnostics.state.cleanupStatus } : {}),
    ...(c.runDiagnostics.state.lastRuntimeEventAt ? { lastRuntimeEventAt: c.runDiagnostics.state.lastRuntimeEventAt } : {}),
    ...(c.runDiagnostics.state.lastObservedEventAt ? { lastObservedEventAt: c.runDiagnostics.state.lastObservedEventAt } : {}),
    ...(c.runDiagnostics.state.lastVisibleActivityAt ? { lastVisibleActivityAt: c.runDiagnostics.state.lastVisibleActivityAt } : {}),
    ...(c.runDiagnostics.state.lastRuntimeEventKind ? { lastRuntimeEventKind: c.runDiagnostics.state.lastRuntimeEventKind } : {}),
    ...(c.runDiagnostics.state.modelOutputSeen ? { modelOutputSeen: true } : {}),
    ...(c.runDiagnostics.state.reconnectCount ? { reconnectCount: c.runDiagnostics.state.reconnectCount } : {}),
    ...(c.runDiagnostics.state.reconnectTotal ? { reconnectTotal: c.runDiagnostics.state.reconnectTotal } : {}),
    ...(c.runDiagnostics.state.comparisonAttemptId ? { comparisonAttemptId: c.runDiagnostics.state.comparisonAttemptId } : {}),
    phaseClocks: {
      ...(c.runDiagnostics.state.recoveryStartedAt ? { recoveryStartedAt: c.runDiagnostics.state.recoveryStartedAt } : {}),
      ...(c.runDiagnostics.state.recoveryEndedAt ? { recoveryEndedAt: c.runDiagnostics.state.recoveryEndedAt } : {}),
      ...(c.runDiagnostics.state.candidateStartedAt ? { candidateStartedAt: c.runDiagnostics.state.candidateStartedAt } : {}),
      ...(c.runDiagnostics.state.candidateEndedAt ? { candidateEndedAt: c.runDiagnostics.state.candidateEndedAt } : {}),
      ...(c.runDiagnostics.state.comparisonStartedAt ? { comparisonStartedAt: c.runDiagnostics.state.comparisonStartedAt } : {}),
      ...(c.runDiagnostics.state.comparisonEndedAt ? { comparisonEndedAt: c.runDiagnostics.state.comparisonEndedAt } : {}),
    },
  };
}

export function view(c: IntakeTui): WorkbenchView {
  const envName = envNameFromConfig(c.modelConfig, c.configSession.state.draft);
  const product = c.productContext();
  const discovery = c.activeProductId ? c.productDiscovery.get(c.activeProductId) : undefined;
  const discoveryStatus = discovery?.status;
  const grouped = c.groupedProjects();
  const activeProject = grouped.find((project) => project.key === c.activeProjectKey);
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
    homeFocus: c.homeFocus,
    composer: c.composer,
    composerCursor: c.composerCursor,
    showSuggestions: c.showSuggestions,
    commandOverlay: Boolean(c.commandOverlay),
    configDraft: c.configSession.state.draft,
    configSelected: c.configSession.state.selected,
    configAdvanced: c.configSession.state.advanced,
    configEditing: c.configSession.state.editing,
    configBuffer: c.configSession.state.buffer,
    configCursor: c.configSession.state.cursor,
    configDirty: c.configDirty(),
    configPendingToggle: c.configSession.state.pendingToggle,
    ...(c.configSession.state.leaveConfirm ? { configLeaveConfirm: true } : {}),
    configBusy: c.configSession.state.busy,
    configTestStatus: c.configSession.state.testStatus,
    ...(c.configSession.state.testDetail ? { configTestDetail: c.configSession.state.testDetail } : {}),
    historyTotalBytes: c.historyTotalBytes,
    invalidHistoryCaseCount: c.invalidHistoryCaseCount,
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
    ...(discovery?.diagnostics?.length ? { discoveryCodes: discovery.diagnostics.map((item) => item.code) } : {}),
    groupedProjectCount: grouped.length,
    unfilteredSessionCount: activeProject?.sessions.length ?? 0,
    inspection: c.inspection,
    privacy: c.privacy,
    inspectionTaskInput: c.inspectionTaskInput,
    inspectionShowOutcome: c.inspectionShowOutcome,
    inspectionScrollOffset: c.inspectionScrollOffset,
    sourceRoot: c.sourceRoot,
    sourceCursor: c.sourceCursor,
    preflight: c.preflight,
    ...candidateRunFields(c),
    recoveryView: c.recoveryView,
    effort: c.modelConfig.effort,
    policy: c.workflow?.policy,
    ...runDiagnosticsFields(c),
    timeline: c.timeline,
    timelineRevision: c.timelineRevision,
    visibleTimeline: c.visibleTimeline(),
    timelineSelected: c.timelineSelected,
    timelineFilterIndex: c.timelineFilterIndex,
    timelineFollowing: c.timelineFollowing,
    expandedFolds: c.expandedFolds,
    ...(c.activityDetailEntry ? { activityDetail: c.activityDetailEntry } : {}),
    ...(c.activityDetailOffset > 0 ? { activityDetailOffset: c.activityDetailOffset } : {}),
    runStartedAt: c.runDiagnostics.state.runStartedAt,
    nowMs: c.nowMs(),
    activeParallel: activeNodes(c.activityIndex).length,
    ...(c.compareChoice ? { comparePending: true } : {}),
    resultAction: c.resultAction,
    ...(c.resultHover ? { resultHover: c.resultHover } : {}),
    resultDetails: c.resultDetails,
    result: c.result,
    ...(c.canvasFind.state.finding ? { finding: true, findQuery: c.canvasFind.state.query, findCursor: c.canvasFind.state.cursor } : {}),
    ...(c.timelineReadOffset ? { timelineReadOffset: c.timelineReadOffset } : {}),
    ...(c.readingMode ? { readingMode: true } : {}),
    surfaceScope: c.surfaceScope,
    ...(c.processExpanded ? { processExpanded: true } : {}),
  });
}
