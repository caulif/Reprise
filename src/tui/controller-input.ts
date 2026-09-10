import { dirname } from 'node:path';
import { runtimePacks } from '../application/intake-catalog.js';
import { isFsAbsolute } from '../core/paths.js';
import { matchesKey } from '@earendil-works/pi-tui';
import type { ExperimentResult, ExperimentHandle } from '../application/experiment.js';
import type { ExperimentPreflight } from '../application/experiment-preflight.js';
import type { RecoveryView } from '../application/recovery/view.js';
import type { ExperimentWorkflow } from '../application/experiment-workflow.js';
import type { TaskCase } from '../core/schema.js';
import type { HarnessConfigDraft, HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import type { ProductPack, SessionInspection, SessionPrivacy, SessionSummary } from '../products/contract.js';
import { coveringFoldIds, foldProcessEntries, selectedIndexAfterFold } from './fold-process.js';
import { TIMELINE_FILTERS, unwrapBracketedPaste } from './format.js';
import { t, type Locale } from './i18n.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';
import { matchesCanvasQuery, matchesFilter } from './scrollback.js';
import { canvasHitIndices, nextHitIndex, syncTimelineSelection, timelineIdentity } from './timeline-read.js';
import { beginPreflight, beginRun, bindWorkflow, candidateGateFrom, candidateStartBlocked, freeze, loadCandidateCatalog, acceptCandidateModel, requestCancellation } from './controller-run.js';
import {
  dispatchCanvasInput,
  dispatchCandidatePickerInput,
  dispatchConfirmInput,
  dispatchErrorKeys,
  dispatchGlobalInput,
  dispatchHistoryDetailInput,
  dispatchHomeComposer,
  dispatchInspectionInput,
  dispatchPreflightInput,
  dispatchResultKeys,
  dispatchRunningKeys,
  dispatchSessionsInput,
  dispatchSourceField,
  historyDetailKind,
  submittedHomeCommand,
  type GlobalInputAction,
} from './page-input.js';
import { eventOriginalText, type TimelineEntry } from './timeline.js';
import type { WorkbenchView } from './workbench.js';
import type { PreparePhase } from './widgets.js';
import type { CandidateRunPhase } from './pages/run.js';

export type Page = WorkbenchView['page'];
export type Consume = { consume: true };

export type ControllerHandle = {
  recoveryAbort: AbortController | undefined;
  startupAbort: AbortController | undefined;
  recoveryFinished: Promise<void> | undefined;
  workflowFinished: Promise<void> | undefined;
  page: Page;
  viewer: { title: string; body: string } | undefined;
  actorsOpen: boolean;
  helpOverlay: { hide(): void } | undefined;
  inlineHelp: boolean;
  composer: string;
  composerCursor: number;
  showSuggestions: boolean;
  sourceRoot: string;
  sourceCursor: number;
  searching: boolean;
  searchQuery: string;
  searchCursor: number;
  selected: number;
  filterEligible: boolean;
  inspection: SessionInspection | undefined;
  privacy: SessionPrivacy;
  inspectionShowOutcome: boolean;
  preflight: ExperimentPreflight | undefined;
  historyDetail: HistoryCase | HistoryExperiment | undefined;
  taskCase: TaskCase | undefined;
  finding: boolean;
  findQuery: string;
  findCursor: number;
  readingMode: boolean;
  readingVisibleAt: number;
  timelineAnchor: string | undefined;
  timelineReadOffset: number;
  preparePhase: PreparePhase | undefined;
  prepareDetail: string | undefined;
  detailExpanded: boolean;
  locale: Locale;
  result: ExperimentResult | undefined;
  message: string;
  timeline: TimelineEntry[];
  timelineSelected: number;
  timelineFollowing: boolean;
  timelineFilterIndex: number;
  paneFocus: 'left' | 'right';
  expandedFolds: string[];
  autoCompare: boolean;
  compareChoice: { resolve(run: boolean): void } | undefined;
  runFromSource: boolean;
  readonly workflow: ExperimentWorkflow | undefined;
  canStartExperiment: boolean;
  generation: number;
  recoveryView: RecoveryView | undefined;
  selectedCandidate: import('../core/schema.js').CandidateSpec | undefined;
  candidateProductId: string;
  candidateProductCursor: number;
  candidateAvailability: Readonly<Record<string, import('../core/runtime.js').RuntimeAvailabilityStatus | 'loading'>>;
  candidateModelOffers: readonly import('../core/runtime.js').RuntimeModelOffer[];
  candidateModelCursor: number;
  candidateCatalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  candidateCatalogError: string | undefined;
  candidateSuggestedValue: string | undefined;
  candidateCatalogGeneration: number;
  candidateAvailabilityGeneration: number;
  activeExperiment: ExperimentHandle | undefined;
  recentExperiment: HistoryExperiment | undefined;
  readonly dataDir: string;
  readonly packs: readonly ProductPack[];
  sessions: readonly SessionSummary[];
  readonly now: () => string;
  runStartedAt: number;
  runClock: ReturnType<typeof setInterval> | undefined;
  cancelling: boolean;
  runPhase: CandidateRunPhase | undefined;
  lastRuntimeEventAt: string | undefined;
  lastRuntimeEventKind: string | undefined;
  modelOutputSeen: boolean;
  reconnectCount: number;
  reconnectTotal: number;
  modelConfig: HarnessModelConfig;
  configDraft: HarnessConfigDraft;
  configEditing: boolean;
  render(immediate?: boolean): void;
  showError(error: unknown, page: Exclude<Page, 'error' | 'running' | 'loading'>): void;
  beginNavigation(): number;
  hideHelp(): void;
  showHelp(): Consume;
  hideCommandOverlay(): void;
  syncCommandOverlay(): void;
  openConfig(): Promise<void>;
  backToHome(): Consume;
  close(): Consume;
  move(amount: number): Consume;
  openIntakeSelection(): Consume;
  canLeaveProject(): boolean;
  backToProjects(): Consume;
  sessionsMessage(): string;
  syncIntakeLevel(): void;
  openReport(experimentRoot: string | undefined, reportPath: string | undefined): Consume;
  openTrace(): Consume;
  openReplica(): Consume;
  openLocal(target: string | undefined): Consume;
  returnFromError(): Consume;
  configPageInput(data: string): Consume | undefined;
  historyInput(data: string): Consume | undefined;
  setLocale(typed: string): Promise<void>;
  visibleTimeline(): readonly TimelineEntry[];
  scheduleTimelineRender(): void;
  setMouseReporting(enabled: boolean): void;
  refreshProductAuth(): Promise<void>;
  loadSessions(): Promise<void>;
  loadMoreProductSessions(): void;
  refreshProductSessions(): void;
  loadHistory(): Promise<void>;
  openRecentExperiment(): Consume;
  setHomeMessage(message: string): Consume;
  isEditingText(): boolean;
};

export function handleControllerInput(c: ControllerHandle, data: string): Consume | undefined {
  const input = unwrapBracketedPaste(data);
  const global = dispatchGlobalInput({
    page: c.page,
    editingText: c.isEditingText(),
    viewer: Boolean(c.viewer),
    actorsOpen: c.actorsOpen,
    helpOpen: Boolean(c.helpOverlay || c.inlineHelp),
    startupActive: Boolean(c.startupAbort),
  }, input);
  if (global) return applyGlobal(c, global.action);
  if (c.page === 'running') return applyRunning(c, input);
  if (c.page === 'config') return c.configPageInput(input);
  if (c.page === 'history') return matchesKey(input, 'escape') ? c.backToHome() : c.historyInput(input);
  if (c.page === 'history-detail') {
    const canvas = c.timeline.length ? applyCanvas(c, input) : undefined;
    if (canvas) return canvas;
    return applyHistoryDetail(c, input);
  }
  if (c.page === 'home') return applyHome(c, input);
  if (c.page === 'source') return applySource(c, input);
  if (c.page === 'preflight') return applyPreflight(c, input);
  if (c.page === 'candidate-product') return applyCandidateProduct(c, input);
  if (c.page === 'candidate-model') return applyCandidateModel(c, input);
  if (c.page === 'confirm') return applyConfirm(c, input);
  if (c.page === 'result') {
    const result = dispatchResultKeys(input);
    if (!result) return undefined;
    if (result.action === 'compare') {
      if (!c.compareChoice) return { consume: true };
      c.compareChoice.resolve(true);
      c.compareChoice = undefined;
      return { consume: true };
    }
    if (result.action === 'open-report') {
      if (c.result?.comparison.result.status === 'skipped') return undefined;
      return c.openReport(
        c.result?.experimentRoot ?? (c.result ? dirname(c.result.reportPath) : undefined),
        c.result?.reportPath,
      );
    }
    if (result.action === 'open-trace') return c.openTrace();
    if (result.action === 'open-replica') return c.openReplica();
    if (c.compareChoice) {
      c.compareChoice.resolve(false);
      c.compareChoice = undefined;
    }
    return c.backToHome();
  }
  if (c.page === 'error') {
    const error = dispatchErrorKeys(input);
    return error ? c.returnFromError() : undefined;
  }
  if (c.page === 'sessions') return applySessions(c, input);
  if (c.page === 'inspection') return applyInspection(c, input);
  if (matchesKey(input, 'escape')) return c.backToHome();
  return undefined;
}

function applyGlobal(c: ControllerHandle, action: GlobalInputAction): Consume {
  if (action === 'cancel') return requestCancellation(c);
  if (action === 'close') return c.close();
  if (action === 'close-viewer') {
    c.viewer = undefined;
    c.render();
    return { consume: true };
  }
  if (action === 'close-actors') {
    c.actorsOpen = false;
    c.render();
    return { consume: true };
  }
  if (action === 'hide-help') {
    c.hideHelp();
    c.render();
    return { consume: true };
  }
  return c.showHelp();
}

function applyHome(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchHomeComposer({
    composer: c.composer,
    cursor: c.composerCursor,
    showSuggestions: c.showSuggestions,
  }, data);
  if (!result) return undefined;
  c.composer = result.state.composer;
  c.composerCursor = result.state.cursor;
  c.showSuggestions = result.state.showSuggestions;
  if (result.action === 'escape') {
    c.hideCommandOverlay();
    c.render();
    return { consume: true };
  }
  if (result.action === 'submit') return submitComposer(c);
  c.syncCommandOverlay();
  c.render();
  return { consume: true };
}

function submitComposer(c: ControllerHandle): Consume {
  const typed = c.composer.trim().toLowerCase();
  c.composer = '';
  c.composerCursor = 0;
  c.showSuggestions = false;
  c.hideCommandOverlay();
  const command = submittedHomeCommand(typed);
  if (command === 'empty') {
    if (c.recentExperiment) return c.openRecentExperiment();
    return { consume: true };
  }
  if (command === 'plain') return c.setHomeMessage(t(c.locale, 'plainRejected'));
  if (command === 'help') return c.setHomeMessage(`${t(c.locale, 'helpCommands')}.`);
  if (command === 'config') {
    void c.openConfig();
    return { consume: true };
  }
  if (command === 'intake') return startSessionDiscovery(c);
  if (command === 'history') return startHistoryLoad(c);
  if (command === 'lang') {
    void c.setLocale(typed);
    return { consume: true };
  }
  return c.setHomeMessage(t(c.locale, 'unknownCommand', { cmd: typed }));
}

function startSessionDiscovery(c: ControllerHandle): Consume {
  c.message = t(c.locale, 'discoveringSessions');
  c.render();
  void c.loadSessions();
  return { consume: true };
}

function startHistoryLoad(c: ControllerHandle): Consume {
  c.message = t(c.locale, 'readingHistory');
  c.render();
  void c.loadHistory();
  return { consume: true };
}

function applySource(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchSourceField({ value: c.sourceRoot, cursor: c.sourceCursor }, data);
  if (!result) return undefined;
  c.sourceRoot = result.state.value;
  c.sourceCursor = result.state.cursor;
  if (result.action === 'home') return c.backToHome();
  if (result.action === 'submit') {
    if (!c.taskCase || !c.workflow) return { consume: true };
    if (!isFsAbsolute(c.sourceRoot.trim())) {
      c.message = t(c.locale, 'sourceMustAbsolute');
      c.render();
      return { consume: true };
    }
    c.runFromSource = true;
    bindWorkflow(c, beginPreflight(c));
    return { consume: true };
  }
  c.render();
  return { consume: true };
}

function applySessions(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchSessionsInput({
    query: c.searchQuery,
    cursor: c.searchCursor,
    searching: c.searching,
    canLeaveProject: c.canLeaveProject(),
  }, data);
  if (!result) return undefined;
  c.searchQuery = result.state.query;
  c.searchCursor = result.state.cursor;
  c.searching = result.state.searching;
  if (result.action === 'escape-search') {
    c.selected = 0;
    c.render();
    return { consume: true };
  }
  if (result.action === 'up') return c.move(-1);
  if (result.action === 'down') return c.move(1);
  if (result.action === 'enter') return c.openIntakeSelection();
  if (result.action === 'start-search') {
    c.render();
    return { consume: true };
  }
  if (result.action === 'leave-project') return c.backToProjects();
  if (result.action === 'home') return c.backToHome();
  if (result.action === 'more') {
    c.loadMoreProductSessions();
    return { consume: true };
  }
  if (result.action === 'refresh') {
    c.refreshProductSessions();
    return { consume: true };
  }
  if (result.action === 'toggle-filter') {
    c.filterEligible = !c.filterEligible;
    c.selected = 0;
    c.message = c.filterEligible ? t(c.locale, 'filterEligible') : t(c.locale, 'filterAllSessions');
    c.syncIntakeLevel();
    c.render();
    return { consume: true };
  }
  if (result.action === 'edit-search') {
    c.selected = 0;
    c.render();
    return { consume: true };
  }
  return { consume: true };
}

function applyInspection(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchInspectionInput(data, Boolean(c.inspection));
  if (!result) return undefined;
  if (result.action === 'toggle-model-text') {
    c.privacy = { ...c.privacy, allowModelText: !c.privacy.allowModelText };
    c.message = t(c.locale, c.privacy.allowModelText ? 'modelTextAllowed' : 'modelTextBlocked');
    c.render();
    return { consume: true };
  }
  if (result.action === 'toggle-outcome') {
    c.inspectionShowOutcome = !c.inspectionShowOutcome;
    c.render();
    return { consume: true };
  }
  if (result.action === 'back-sessions') {
    c.page = 'sessions';
    c.message = c.sessionsMessage();
    c.render();
    return { consume: true };
  }
  if (c.inspection?.transcript.some((message) => message.role === 'user')) {
    void freeze(c, c.inspection.sourcePath, { thenRun: true });
    return { consume: true };
  }
  c.showError(new Error(t(c.locale, 'notReplayableNoUserInput')), 'sessions');
  c.render();
  return { consume: true };
}

function applyPreflight(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchPreflightInput(data);
  if (!result) return undefined;
  if (result.action === 'home') return c.backToHome();
  c.page = 'source';
  c.render();
  return { consume: true };
}

function applyCandidateProduct(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchCandidatePickerInput(data);
  if (!result) return undefined;
  if (result.action === 'home') return c.backToHome();
  if (result.action === 'back') {
    c.page = 'confirm';
    c.render();
    return { consume: true };
  }
  if (result.action === 'up' || result.action === 'down') {
    const next = c.candidateProductCursor + (result.action === 'up' ? -1 : 1);
    c.candidateProductCursor = Math.max(0, Math.min(Math.max(0, runtimePacks(c.packs).length - 1), next));
    c.render();
    return { consume: true };
  }
  void loadCandidateCatalog(c);
  return { consume: true };
}

function applyCandidateModel(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchCandidatePickerInput(data);
  if (!result) return undefined;
  if (result.action === 'home') return c.backToHome();
  if (result.action === 'back') {
    c.page = 'candidate-product';
    c.render();
    return { consume: true };
  }
  if (result.action === 'up' || result.action === 'down') {
    const next = c.candidateModelCursor + (result.action === 'up' ? -1 : 1);
    c.candidateModelCursor = Math.max(0, Math.min(Math.max(0, c.candidateModelOffers.length - 1), next));
    c.render();
    return { consume: true };
  }
  if (c.candidateCatalogStatus !== 'ready' || !c.candidateModelOffers.length) return { consume: true };
  void acceptCandidateModel(c);
  return { consume: true };
}

function applyCompareGate(c: ControllerHandle, data: string): Consume | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'enter') || input === 'c' || input === 'C') {
    c.compareChoice?.resolve(true);
    c.compareChoice = undefined;
    return { consume: true };
  }
  if (input === 's' || input === 'S') {
    c.compareChoice?.resolve(false);
    c.compareChoice = undefined;
    return { consume: true };
  }
  return undefined;
}

