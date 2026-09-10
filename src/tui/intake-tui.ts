import type { Models } from "@earendil-works/pi-ai";
import { type OverlayHandle, SelectList, type TUI } from "@earendil-works/pi-tui";
import type { ExperimentResult, ExperimentHandle } from "../application/experiment.js";
import type { ExperimentPreflight } from "../application/experiment-preflight.js";
import type { RecoveryView } from "../application/recovery/view.js";
import type { ExperimentWorkflow } from "../application/experiment-workflow.js";
import type { TaskCase, CandidateSpec, CandidateRunState } from "../core/schema.js";
import type { RuntimeAvailabilityStatus, RuntimeModelOffer } from "../core/runtime.js";
import {
  defaultHarnessModelConfig,
  emptyHarnessConfigDraft,
  type HarnessConfigDraft,
  type HarnessModelConfig,
} from "../infrastructure/harness-model-config.js";
import type {
  DiscoveryDiagnostic,
  ProductPack,
  SessionDiscoveryProject,
  SessionInspection,
  SessionPrivacy,
  SessionSummary,
} from "../products/contract.js";
import { initializeIntakeTui } from "./intake-tui-state.js";
import * as intakeMethods from "./intake-tui-methods.js";
import type { Locale } from "./i18n.js";
import type { HistoryCase, HistoryExperiment } from "./local-history.js";
import type { IntakeLevel, ProductIntakeItem, SessionProject } from "./pages/intake.js";
import type { Option } from "./types.js";
import type { TimelineEntry } from "./timeline.js";
import { type Workbench, type WorkbenchView } from "./workbench.js";
import type { IntakeProductMemory } from "./intake-layer-memory.js";
import type { PreparePhase } from "./widgets.js";
import type { CandidateRunPhase } from "./pages/run.js";

type Page = WorkbenchView["page"];
type PiModels = Pick<
  Models,
  "getProviders" | "getModels" | "getModel" | "getAuth" | "completeSimple" | "streamSimple"
>;
type ConfigDraft = HarnessConfigDraft;

export type ProductDiscoveryState = {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly root?: string;
  readonly nextCursor?: string;
  readonly scanned?: number;
  readonly skipped?: number;
  readonly diagnostics?: readonly DiscoveryDiagnostic[];
  readonly rootDiagnostics?: readonly DiscoveryDiagnostic[];
  readonly pageDiagnostics?: readonly DiscoveryDiagnostic[];
  readonly message?: string;
  readonly projects?: readonly SessionDiscoveryProject[];
};

export type SessionLoadMode = "initial" | "more" | "refresh";

export type IntakeTuiOptions = {
  readonly dataDir: string;
  readonly sessionsRoot?: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly pack?: ProductPack;
  readonly packs?: readonly ProductPack[];
  readonly privacy: SessionPrivacy;
  readonly tui?: TUI;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly displayCwd?: string;
  readonly piModels?: PiModels;
  readonly workflow?: ExperimentWorkflow;
  readonly queueTimelineRender?: (callback: () => void) => void;
  readonly autoCompare?: boolean;
};

