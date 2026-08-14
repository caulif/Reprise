import { dirname } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import {
  Loader,
  ProcessTerminal,
  SelectList,
  TuiAltScreen,
  isViewportTUI,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TaskCase } from "../core/schema.js";
import type {
  CodexExperimentPreflight,
  CodexExperimentResult,
  ExperimentHandle,
  RecoveryAttempt,
} from "../application/experiment.js";
import type { CodexTuiWorkflow } from "../application/tui-workflow.js";
import {
  configForDraft,
  defaultHarnessModelConfig,
  draftForConfig,
  hasFileApiKey,
  readHarnessModelConfig,
  saveHarnessModelConfig,
  safeConfigError,
  shellEnvAssignment,
  tryEnvironmentName,
  type HarnessConfigDraft,
  type HarnessModelConfig,
} from "../infrastructure/harness-model-config.js";
import { PiModelCaller } from "../infrastructure/pi-model-caller.js";
import { isEligibleSession, type ProductPack, type SessionInspection, type SessionPrivacy, type SessionSummary } from "../products/contract.js";
import { findProductPack, productPacks } from "../products/index.js";
import {
  errorMessage,
  operatorErrorMessage,
  TIMELINE_FILTERS,
} from "./format.js";
import {
  groupSessionsByProject,
  matchesIntakeQuery,
  matchesProjectQuery,
  type IntakeLevel,
  type SessionProject,
} from "./pages/intake.js";
import {
  readLocalHistory,
  type HistoryCase,
  type HistoryExperiment,
} from "./local-history.js";
import { HelpOverlay, commandSelectList } from "./overlays.js";
import { CONFIG_FIELDS } from "./pages/config.js";
import { handleConfigInput } from "./config-input.js";
import { handleControllerInput } from "./controller-input.js";
import { discardRecovery, envNameFromConfig, freeze, stopRunClock } from "./controller-run.js";
import { nextLocale, parseLocale, t, type Locale } from "./i18n.js";
import { readTuiPreferences, saveTuiPreferences } from "./preferences.js";
import { matchesCanvasQuery, matchesFilter } from "./scrollback.js";
import { handleHistoryInput } from "./history-input.js";
import { createTheme, enableTerminalColor } from "./theme.js";
import { type TimelineEntry } from "./timeline.js";
import { projectWorkbenchView } from "./view-projection.js";
import { Workbench, mountWorkbench, type WorkbenchView } from "./workbench.js";
import {
  openAllowedFileUrl,
  openAllowedLocalPath,
  openExperimentReport,
  openExperimentTrace,
} from "./open-report.js";
import type { PreparePhase } from "./widgets.js";
type Page = WorkbenchView["page"];
const SESSION_LIMIT = 150;
type PiModels = Pick<
  Models,
  | "getProviders"
  | "getModels"
  | "getModel"
  | "getAuth"
  | "completeSimple"
  | "streamSimple"