function applyConfirm(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchConfirmInput(data);
  if (!result) return undefined;
  if (result.action === 'home') return c.backToHome();
  if (result.action === 'models') {
    if (candidateStartBlocked(candidateGateFrom(c))) return c.backToHome();
    c.page = c.selectedCandidate || c.candidateProductId ? 'candidate-model' : 'candidate-product';
    if (c.page === 'candidate-model' && c.candidateCatalogStatus === 'idle') void loadCandidateCatalog(c);
    c.render();
    return { consume: true };
  }
  if (candidateStartBlocked(candidateGateFrom(c))) {
    c.message = t(c.locale, 'recoveryFailed');
    c.render();
    return { consume: true };
  }
  bindWorkflow(c, beginRun(c));
  return { consume: true };
}

function applyRunning(c: ControllerHandle, data: string): Consume | undefined {
  const blocked = canvasBlocked(c);
  if (!blocked && !c.finding) {
    if (c.readingMode && (matchesKey(data, 'v') || matchesKey(data, 'escape'))) return exitReadingMode(c);
    if (c.readingMode) return { consume: true };
    if (matchesKey(data, 'v')) return enterReadingMode(c);
  }
  const canvas = applyCanvas(c, data);
  if (canvas) return canvas;
  if (c.compareChoice) {
    const gate = applyCompareGate(c, data);
    if (gate) return gate;
  }
  const result = dispatchRunningKeys(data);
  if (!result) return undefined;
  if (result.action === 'toggle-detail') {
    c.detailExpanded = !c.detailExpanded;
    c.render();
    return { consume: true };
  }
  if (result.action === 'cycle-fold' || result.action === 'cycle-fold-prev') {
    return cycleFoldSelection(c, result.action === 'cycle-fold-prev' ? -1 : 1);
  }
  if (result.action === 'open-detail') return openSelectedDetail(c);
  c.message = t(c.locale, 'experimentActive');
  c.render();
  return { consume: true };
}