/** Keyboard-only Home-first benchmark workbench for configuration, intake, and isolated runs. */
export class IntakeTui {
  dataDir!: string;
  runtimeSessionIds: readonly string[] = [];
  sessionsRoot: string | undefined;
  sessionsRoots!: Readonly<Record<string, string>>;
  packs!: readonly ProductPack[];
  privacy!: SessionPrivacy;
  tui!: TUI;
  workbench!: Workbench;
  now!: () => string;
  nowMs!: () => number;
  displayCwd!: string;
  piModels: PiModels | undefined;
  workflow: ExperimentWorkflow | undefined;
  canStartExperiment = false;
  queueTimelineRender!: (callback: () => void) => void;
  page: Page = "loading";
  sessions: readonly SessionSummary[] = [];
  activeProductId = "";
  lastProductId = "";
  lastProjectKey = "";
  readonly productSessions = new Map<string, readonly SessionSummary[]>();
  readonly productDiscovery = new Map<string, ProductDiscoveryState>();
  discoveryAbort: AbortController | undefined;
  inspection: SessionInspection | undefined;
  inspectionTaskInput = 0;
  selected = 0;
  filterEligible = false;
  intakeLevel: IntakeLevel = "products";
  activeProjectKey = "";
  searchQuery = "";
  searchCursor = 0;
  searching = false;
  finding = false;
  findQuery = "";
  findCursor = 0;
  readingMode = false;
  readingVisibleAt = 0;
  timelineAnchor: string | undefined;
  timelineReadOffset = 0;
  terminalGuard: (() => void) | undefined;
  inspectionShowOutcome = false;
  modelConfig: HarnessModelConfig = defaultHarnessModelConfig();
  hasSavedModelConfig = false;
  configDraft: ConfigDraft = emptyHarnessConfigDraft();
  configSelected = 0;
  configEditing = false;
  configBuffer = "";
  configCursor = 0;
  configPendingToggle = false;
  configLeaveConfirm = false;
  readonly intakeMemory = new Map<string, IntakeProductMemory>();
  readonly productAuth = new Map<string, boolean>();
  sessionLimitReached = false;
  providers: readonly Option[] = [];
  models: readonly Option[] = [];
  message = "Reading local Reprise configuration...";
  composer = "";
  composerCursor = 0;
  showSuggestions = false;
  taskCase: TaskCase | undefined;
  historyCases: readonly HistoryCase[] = [];
  historyExperiments: readonly HistoryExperiment[] = [];
  historyTotalBytes = 0;
  historyTab: "runs" | "cases" = "runs";
  historySelected = 0;
  historyDetail: HistoryCase | HistoryExperiment | undefined;
  recentExperiment: HistoryExperiment | undefined;
  sourceRoot = "";
  sourceCursor = 0;
  preflight: ExperimentPreflight | undefined;
  recoveryView: RecoveryView | undefined;
  selectedCandidate: CandidateSpec | undefined;
  candidateProductId = "";
  candidateProductCursor = 0;
  candidateAvailability: Readonly<Record<string, RuntimeAvailabilityStatus | "loading">> = {};
  candidateModelOffers: readonly RuntimeModelOffer[] = [];
  candidateModelCursor = 0;
  candidateCatalogStatus: "idle" | "loading" | "ready" | "error" = "idle";
  candidateCatalogError: string | undefined;
  candidateSuggestedValue: string | undefined;
  candidateCatalogGeneration = 0;
  candidateAvailabilityGeneration = 0;
  activeExperiment: ExperimentHandle | undefined;
  recoveryAbort: AbortController | undefined;
  startupAbort: AbortController | undefined;
  recoveryFinished: Promise<void> | undefined;
  workflowFinished: Promise<void> | undefined;
  result: ExperimentResult | undefined;
  timeline: TimelineEntry[] = [];
  timelineSelected = 0;
  timelineFilterIndex = 0;
  timelineFollowing = true;
  detailExpanded = false;
  cancelling = false;
  configBusy = false;
  generation = 0;
  timelineRenderQueued = false;
  runStartedAt = 0;
  runClock: ReturnType<typeof setInterval> | undefined;
  runPhase: CandidateRunPhase | undefined;
  machineState: CandidateRunState | undefined;
  runFailed = false;
  cleanupStatus: string | undefined;
  lastRuntimeEventAt: string | undefined;
  lastRuntimeEventKind: string | undefined;
  modelOutputSeen = false;
  reconnectCount = 0;
  reconnectTotal = 0;
  preparePhase: PreparePhase | undefined;
  prepareDetail: string | undefined;
  runFromSource = false;
  harnessAuthOk = false;
  errorReturnPage: Exclude<Page, "error" | "running" | "loading"> = "home";
  started = false;
  closed = false;
  closing: Promise<void> = Promise.resolve();
  resolveClosed: (() => void) | undefined;
  emitWarning: typeof process.emitWarning | undefined;
  helpOverlay: OverlayHandle | undefined;
  commandOverlay: OverlayHandle | undefined;
  commandSelectList: SelectList | undefined;
  inlineHelp = false;
  locale: Locale = "en";
  viewer: { title: string; body: string } | undefined;
  actorsOpen = false;
  paneFocus: 'left' | 'right' = 'left';
  expandedFolds: string[] = [];
  autoCompare = false;
  compareChoice: { resolve(run: boolean): void } | undefined;
  groupedCache:
    | {
        sessions: readonly SessionSummary[];
        filterEligible: boolean;
        projects: SessionProject[];
        catalogProjects: readonly SessionDiscoveryProject[];
      }
    | undefined;
  dirtyCache: { draft: ConfigDraft; config: HarnessModelConfig; dirty: boolean } | undefined;