>;
type Option = import("./types.js").Option;
type ConfigDraft = HarnessConfigDraft;
export type CodexIntakeTuiOptions = {
  readonly dataDir: string;
  readonly sessionsRoot: string;
  readonly sessionsRoots?: Readonly<Record<string, string>>;
  readonly pack?: ProductPack;
  readonly privacy: SessionPrivacy;
  readonly tui?: TUI;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly displayCwd?: string;
  readonly piModels?: PiModels;
  readonly workflow?: CodexTuiWorkflow;
};
/** Keyboard-only Home-first benchmark workbench for configuration, intake, and isolated runs. */
export class CodexIntakeTui {
  readonly dataDir: string;
  readonly sessionsRoot: string;
  readonly sessionsRoots: Readonly<Record<string, string>>;
  readonly packs: readonly ProductPack[];
  privacy: SessionPrivacy;
  readonly tui: TUI;
  readonly workbench: Workbench;
  readonly now: () => string;
  readonly nowMs: () => number;
  readonly displayCwd: string;
  readonly piModels: PiModels | undefined;
  readonly workflow: CodexTuiWorkflow | undefined;
  page: Page = "loading";
  sessions: readonly SessionSummary[] = [];
  inspection: SessionInspection | undefined;
  inspectionTaskInput = 0;
  selected = 0;
  filterEligible = false;
  intakeLevel: IntakeLevel = "projects";
  activeProjectKey = "";
  searchQuery = "";
  searchCursor = 0;
  searching = false;
  finding = false;
  findQuery = "";
  findCursor = 0;
  inspectionShowOutcome = false;
  modelConfig: HarnessModelConfig = defaultHarnessModelConfig();
  hasSavedModelConfig = false;
  configDraft: ConfigDraft = draftForConfig(defaultHarnessModelConfig());
  configSelected = 0;
  configEditing = false;
  configBuffer = "";
  configCursor = 0;
  configPendingToggle = false;
  hasCodexLogin = false;
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
  preflight: CodexExperimentPreflight | undefined;
  recoveryAttempt: RecoveryAttempt | undefined;
  activeExperiment: ExperimentHandle | undefined;
  result: CodexExperimentResult | undefined;
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
  groupedCache:
    | {
        sessions: readonly SessionSummary[];
        filterEligible: boolean;
        projects: SessionProject[];
      }
    | undefined;
  dirtyCache:
    | { draft: ConfigDraft; config: HarnessModelConfig; dirty: boolean }
    | undefined;
  constructor(options: CodexIntakeTuiOptions) {
    this.dataDir = options.dataDir;
    this.sessionsRoot = options.sessionsRoot;
    this.packs = options.pack ? [options.pack] : productPacks;
    this.sessionsRoots = options.sessionsRoots ?? Object.fromEntries(
      this.packs.map((pack) => [pack.manifest.productId, options.sessionsRoot || pack.sessions.defaultRoot]),
    );
    this.privacy = options.privacy;
    this.tui =
      options.tui ??
      new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
        openUrl: (url) => {
          this.openFileUrl(url);
        },
      });
    this.workbench = new Workbench(
      () => this.view(),
      () => this.viewport(),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.displayCwd = options.displayCwd ?? process.cwd();
    this.piModels = options.piModels;
    this.workflow = options.workflow;
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    enableTerminalColor();
    mountWorkbench(this.tui, this.workbench);
    this.tui.addInputListener((data) => this.handleInput(data));
    this.render();
    this.tui.start();
    let configurationIssue: string | undefined;
    try {
      const configured = await readHarnessModelConfig(this.dataDir);
      if (configured) {
        this.modelConfig = configured;
        this.hasSavedModelConfig = true;
        this.configDraft = draftForConfig(configured);
      }
    } catch (error) {
      configurationIssue = `Could not read local configuration: ${safeConfigError(error)}`;
    }
    await this.refreshHarnessAuth();
    this.refreshCodexLogin();
    this.locale = (await readTuiPreferences(this.dataDir)).locale;
    await this.loadHome(configurationIssue);
    this.render(true);
  }
  async run(): Promise<void> {
    this.muteNodeWarnings();
    try {
      await this.start();
      if (!this.closed)
        await new Promise<void>((resolve) => {
          this.resolveClosed = resolve;
        });
      await this.closing;
    } finally {
      this.restoreNodeWarnings();
    }
  }
  preview(width = 120): string {
    return this.workbench.render(width).join("\n");
  }
  handleInput(data: string): { consume: true } | undefined {
    return handleControllerInput(this, data);
  }
  setHomeMessage(message: string): { consume: true } {
    this.message = message;
    this.render();
    return { consume: true };
  }
  configPageInput(data: string): { consume: true } | undefined {
    const result = handleConfigInput(
      {
        draft: this.configDraft,
        selected: this.configSelected,
        editing: this.configEditing,
        buffer: this.configBuffer,
        cursor: this.configCursor,
        providers: this.providers,
        models: this.models,
        pendingToggle: this.configPendingToggle,
      },
      data,
      (draft) => this.modelsForDraft(draft),
    );
    if (!result) return undefined;
    this.configDraft = result.state.draft;
    this.configSelected = result.state.selected;
    this.configEditing = result.state.editing;
    this.configBuffer = result.state.buffer;
    this.configCursor = result.state.cursor ?? result.state.buffer.length;
    this.configPendingToggle = Boolean(result.state.pendingToggle);
    this.models = result.state.models;
    if (result.message) this.message = result.message;
    if (result.action === "save") void this.saveConfig();
    else if (result.action === "test") void this.testConfigConnection();
    else if (result.action === "home") return this.backToHome();
    else if (result.action === "toggle-locale") {
      void this.setLocale("/lang");
      return { consume: true };
    } else this.render();
    return { consume: true };
  }
  modelsForDraft(draft: ConfigDraft): {
    draft: ConfigDraft;
    models: readonly Option[];
  } {
    const models = new PiModelCaller(
      configForDraft(draft),
      this.piModels,
    ).models();
    if (models.some((model) => model.id === draft.modelId))
      return { draft, models };
    const model = models[0];
    return { draft: model ? { ...draft, modelId: model.id } : draft, models };
  }
  historyInput(data: string): { consume: true } | undefined {
    const result = handleHistoryInput(
      { tab: this.historyTab, selected: this.historySelected },
      data,
      this.historyItems(),
    );
    if (!result) return undefined;
    this.historyTab = result.state.tab;
    this.historySelected = result.state.selected;
    if (result.detail) {
      this.historyDetail = result.detail;
      this.page = "history-detail";
      this.message = t(this.locale, "historyDetailMsg");
    }
    this.render();
    return result;
  }
  historyItems(): readonly (HistoryCase | HistoryExperiment)[] {
    return this.historyTab === "runs"
      ? this.historyExperiments
      : this.historyCases;
  }
  async loadHistory(): Promise<void> {
    const token = this.beginNavigation();
    try {
      const history = await readLocalHistory(this.dataDir);
      if (token !== this.generation) return;
      this.historyCases = history.cases;
      this.historyExperiments = history.experiments;
      this.historyTotalBytes = history.totalBytes;
      this.recentExperiment = history.experiments[0];
      this.historyTab = "runs";
      this.historySelected = 0;
      this.page = "history";
      this.message =
        history.experiments.length || history.cases.length
          ? t(this.locale, "historyBrowse")
          : t(this.locale, "historyEmpty");
    } catch (error) {
      if (token !== this.generation) return;
      this.showError(error, "home");
    }
    this.render(true);
  }
  async openConfig(): Promise<void> {
    const token = this.beginNavigation();
    this.configDraft = draftForConfig(this.modelConfig);
    this.configSelected =
      this.configDraft.kind === "openai-compatible"
        ? Math.max(0, CONFIG_FIELDS.indexOf("model"))
        : 0;
    this.configEditing = false;
    this.configBuffer = "";
    this.configCursor = 0;
    this.configPendingToggle = false;
    this.providers = new PiModelCaller(
      this.modelConfig,
      this.piModels,
    ).providers();
    if (token !== this.generation) return;
    if (this.configDraft.kind === "pi-catalog") {
      const provider =
        this.providers.find(
          (item) => item.id === this.configDraft.providerId,
        ) ?? this.providers[0];
      if (provider)
        this.configDraft = { ...this.configDraft, providerId: provider.id };
      const refreshed = this.modelsForDraft(this.configDraft);
      this.configDraft = refreshed.draft;
      this.models = refreshed.models;
    }
    this.page = "config";
    const envName = tryEnvironmentName(this.configDraft.keyRef);
    this.message =
      envName && !process.env[envName]
        ? t(this.locale, "envNotSetConfig", {
            name: envName,
            assign: shellEnvAssignment(envName),
          })
        : t(this.locale, "editConfig");
    this.render(true);
  }
  async saveConfig(): Promise<void> {
    if (this.configBusy) return;
    this.configBusy = true;
    const token = this.beginNavigation();
    try {
      const config = configForDraft(this.configDraft);
      await saveHarnessModelConfig(this.dataDir, config);
      if (token !== this.generation) return;
      this.modelConfig = config;
      this.hasSavedModelConfig = true;
      await this.refreshHarnessAuth();
      if (token !== this.generation) return;
      await this.loadHome();
      this.message = this.harnessAuthOk
        ? "Configuration saved locally. Use /run when a TaskCase is ready."
        : `Configuration saved locally. ${credentialGapMessage(this.configDraft) ?? "Harness has no usable credential."}`;
    } catch (error) {
      if (token !== this.generation) return;
      this.page = "config";
      this.message = safeConfigError(error);
    } finally {
      this.configBusy = false;
    }
    this.render(true);
  }
  async testConfigConnection(): Promise<void> {
    if (this.configBusy) return;
    const unset = credentialGapMessage(this.configDraft);
    if (unset) {
      this.message = unset;
      this.page = "config";
      this.render(true);
      return;
    }
    this.configBusy = true;
    const token = this.beginNavigation();
    const loader = isViewportTUI(this.tui)
      ? new Loader(
          this.tui,
          (text) => text,
          (text) => text,
          "Testing the connection with a minimal request.",
        )
      : undefined;
    const overlay = loader ? this.tui.showOverlay(loader) : undefined;
    loader?.start();
    let outcome: string;
    try {
      const config = configForDraft(this.configDraft);
      this.message = t(this.locale, "testingConnection");
      this.render();
      const caller = harnessCaller(config, this.piModels);
      const validation = await caller.validate();
      outcome = `Connection test passed${validation.source ? ` using ${validation.source}` : ""}. It was not saved automatically.`;
    } catch (error) {
      outcome =
        credentialGapMessage(this.configDraft) ?? safeConfigError(error);
    } finally {
      loader?.stop();
      overlay?.hide();
      this.configBusy = false;
    }
    // A provider round trip outlives the keypress; by now the operator may have navigated elsewhere.
    if (token !== this.generation) return;
    this.message = outcome;
    this.page = "config";
    this.render(true);
  }
  async refreshHarnessAuth(): Promise<void> {
    if (!this.hasSavedModelConfig) {
      this.harnessAuthOk = false;
      return;
    }
    try {
      this.harnessAuthOk = await harnessCaller(
        this.modelConfig,
        this.piModels,
      ).hasAuth();
    } catch {
      this.harnessAuthOk = false;
    }
  }
  async loadHome(initialMessage?: string): Promise<void> {
    this.refreshCodexLogin();
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
  async loadSessions(): Promise<void> {
    const token = this.beginNavigation();
    try {
      const discovered = await Promise.all(this.packs.map(async (pack) => {
        const root = this.sessionsRoots[pack.manifest.productId] ?? this.sessionsRoot ?? pack.sessions.defaultRoot;
        return [...await pack.sessions.discover({ root, limit: SESSION_LIMIT, excludeRoots: [this.dataDir, process.cwd()] })];
      }));
      this.sessions = discovered.flat().sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, SESSION_LIMIT);
      this.sessionLimitReached = this.sessions.length === SESSION_LIMIT;
      if (token !== this.generation) return;
      this.selected = 0;
      this.searchQuery = "";
      this.searchCursor = 0;
      this.searching = false;
      this.syncIntakeLevel();
      this.page = "sessions";
      this.message = this.sessionsMessage();
    } catch (error) {
      if (token !== this.generation) return;
      this.showError(error, "home");
    }
    this.render(true);
  }
  move(amount: number): { consume: true } {
    const count = this.intakeCount();
    this.selected = Math.max(
      0,
      Math.min(Math.max(0, count - 1), this.selected + amount),
    );
    this.render();
    return { consume: true };
  }


  scheduleTimelineRender(): void {
    if (this.timelineRenderQueued) return;
    this.timelineRenderQueued = true;
    setTimeout(() => {
      this.timelineRenderQueued = false;
      if (this.page === "running") this.render();
    }, 16);
  }

  visibleTimeline(): readonly TimelineEntry[] {
    const filter = TIMELINE_FILTERS[this.timelineFilterIndex] ?? "ALL";
    return this.timeline.filter(
      (entry) =>
        matchesFilter(entry, filter) &&
        matchesCanvasQuery(entry, this.findQuery),
    );
  }

  async setLocale(typed: string): Promise<void> {
    const argument = typed.replace(/^\/lang\s*/, "").trim();
    this.locale = parseLocale(argument) ?? nextLocale(this.locale);
    this.setHomeMessage(t(this.locale, "langNow"));
    try {
      await saveTuiPreferences(this.dataDir, { locale: this.locale });
    } catch {
      /* in-memory locale already applied; a locked preferences file must not abort the switch */
    }
  }


  showError(
    error: unknown,
    returnPage: Exclude<Page, "error" | "running" | "loading">,
  ): void {
    this.preparePhase = undefined;
    this.prepareDetail = undefined;
    stopRunClock(this);
    this.errorReturnPage = returnPage;
    this.page = "error";
    this.message = operatorErrorMessage(error);
  }

  returnFromError(): { consume: true } {
    this.page = this.errorReturnPage;
    this.message = t(this.locale, "returnedPrevious");
    this.render();
    return { consume: true };
  }

  openReport(
    experimentRoot: string | undefined,
    reportPath: string | undefined,
  ): { consume: true } {
    if (!experimentRoot || !reportPath) {
      this.message = t(this.locale, "noReport");
      this.render();
      return { consume: true };
    }
    void openExperimentReport(experimentRoot, reportPath)
      .then(() => {
        this.message = t(this.locale, "requestedOpenReport");
        this.render();
      })
      .catch((error: unknown) => {
        this.message = t(this.locale, "couldNotOpenReport", {
          error: errorMessage(error),
        });
        this.render(true);
      });
    return { consume: true };
  }

  openTrace(): { consume: true } {
    const experimentRoot =
      this.result?.experimentRoot ??
      (this.result ? dirname(this.result.reportPath) : undefined);
    const runId = this.result?.record.attempt?.runId;
    if (!experimentRoot || !runId) {
      this.message = t(this.locale, "noTrace");
      this.render();
      return { consume: true };
    }
    void openExperimentTrace(experimentRoot, runId)
      .then(() => {
        this.message = t(this.locale, "requestedOpenTrace");
        this.render();
      })
      .catch((error: unknown) => {
        this.message = t(this.locale, "couldNotOpenTrace", {
          error: errorMessage(error),
        });
        this.render(true);
      });
    return { consume: true };
  }

  openLocal(target: string | undefined): { consume: true } {
    if (!target) {
      this.message = t(this.locale, "noLocalPath");
      this.render();
      return { consume: true };
    }
    void openAllowedLocalPath(this.dataDir, target)
      .then(() => {
        this.message = t(this.locale, "requestedOpenPath");
        this.render();
      })
      .catch((error: unknown) => {
        this.message = t(this.locale, "couldNotOpenPath", {
          error: errorMessage(error),
        });
        this.render(true);
      });
    return { consume: true };
  }

  openFileUrl(url: string): void {
    void openAllowedFileUrl(this.dataDir, url)
      .then(() => {
        this.message = t(this.locale, "requestedOpenPath");
        this.render();
      })
      .catch((error: unknown) => {
        this.message = t(this.locale, "couldNotOpenPath", {
          error: errorMessage(error),
        });
        this.render(true);
      });
  }

  backToHome(): { consume: true } {
    void discardRecovery(this);
    this.generation += 1;
    this.configEditing = false;
    this.configBuffer = "";
    this.configCursor = 0;
    this.configDraft = draftForConfig(this.modelConfig);
    this.configPendingToggle = false;
    this.historyDetail = undefined;
    this.hideHelp();
    this.hideCommandOverlay();
    this.viewer = undefined;
    this.actorsOpen = false;
    this.page = "home";
    this.composer = "";
    this.composerCursor = 0;
    this.showSuggestions = false;
    this.selected = 0;
    this.inlineHelp = false;
    this.searching = false;
    this.searchQuery = "";
    this.searchCursor = 0;
    this.finding = false;
    this.findQuery = "";
    this.findCursor = 0;
    this.intakeLevel = "projects";
    this.preparePhase = undefined;
    this.prepareDetail = undefined;
    this.detailExpanded = false;
    this.message = t(this.locale, "backAtHome");
    this.render();
    return { consume: true };
  }

  close(): { consume: true } {
    if (this.closed) return { consume: true };
    this.generation += 1;
    this.closed = true;
    stopRunClock(this);
    this.hideHelp();
    this.hideCommandOverlay();
    // An experiment that started but never reached the running page would otherwise outlive the TUI.
    const experiment = this.activeExperiment;
    this.activeExperiment = undefined;
    if (experiment && !this.cancelling)
      this.closing = experiment.cancel().catch(() => undefined);
    if (this.started) this.tui.stop();
    this.resolveClosed?.();
    return { consume: true };
  }


  openIntakeSelection(): { consume: true } {
    if (this.intakeLevel === "projects") {
      const project = this.visibleProjects()[this.selected];
      if (!project) return { consume: true };
      this.activeProjectKey = project.key;
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
    this.message = t(this.locale, "freezingCase");
    this.render();
    void freeze(this, selected.sourcePath, { thenRun: true });
    return { consume: true };
  }

  /** The one place that phrases the session browser's state, so every level change says the same thing. */
  sessionsMessage(): string {
    if (!this.sessions.length) return t(this.locale, "noSessionsFound");
    const truncation = this.sessionLimitReached
      ? t(this.locale, "showingNewest", { n: SESSION_LIMIT })
      : "";
    return (
      (this.intakeLevel === "projects"
        ? t(this.locale, "chooseProject")
        : t(this.locale, "chooseSession")) + truncation
    );
  }

  refreshCodexLogin(): void {
    void this.refreshProductAuth();
  }

  async refreshProductAuth(): Promise<void> {
    const statuses = await Promise.all(this.packs.map((pack) => pack.checkAuth()));
    this.hasCodexLogin = statuses.some((status) => status.configured);
  }

  canLeaveProject(): boolean {
    return (
      this.intakeLevel === "sessions" && this.groupedProjects().length > 1
    );
  }

  backToProjects(): { consume: true } {
    this.intakeLevel = "projects";
    this.selected = Math.max(
      0,
      this.visibleProjects().findIndex(
        (project) => project.key === this.activeProjectKey,
      ),
    );
    this.searching = false;
    this.searchQuery = "";
    this.searchCursor = 0;
    this.message = this.sessionsMessage();
    this.render();
    return { consume: true };
  }

  syncIntakeLevel(): void {
    const projects = this.groupedProjects();
    if (projects.length <= 1) {
      this.intakeLevel = "sessions";
      this.activeProjectKey = projects[0]?.key ?? "";
      return;
    }
    if (
      this.intakeLevel === "sessions" &&
      !projects.some((project) => project.key === this.activeProjectKey)
    ) {
      this.intakeLevel = "projects";
      this.activeProjectKey = projects[0]?.key ?? "";
    }
  }

  /** Grouping re-sorts every discovered session, and the view asks for it on every frame. */
  groupedProjects(): SessionProject[] {
    const cached = this.groupedCache;
    if (
      cached &&
      cached.sessions === this.sessions &&
      cached.filterEligible === this.filterEligible
    )
      return cached.projects;
    const projects = groupSessionsByProject(
      this.filterEligible ? this.sessions.filter(isEligibleSession) : this.sessions,
    );
    this.groupedCache = {
      sessions: this.sessions,
      filterEligible: this.filterEligible,
      projects,
    };
    return projects;
  }

  visibleProjects(): SessionProject[] {
    return this.groupedProjects().filter((project) =>
      matchesProjectQuery(project, this.searchQuery),
    );
  }

  visibleSessions(): readonly SessionSummary[] {
    const pool = this.filterEligible
      ? this.sessions.filter(isEligibleSession)
      : this.sessions;
    const project = this.groupedProjects().find(
      (item) => item.key === this.activeProjectKey,
    );
    const scoped =
      this.intakeLevel === "sessions" && project ? project.sessions : pool;
    return scoped.filter((session) =>
      matchesIntakeQuery(session, this.searchQuery),
    );
  }

  intakeCount(): number {
    return this.intakeLevel === "projects"
      ? this.visibleProjects().length
      : this.visibleSessions().length;
  }

  beginNavigation(): number {
    this.generation += 1;
    return this.generation;
  }

  isEditingText(): boolean {
    return (
      this.configEditing ||
      this.searching ||
      this.finding ||
      this.page === "source" ||
      (this.page === "home" && this.composer.length > 0)
    );
  }

  showHelp(): { consume: true } {
    if (typeof this.tui.showOverlay === "function") {
      this.hideHelp();
      this.helpOverlay = this.tui.showOverlay(
        new HelpOverlay(
          createTheme(this.tui.terminal?.columns ?? 120),
          this.page,
          this.locale,
        ),
      );
      this.message = t(this.locale, "helpCommands");
    } else {
      this.inlineHelp = true;
    }
    this.render();
    return { consume: true };
  }

  hideHelp(): void {
    this.helpOverlay?.hide();
    this.helpOverlay = undefined;
    this.inlineHelp = false;
  }

  syncCommandOverlay(): void {
    if (!this.showSuggestions || typeof this.tui.showOverlay !== "function") {
      this.hideCommandOverlay();
      return;
    }
    const list =
      this.commandSelectList ??
      commandSelectList(createTheme(this.tui.terminal?.columns ?? 80));
    list.setFilter(this.composer);
    if (this.commandOverlay) return;
    this.commandSelectList = list;
    const columns = this.tui.terminal?.columns ?? 80;
    this.commandOverlay = this.tui.showOverlay(list, {
      anchor: "bottom-left",
      // A fixed 48 columns overflows a narrow terminal, which is exactly where the overlay hurts most.
      width: Math.max(20, Math.min(48, columns - 4)),
      maxHeight: 8,
      nonCapturing: true,
    });
  }

  hideCommandOverlay(): void {
    this.commandOverlay?.hide();
    this.commandOverlay = undefined;
    this.commandSelectList = undefined;
  }

  /** Serializing the draft on every frame is wasted work; both inputs are replaced, never mutated. */
  configDirty(): boolean {
    const cached = this.dirtyCache;
    if (
      cached &&
      cached.draft === this.configDraft &&
      cached.config === this.modelConfig
    )
      return cached.dirty;
    let dirty: boolean;
    try {
      dirty =
        JSON.stringify(configForDraft(this.configDraft)) !==
        JSON.stringify(this.modelConfig);
    } catch {
      dirty = true;
    }
    this.dirtyCache = {
      draft: this.configDraft,
      config: this.modelConfig,
      dirty,
    };
    return dirty;
  }

  muteNodeWarnings(): void {
    if (this.emitWarning) return;
    this.emitWarning = process.emitWarning.bind(process);
    process.emitWarning = () => undefined;
  }

  restoreNodeWarnings(): void {
    if (!this.emitWarning) return;
    process.emitWarning = this.emitWarning;
    this.emitWarning = undefined;
  }

  viewport(): { height?: number } {
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? { height: rows } : {};
  }

  render(immediate = false): void {
    this.workbench.invalidate();
    if (immediate) this.tui.renderNow();
    else this.tui.requestRender();
  }

  view(): WorkbenchView {
    const envName = envNameFromConfig(this.modelConfig, this.configDraft);
    return projectWorkbenchView({
      page: this.page,
      cwd: this.displayCwd,
      modelConfig: this.modelConfig,
      hasSavedModelConfig: this.hasSavedModelConfig,
      locale: this.locale,
      harnessAuthOk: this.harnessAuthOk,
      ...(envName ? { envName } : {}),
      hasCodexLogin: this.hasCodexLogin,
      taskCase: this.taskCase,
      message: this.message,
      inlineHelp: this.inlineHelp,
      cancelling: this.cancelling,
      recentExperiment: this.recentExperiment,
      composer: this.composer,
      composerCursor: this.composerCursor,
      showSuggestions: this.showSuggestions,
      commandOverlay: Boolean(this.commandOverlay),
      configDraft: this.configDraft,
      configSelected: this.configSelected,
      configEditing: this.configEditing,
      configBuffer: this.configBuffer,
      configCursor: this.configCursor,
      configDirty: this.configDirty(),
      configPendingToggle: this.configPendingToggle,
      historyTotalBytes: this.historyTotalBytes,
      historyTab: this.historyTab,
      historyItems: this.historyItems(),
      historySelected: this.historySelected,
      historyDetail: this.historyDetail,
      intakeLevel: this.intakeLevel,
      visibleProjects: this.visibleProjects(),
      activeProjectKey: this.activeProjectKey,
      visibleSessions: this.visibleSessions(),
      selected: this.selected,
      filterEligible: this.filterEligible,
      searchQuery: this.searchQuery,
      searchCursor: this.searchCursor,
      searching: this.searching,
      inspection: this.inspection,
      privacy: this.privacy,
      inspectionTaskInput: this.inspectionTaskInput,
      inspectionShowOutcome: this.inspectionShowOutcome,
      sourceRoot: this.sourceRoot,
      sourceCursor: this.sourceCursor,
      preflight: this.preflight,
      candidate: this.taskCase
        ? findProductPack(this.taskCase.source.productId).defaultCandidate()
        : this.workflow?.candidate,
      recoveryAttempt: this.recoveryAttempt,
      effort: this.modelConfig.effort,
      policy: this.workflow?.policy,
      ...(this.preparePhase
        ? {
            preparePhase: this.preparePhase,
            ...(this.prepareDetail
              ? { prepareDetail: this.prepareDetail }
              : {}),
          }
        : {}),
      timeline: this.timeline,
      visibleTimeline: this.visibleTimeline(),
      timelineSelected: this.timelineSelected,
      timelineFilterIndex: this.timelineFilterIndex,
      timelineFollowing: this.timelineFollowing,
      detailExpanded: this.detailExpanded,
      runStartedAt: this.runStartedAt,
      nowMs: this.nowMs(),
      result: this.result,
      ...(this.viewer ? { viewer: this.viewer } : {}),
      ...(this.actorsOpen ? { actorsOpen: true } : {}),
      ...(this.finding
        ? {
            finding: true,
            findQuery: this.findQuery,
            findCursor: this.findCursor,
          }
        : {}),
    });
  }
}


function envUnsetMessage(keyRef: string): string | undefined {
  const name = tryEnvironmentName(keyRef);
  if (!name || process.env[name]) return undefined;
  return `${name} is not set in this shell. ${shellEnvAssignment(name)}`;
}

function credentialGapMessage(draft: HarnessConfigDraft): string | undefined {
  if (draft.kind !== "openai-compatible") return undefined;
  if (hasFileApiKey(draft)) return undefined;
  const unset = envUnsetMessage(draft.keyRef);
  if (unset) return unset;
  if (!draft.keyRef.trim()) {
    return "Add an API key to .reprise/harness-model.json, or an env:NAME reference.";
  }
  return undefined;
}

function harnessCaller(
  config: HarnessModelConfig,
  catalog?: PiModels,
): PiModelCaller {
  return config.schemaVersion === 2 &&
    config.provider.kind === "openai-compatible"
    ? new PiModelCaller(config)
    : new PiModelCaller(config, catalog);
}