function canvasBlocked(c: ControllerHandle): boolean {
  return c.preparePhase === 'check' || c.preparePhase === 'copy'
    || Boolean(c.viewer || c.actorsOpen || c.helpOverlay || c.inlineHelp);
}

function applyCanvas(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchCanvasInput({ finding: c.finding, query: c.findQuery, cursor: c.findCursor }, data, canvasBlocked(c));
  if (!result) return undefined;
  c.finding = result.state.finding;
  c.findQuery = result.state.query;
  c.findCursor = result.state.cursor;
  if (result.action === 'clear-find') return clearFind(c);
  if (result.action === 'next-hit' || result.action === 'prev-hit') {
    return jumpFindHit(c, result.action === 'prev-hit' ? -1 : 1);
  }
  if (result.action === 'move') return moveTimeline(c, result.amount ?? 1);
  if (result.action === 'start-find') {
    c.timelineFollowing = false;
    expandFoldsForQuery(c);
    c.render();
    return { consume: true };
  }
  if (result.action === 'follow') return followTimeline(c);
  if (result.action === 'home') return homeTimeline(c);
  if (result.action === 'edit-find') {
    c.timelineFollowing = false;
    expandFoldsForQuery(c);
    syncTimelineSelection(c);
    c.render();
    return { consume: true };
  }
  return { consume: true };
}