  constructor(options: IntakeTuiOptions) {
    initializeIntakeTui(this, options);
  }

  start(): Promise<void> { return intakeMethods.IntakeTui_start.call(this); }
  run(): Promise<void> { return intakeMethods.IntakeTui_run.call(this); }
  preview(width = 120): string { return intakeMethods.IntakeTui_preview.call(this, width); }
  handleInput(data: string): { consume: true } | undefined { return intakeMethods.IntakeTui_handleInput.call(this, data); }
  setHomeMessage(message: string): { consume: true } { return intakeMethods.IntakeTui_setHomeMessage.call(this, message); }
  configPageInput(data: string): { consume: true } | undefined { return intakeMethods.IntakeTui_configPageInput.call(this, data); }
  modelsForDraft(draft: ConfigDraft): { draft: ConfigDraft; models: readonly Option[] } { return intakeMethods.IntakeTui_modelsForDraft.call(this, draft); }
  historyInput(data: string): { consume: true } | undefined { return intakeMethods.IntakeTui_historyInput.call(this, data); }
  historyItems(): readonly (HistoryCase | HistoryExperiment)[] { return intakeMethods.IntakeTui_historyItems.call(this); }
  loadHistory(): Promise<void> { return intakeMethods.IntakeTui_loadHistory.call(this); }
  openRecentExperiment(): { consume: true } { return intakeMethods.IntakeTui_openRecentExperiment.call(this); }
  openConfig(): Promise<void> { return intakeMethods.IntakeTui_openConfig.call(this); }
  saveConfig(): Promise<void> { return intakeMethods.IntakeTui_saveConfig.call(this); }
  testConfigConnection(): Promise<void> { return intakeMethods.IntakeTui_testConfigConnection.call(this); }
  refreshHarnessAuth(): Promise<void> { return intakeMethods.IntakeTui_refreshHarnessAuth.call(this); }
  loadHome(initialMessage?: string): Promise<void> { return intakeMethods.IntakeTui_loadHome.call(this, initialMessage); }
  loadSessions(): Promise<void> { return intakeMethods.IntakeTui_loadSessions.call(this); }
  loadProductSessions(productId: string, mode?: SessionLoadMode): Promise<void> {
    return intakeMethods.IntakeTui_loadProductSessions.call(this, productId, mode ?? "initial");
  }
  loadMoreProductSessions(): void { intakeMethods.IntakeTui_loadMoreProductSessions.call(this); }
  refreshProductSessions(): void { intakeMethods.IntakeTui_refreshProductSessions.call(this); }
  activateProductSessions(productId: string, sessions: readonly SessionSummary[], limitReached: boolean): void {
    intakeMethods.IntakeTui_activateProductSessions.call(this, productId, sessions, limitReached);
  }
  move(amount: number): { consume: true } { return intakeMethods.IntakeTui_move.call(this, amount); }
  scheduleTimelineRender(): void { intakeMethods.IntakeTui_scheduleTimelineRender.call(this); }
  visibleTimeline(): readonly TimelineEntry[] { return intakeMethods.IntakeTui_visibleTimeline.call(this); }
  setLocale(typed: string): Promise<void> { return intakeMethods.IntakeTui_setLocale.call(this, typed); }
  showError(error: unknown, returnPage: Exclude<Page, "error" | "running" | "loading">): void {
    intakeMethods.IntakeTui_showError.call(this, error, returnPage);
  }
  returnFromError(): { consume: true } { return intakeMethods.IntakeTui_returnFromError.call(this); }
  openReport(experimentRoot: string | undefined, reportPath: string | undefined): { consume: true } {
    return intakeMethods.IntakeTui_openReport.call(this, experimentRoot, reportPath);
  }
  openTrace(): { consume: true } { return intakeMethods.IntakeTui_openTrace.call(this); }
  openReplica(): { consume: true } { return intakeMethods.IntakeTui_openReplica.call(this); }
  openLocal(target: string | undefined): { consume: true } { return intakeMethods.IntakeTui_openLocal.call(this, target); }
  openFileUrl(url: string): void { intakeMethods.IntakeTui_openFileUrl.call(this, url); }
  backToHome(): { consume: true } { return intakeMethods.IntakeTui_backToHome.call(this); }
  close(): { consume: true } { return intakeMethods.IntakeTui_close.call(this); }
  openIntakeSelection(): { consume: true } { return intakeMethods.IntakeTui_openIntakeSelection.call(this); }
  sessionsMessage(): string { return intakeMethods.IntakeTui_sessionsMessage.call(this); }
  discoveryDiagnosticLabel(locale: Locale, code: DiscoveryDiagnostic["code"]): string {
    return intakeMethods.IntakeTui_discoveryDiagnosticLabel.call(this, locale, code);
  }
  refreshProductAuth(): Promise<void> { return intakeMethods.IntakeTui_refreshProductAuth.call(this); }
  canLeaveProject(): boolean { return intakeMethods.IntakeTui_canLeaveProject.call(this); }
  backToProjects(): { consume: true } { return intakeMethods.IntakeTui_backToProjects.call(this); }
  syncIntakeLevel(): void { intakeMethods.IntakeTui_syncIntakeLevel.call(this); }
  groupedProjects(): SessionProject[] { return intakeMethods.IntakeTui_groupedProjects.call(this); }
  visibleProjects(): SessionProject[] { return intakeMethods.IntakeTui_visibleProjects.call(this); }
  visibleSessions(): readonly SessionSummary[] { return intakeMethods.IntakeTui_visibleSessions.call(this); }
  intakeCount(): number { return intakeMethods.IntakeTui_intakeCount.call(this); }
  productItems(): ProductIntakeItem[] { return intakeMethods.IntakeTui_productItems.call(this); }
  beginNavigation(): number { return intakeMethods.IntakeTui_beginNavigation.call(this); }
  isEditingText(): boolean { return intakeMethods.IntakeTui_isEditingText.call(this); }
  showHelp(): { consume: true } { return intakeMethods.IntakeTui_showHelp.call(this); }
  hideHelp(): void { intakeMethods.IntakeTui_hideHelp.call(this); }
  syncCommandOverlay(): void { intakeMethods.IntakeTui_syncCommandOverlay.call(this); }
  hideCommandOverlay(): void { intakeMethods.IntakeTui_hideCommandOverlay.call(this); }
  configDirty(): boolean { return intakeMethods.IntakeTui_configDirty.call(this); }
  muteNodeWarnings(): void { intakeMethods.IntakeTui_muteNodeWarnings.call(this); }
  restoreNodeWarnings(): void { intakeMethods.IntakeTui_restoreNodeWarnings.call(this); }
  viewport(): { height?: number } { return intakeMethods.IntakeTui_viewport.call(this); }
  setMouseReporting(enabled: boolean): void { intakeMethods.IntakeTui_setMouseReporting.call(this, enabled); }
  render(immediate = false): void { intakeMethods.IntakeTui_render.call(this, immediate); }
  productContext(): { productLabel?: string; productConfigured?: boolean } { return intakeMethods.IntakeTui_productContext.call(this); }
  view(): WorkbenchView { return intakeMethods.IntakeTui_view.call(this); }
}