function applyHistoryDetail(c: ControllerHandle, data: string): Consume | undefined {
  const result = dispatchHistoryDetailInput(data, historyDetailKind(c.historyDetail));
  if (!result) return undefined;
  if (result.action === 'back') {
    c.page = 'history';
    c.render();
    return { consume: true };
  }
  if (result.action === 'open-report' && c.historyDetail && !('taskCase' in c.historyDetail)) {
    return c.openReport(c.historyDetail.path, c.historyDetail.reportPath);
  }
  if (result.action === 'open-local' && c.historyDetail) return c.openLocal(c.historyDetail.path);
  if (result.action === 'use-case' && c.historyDetail && 'taskCase' in c.historyDetail) {
    c.taskCase = c.historyDetail.taskCase;
    c.page = 'home';
    c.message = t(c.locale, 'taskCaseCurrent', { id: c.taskCase.caseId });
    c.render();
    return { consume: true };
  }
  return undefined;
}

function clearFind(c: ControllerHandle): Consume {
  const current = c.visibleTimeline()[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  c.finding = false;
  c.findQuery = '';
  c.findCursor = 0;
  syncTimelineSelection(c);
  c.render();
  return { consume: true };
}

function openSelectedDetail(c: ControllerHandle): Consume {
  const entry = c.visibleTimeline()[c.timelineSelected];
  const body = eventOriginalText(entry);
  if (!body?.trim()) {
    c.message = t(c.locale, 'noOriginalOutput');
    c.render();
    return { consume: true };
  }
  c.viewer = { title: entry?.title ?? 'original', body };
  c.render();
  return { consume: true };
}

function moveTimeline(c: ControllerHandle, amount: number): Consume {
  if (c.readingMode && Math.abs(amount) >= 10) {
    c.timelineReadOffset = Math.max(0, (c.timelineReadOffset ?? 0) + amount);
    c.timelineFollowing = false;
    c.render();
    return { consume: true };
  }
  const entries = c.visibleTimeline();
  const next = Math.max(0, Math.min(Math.max(0, entries.length - 1), c.timelineSelected + amount));
  if (next !== c.timelineSelected) c.timelineReadOffset = 0;
  c.timelineSelected = next;
  c.timelineFollowing = c.timelineSelected === Math.max(0, entries.length - 1);
  const current = entries[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  expandFoldsForQuery(c);
  c.render();
  return { consume: true };
}

function jumpFindHit(c: ControllerHandle, direction: 1 | -1): Consume {
  const entries = c.visibleTimeline();
  const hits = canvasHitIndices(entries, c.findQuery);
  if (!hits.length) {
    c.render();
    return { consume: true };
  }
  c.timelineSelected = nextHitIndex(hits, c.timelineSelected, direction);
  c.timelineReadOffset = 0;
  c.timelineFollowing = c.timelineSelected === Math.max(0, entries.length - 1);
  const current = entries[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  expandFoldsForQuery(c);
  c.render();
  return { consume: true };
}

function homeTimeline(c: ControllerHandle): Consume {
  const entries = c.visibleTimeline();
  c.timelineSelected = 0;
  c.timelineFollowing = entries.length <= 1;
  const current = entries[0];
  if (current) c.timelineAnchor = timelineIdentity(current);
  c.render();
  return { consume: true };
}

function followTimeline(c: ControllerHandle): Consume {
  const visible = c.visibleTimeline();
  c.timelineSelected = Math.max(0, visible.length - 1);
  c.timelineFollowing = true;
  const current = visible[c.timelineSelected];
  if (current) c.timelineAnchor = timelineIdentity(current);
  c.message = t(c.locale, 'followingLatest');
  c.render();
  return { consume: true };
}

function cycleFoldSelection(c: ControllerHandle, direction: 1 | -1): Consume {
  const visible = c.visibleTimeline();
  const folded = foldProcessEntries(visible, new Set(c.expandedFolds));
  const foldIndices = folded.flatMap((entry, index) => entry.kind === 'fold' ? [index] : []);
  if (!foldIndices.length) {
    c.detailExpanded = !c.detailExpanded;
    c.render();
    return { consume: true };
  }
  const current = selectedIndexAfterFold(visible, folded, visible[c.timelineSelected] ?? c.timeline[c.timelineSelected]);
  const pos = foldIndices.findIndex((index) => index >= current);
  const start = pos < 0 ? 0 : pos;
  const nextIndex = foldIndices[(start + (direction === 1 ? 1 : foldIndices.length - 1)) % foldIndices.length];
  if (nextIndex === undefined) {
    c.render();
    return { consume: true };
  }
  const target = folded[nextIndex];
  if (target) {
    const identity = timelineIdentity(target);
    const raw = visible.findIndex((entry) => timelineIdentity(entry) === identity);
    c.timelineSelected = raw >= 0 ? raw : Math.min(current, Math.max(0, visible.length - 1));
    c.timelineAnchor = identity;
    c.timelineFollowing = false;
  }
  c.render();
  return { consume: true };
}

function expandFoldsForQuery(c: ControllerHandle): void {
  if (!c.findQuery.trim()) return;
  const filter = TIMELINE_FILTERS[c.timelineFilterIndex] ?? 'ALL';
  const filtered = c.timeline.filter((entry) => matchesFilter(entry, filter));
  const hits = c.timeline.filter((entry) => matchesFilter(entry, filter)).filter((entry) => matchesCanvasQuery(entry, c.findQuery));
  for (const hit of hits) {
    for (const id of coveringFoldIds(filtered, hit)) {
      if (!c.expandedFolds.includes(id)) c.expandedFolds.push(id);
    }
  }
}

function enterReadingMode(c: ControllerHandle): Consume {
  c.readingMode = true;
  c.timelineFollowing = false;
  c.readingVisibleAt = c.visibleTimeline().length;
  c.setMouseReporting(false);
  c.message = t(c.locale, 'readingModeOn');
  return { consume: true };
}

function exitReadingMode(c: ControllerHandle): Consume {
  c.readingMode = false;
  c.setMouseReporting(true);
  const missed = Math.max(0, c.visibleTimeline().length - c.readingVisibleAt);
  c.message = missed > 0 ? t(c.locale, 'readingModeNewActivity', { n: missed }) : t(c.locale, 'readingModeOff');
  c.render(true);
  return { consume: true };
}
