import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import { Loader, ProcessTerminal, TuiAltScreen, isViewportTUI, matchesKey, type OverlayHandle, type TUI } from '@earendil-works/pi-tui';
import type { EventEnvelope, TaskCase } from '../core/schema.js';
import type { CodexExperimentPreflight, CodexExperimentResult, ExperimentHandle } from '../application/codex-experiment.js';
import type { CodexTuiWorkflow } from '../application/codex-tui-workflow.js';
import {
  configForDraft, defaultHarnessModelConfig, draftForConfig, readHarnessModelConfig,
  saveHarnessModelConfig, safeConfigError, setConfigField, type HarnessConfigDraft, type HarnessModelConfig,
} from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import { discoverCodexSessions, freezeCodexSession, inspectCodexSession, isEligible, type CodexSessionInspection, type CodexSessionPrivacy, type CodexSessionSummary } from '../products/codex/sessions.js';
import { errorMessage, isTextInput, nextOption, slashCommands, TIMELINE_FILTERS } from './format.js';
import { groupSessionsByProject, matchesIntakeQuery, matchesProjectQuery, type IntakeLevel, type SessionProject } from './pages/intake.js';
import { readLocalHistory, type HistoryCase, type HistoryExperiment } from './local-history.js';
import { HelpOverlay, HELP_COMMANDS_LINE, commandSelectList } from './overlays.js';
import { CONFIG_FIELDS } from './pages/config.js';
import { countCalls, countTurns, currentRunState, elapsedFrom } from './pages/run.js';
import { createTheme } from './theme.js';
import { projectTimelineEvent, type TimelineEntry } from './timeline.js';
import { Workbench, mountWorkbench, type WorkbenchView } from './workbench.js';

type Page = WorkbenchView['page'];
type PiModels = Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
type Option = { readonly id: string; readonly name: string };
type ConfigDraft = HarnessConfigDraft;

export type CodexIntakeTuiOptions = {
  readonly dataDir: string;
  readonly sessionsRoot: string;
  readonly privacy: CodexSessionPrivacy;
  readonly tui?: TUI;
  readonly now?: () => string;
  readonly piModels?: PiModels;
  readonly workflow?: CodexTuiWorkflow;
};

/** Keyboard-only Home-first benchmark workbench for configuration, intake, and isolated runs. */
export class CodexIntakeTui {
  readonly #dataDir: string;
  readonly #sessionsRoot: string;
  #privacy: CodexSessionPrivacy;
  readonly #tui: TUI;
  readonly #workbench: Workbench;
  readonly #now: () => string;
  readonly #piModels: PiModels | undefined;
  readonly #workflow: CodexTuiWorkflow | undefined;
  #page: Page = 'loading';
  #sessions: readonly CodexSessionSummary[] = [];
  #inspection: CodexSessionInspection | undefined;
  #inspectionTaskInput = 0;
  #selected = 0;
  #filterEligible = false;
  #intakeLevel: IntakeLevel = 'projects';
  #activeProjectKey = '';
  #searchQuery = '';
  #searching = false;
  #inspectionShowOutcome = false;
  #modelConfig: HarnessModelConfig = defaultHarnessModelConfig();
  #hasSavedModelConfig = false;
  #configDraft: ConfigDraft = draftForConfig(defaultHarnessModelConfig());
  #configSelected = 0;
  #configEditing = false;
  #configBuffer = '';
  #providers: readonly Option[] = [];
  #models: readonly Option[] = [];
  #message = 'Reading local Reprise configuration...';
  #composer = '';
  #showSuggestions = false;
  #taskCase: TaskCase | undefined;
  #historyCases: readonly HistoryCase[] = [];
  #historyExperiments: readonly HistoryExperiment[] = [];
  #historyTab: 'runs' | 'cases' = 'runs';
  #historySelected = 0;
  #historyDetail: HistoryCase | HistoryExperiment | undefined;
  #recentExperiment: HistoryExperiment | undefined;
  #sourceRoot = '';
  #preflight: CodexExperimentPreflight | undefined;
  #activeExperiment: ExperimentHandle | undefined;
  #result: CodexExperimentResult | undefined;
  #timeline: TimelineEntry[] = [];
  #timelineSelected = 0;
  #timelineFilterIndex = 0;
  #timelineFollowing = true;
  #detailExpanded = false;
  #cancelling = false;
  #generation = 0;
  #timelineRenderQueued = false;
  #started = false;
  #closed = false;
  #resolveClosed: (() => void) | undefined;
  #helpOverlay: OverlayHandle | undefined;
  #commandOverlay: OverlayHandle | undefined;
  #inlineHelp = false;

  constructor(options: CodexIntakeTuiOptions) {
    this.#dataDir = options.dataDir;
    this.#sessionsRoot = options.sessionsRoot;
    this.#privacy = options.privacy;
    this.#tui = options.tui ?? new TuiAltScreen(new ProcessTerminal());
    this.#workbench = new Workbench(() => this.#view(), () => this.#viewport());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#piModels = options.piModels;
    this.#workflow = options.workflow;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    mountWorkbench(this.#tui, this.#workbench);
    this.#tui.addInputListener((data) => this.handleInput(data));
    this.#render();
    this.#tui.start();
    let configurationIssue: string | undefined;
    try {
      const configured = await readHarnessModelConfig(this.#dataDir);
      if (configured) {
        this.#modelConfig = configured;
        this.#hasSavedModelConfig = true;
      }
    } catch (error) {
      configurationIssue = `Could not read local configuration: ${safeConfigError(error)}`;
    }
    await this.#loadHome(configurationIssue);
    this.#render(true);
  }

  async run(): Promise<void> {
    await this.start();
    if (this.#closed) return;
    await new Promise<void>((resolve) => { this.#resolveClosed = resolve; });
  }

  preview(width = 120): string {
    return this.#workbench.render(width).join('\n');
  }

  handleInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'ctrl+c')) return this.#page === 'running' ? this.#requestCancellation() : this.#close();
    if (this.#helpOverlay && matchesKey(data, 'escape')) {
      this.#hideHelp();
      return { consume: true };
    }
    if (!this.#isEditingText() && matchesKey(data, '?')) return this.#showHelp();
    if (this.#page === 'running') return this.#runningInput(data);
    if (this.#page === 'config') return this.#configPageInput(data);
    if (this.#page === 'history') return this.#historyInput(data);
    if (this.#page === 'history-detail') return this.#historyDetailInput(data);
    if (this.#page === 'home') return this.#homeInput(data);
    if (this.#page === 'source') return this.#sourceInput(data);
    if (this.#page === 'preflight') return this.#preflightInput(data);
    if (this.#page === 'confirm') return this.#confirmInput(data);
    if (this.#page === 'result' && (matchesKey(data, 'enter') || matchesKey(data, 'b'))) return this.#backToHome();
    if (this.#page === 'error' && matchesKey(data, 'b')) return this.#backToHome();
    if (this.#page === 'sessions') return this.#sessionsInput(data);
    if (this.#page === 'inspection') return this.#inspectionInput(data);
    if (matchesKey(data, 'escape')) return this.#backToHome();
    return undefined;
  }

  #homeInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'escape')) {
      this.#composer = '';
      this.#showSuggestions = false;
      this.#hideCommandOverlay();
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'backspace')) {
      this.#composer = this.#composer.slice(0, -1);
      this.#showSuggestions = this.#composer.startsWith('/');
      this.#syncCommandOverlay();
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'tab')) {
      const matches = slashCommands().filter((command) => command.startsWith(this.#composer.toLowerCase()));
      if (matches.length === 1) this.#composer = matches[0] ?? this.#composer;
      this.#showSuggestions = true;
      this.#syncCommandOverlay();
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) return this.#submitComposer();
    if (isTextInput(data)) {
      this.#composer += data;
      this.#showSuggestions = this.#composer.startsWith('/');
      this.#syncCommandOverlay();
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #submitComposer(): { consume: true } {
    const command = this.#composer.trim().toLowerCase();
    this.#composer = '';
    this.#showSuggestions = false;
    this.#hideCommandOverlay();
    if (!command) return { consume: true };
    if (!command.startsWith('/')) {
      this.#message = 'Reprise is a Benchmark workbench; enter /help to see available actions.';
      this.#render();
      return { consume: true };
    }
    if (command === '/help') {
      this.#message = `${HELP_COMMANDS_LINE}. Ctrl+C exits or requests cancellation; Esc returns Home.`;
      this.#render();
      return { consume: true };
    }
    if (command === '/config') {
      void this.#openConfig();
      return { consume: true };
    }
    if (command === '/intake') {
      this.#message = 'Discovering local Codex sessions; no session content is executed.';
      this.#render();
      void this.#loadSessions();
      return { consume: true };
    }
    if (command === '/run') {
      if (!this.#taskCase) {
        this.#message = 'No current TaskCase. Use /intake to freeze one or /history to select one.';
        this.#render();
        return { consume: true };
      }
      if (!this.#workflow) {
        this.#message = 'Run workflow is unavailable in this TUI context.';
        this.#render();
        return { consume: true };
      }
      this.#page = 'source';
      this.#sourceRoot = historicalCwd(this.#taskCase) ?? '';
      this.#message = this.#sourceRoot
        ? 'Historical working directory is prefilled. Confirm it or edit the absolute source root for the isolated baseline.'
        : 'Enter the absolute source root for the isolated baseline.';
      this.#render();
      return { consume: true };
    }
    if (command === '/history') {
      this.#message = 'Reading local TaskCases and experiments only.';
      this.#render();
      void this.#loadHistory();
      return { consume: true };
    }
    this.#message = `Unknown command: ${command}. Enter /help for available commands.`;
    this.#render();
    return { consume: true };
  }

  #configPageInput(data: string): { consume: true } | undefined {
    if (this.#configEditing) return this.#editConfigValue(data);
    if (matchesKey(data, 'escape')) return this.#backToHome();
    if (matchesKey(data, 'up')) return this.#moveConfig(-1);
    if (matchesKey(data, 'down')) return this.#moveConfig(1);
    if (matchesKey(data, 't')) {
      void this.#testConfigConnection();
      return { consume: true };
    }
    if (matchesKey(data, 's')) {
      void this.#saveConfig();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) return this.#beginConfigEdit();
    return undefined;
  }

  #moveConfig(amount: number): { consume: true } {
    this.#configSelected = Math.max(0, Math.min(CONFIG_FIELDS.length - 1, this.#configSelected + amount));
    this.#render();
    return { consume: true };
  }

  #beginConfigEdit(): { consume: true } {
    const field = CONFIG_FIELDS[this.#configSelected] ?? CONFIG_FIELDS[0];
    if (field === 'provider type') {
      this.#toggleProviderKind();
      return { consume: true };
    }
    if (field === 'effort') {
      this.#cycleDraftEffort();
      return { consume: true };
    }
    if (this.#configDraft.kind === 'pi-catalog' && field === 'provider label') {
      this.#cycleDraftProvider();
      return { consume: true };
    }
    if (this.#configDraft.kind === 'pi-catalog' && field === 'model') {
      this.#cycleDraftModel();
      return { consume: true };
    }
    this.#configEditing = true;
    this.#configBuffer = '';
    this.#message = `Editing ${field}. Type a replacement value, Enter applies it, and Esc keeps the previous value.`;
    this.#render();
    return { consume: true };
  }

  #editConfigValue(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'escape')) {
      this.#configEditing = false;
      this.#configBuffer = '';
      this.#message = 'Field edit discarded. Configuration remains an in-memory draft.';
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+a')) {
      this.#configBuffer = '';
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'backspace')) {
      this.#configBuffer = this.#configBuffer.slice(0, -1);
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {
      const field = CONFIG_FIELDS[this.#configSelected] ?? CONFIG_FIELDS[0];
      this.#configDraft = setConfigField(this.#configDraft, field, this.#configBuffer.trim());
      this.#configEditing = false;
      this.#configBuffer = '';
      this.#message = 'Draft changed. Save is local only; use t to explicitly test the connection.';
      this.#render();
      return { consume: true };
    }
    if (isTextInput(data)) {
      this.#configBuffer += data;
      this.#render();
      return { consume: true };
    }
    return { consume: true };
  }

  #toggleProviderKind(): void {
    if (this.#configDraft.kind === 'pi-catalog') {
      this.#configDraft = { ...this.#configDraft, kind: 'openai-compatible', providerId: 'openai-compatible', baseUrl: '', keyRef: '' };
      this.#message = 'OpenAI-compatible selected. Enter its endpoint, model, and environment key reference.';
    } else {
      const provider = this.#providers[0];
      this.#configDraft = { ...this.#configDraft, kind: 'pi-catalog', providerId: provider?.id ?? 'openai-codex', baseUrl: '', keyRef: '' };
      this.#refreshDraftModels();
      this.#message = 'Pi catalog selected. Pi manages its configured credentials.';
    }
    this.#render();
  }

  #cycleDraftProvider(): void {
    const provider = nextOption(this.#providers, this.#configDraft.providerId);
    if (!provider) return;
    this.#configDraft = { ...this.#configDraft, providerId: provider.id, modelId: '' };
    this.#refreshDraftModels();
    this.#message = 'Provider changed in the draft.';
    this.#render();
  }

  #refreshDraftModels(): void {
    const config = configForDraft(this.#configDraft);
    this.#models = new PiModelCaller(config, this.#piModels).models();
    if (this.#models.some((model) => model.id === this.#configDraft.modelId)) return;
    const model = this.#models[0];
    if (model) this.#configDraft = { ...this.#configDraft, modelId: model.id };
  }

  #cycleDraftModel(): void {
    const model = nextOption(this.#models, this.#configDraft.modelId);
    if (!model) return;
    this.#configDraft = { ...this.#configDraft, modelId: model.id };
    this.#message = 'Model changed in the draft.';
    this.#render();
  }

  #cycleDraftEffort(): void {
    const efforts: readonly HarnessModelConfig['effort'][] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const effort = efforts[(efforts.indexOf(this.#configDraft.effort) + 1) % efforts.length];
    if (effort) this.#configDraft = { ...this.#configDraft, effort };
    this.#message = 'Effort changed in the draft.';
    this.#render();
  }

  #historyInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'up')) return this.#moveHistory(-1);
    if (matchesKey(data, 'down')) return this.#moveHistory(1);
    if (matchesKey(data, 'tab')) {
      this.#historyTab = this.#historyTab === 'runs' ? 'cases' : 'runs';
      this.#historySelected = 0;
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {
      this.#historyDetail = this.#historyItems()[this.#historySelected];
      if (!this.#historyDetail) return { consume: true };
      this.#page = 'history-detail';
      this.#message = 'Local history detail. Nothing is executed or modified until you select a TaskCase.';
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #historyDetailInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'escape')) {
      this.#page = 'history';
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter') && this.#historyDetail && 'taskCase' in this.#historyDetail) {
      this.#taskCase = this.#historyDetail.taskCase;
      this.#page = 'home';
      this.#message = `TaskCase ${this.#taskCase.caseId} is current.`;
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #moveHistory(amount: number): { consume: true } {
    const count = this.#historyItems().length;
    this.#historySelected = Math.max(0, Math.min(Math.max(0, count - 1), this.#historySelected + amount));
    this.#render();
    return { consume: true };
  }

  #historyItems(): readonly (HistoryCase | HistoryExperiment)[] {
    return this.#historyTab === 'runs' ? this.#historyExperiments : this.#historyCases;
  }

  async #loadHistory(): Promise<void> {
    const token = this.#beginNavigation();
    try {
      const history = await readLocalHistory(this.#dataDir);
      if (token !== this.#generation) return;
      this.#historyCases = history.cases;
      this.#historyExperiments = history.experiments;
      this.#recentExperiment = history.experiments[0];
      this.#historyTab = 'runs';
      this.#historySelected = 0;
      this.#page = 'history';
      this.#message = history.experiments.length || history.cases.length
        ? 'Browse local experiments or switch to TaskCases with Tab.'
        : 'No local TaskCases or experiments were found. Use /intake to freeze one.';
    } catch (error) {
      if (token !== this.#generation) return;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  #sessionsInput(data: string): { consume: true } | undefined {
    if (this.#searching) {
      if (matchesKey(data, 'escape')) {
        this.#searching = false;
        this.#searchQuery = '';
        this.#selected = 0;
        this.#render();
        return { consume: true };
      }
      if (matchesKey(data, 'backspace')) {
        this.#searchQuery = this.#searchQuery.slice(0, -1);
        this.#selected = 0;
        this.#render();
        return { consume: true };
      }
      if (matchesKey(data, 'up')) return this.#move(-1);
      if (matchesKey(data, 'down')) return this.#move(1);
      if (matchesKey(data, 'enter')) return this.#openIntakeSelection();
      if (isTextInput(data) && data !== '/') {
        this.#searchQuery += data;
        this.#selected = 0;
        this.#render();
        return { consume: true };
      }
      return { consume: true };
    }
    if (matchesKey(data, 'escape')) {
      if (this.#intakeLevel === 'sessions' && this.#groupedProjects().length > 1) {
        this.#intakeLevel = 'projects';
        this.#selected = Math.max(0, this.#visibleProjects().findIndex((project) => project.key === this.#activeProjectKey));
        this.#render();
        return { consume: true };
      }
      return this.#backToHome();
    }
    if (matchesKey(data, '/') || matchesKey(data, 'ctrl+/')) {
      this.#searching = true;
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'backspace') && this.#intakeLevel === 'sessions' && this.#groupedProjects().length > 1) {
      this.#intakeLevel = 'projects';
      this.#selected = Math.max(0, this.#visibleProjects().findIndex((project) => project.key === this.#activeProjectKey));
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'up')) return this.#move(-1);
    if (matchesKey(data, 'down')) return this.#move(1);
    if (matchesKey(data, 'f')) {
      this.#filterEligible = !this.#filterEligible;
      this.#selected = 0;
      this.#message = this.#filterEligible
        ? 'Showing completed sessions with a user task and at least one assistant message or tool call.'
        : 'Showing all discovered sessions.';
      this.#syncIntakeLevel();
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) return this.#openIntakeSelection();
    return undefined;
  }

  #inspectionInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      const count = this.#inspection?.transcript.filter((message) => message.role === 'user').length ?? 0;
      this.#inspectionTaskInput = Math.max(0, Math.min(Math.max(0, count - 1), this.#inspectionTaskInput + (matchesKey(data, 'up') ? -1 : 1)));
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 't')) {
      this.#privacy = { ...this.#privacy, allowModelText: !this.#privacy.allowModelText };
      this.#message = `Model text sharing with the configured Pi provider is now ${this.#privacy.allowModelText ? 'allowed for this TaskCase' : 'blocked'}.`;
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'd')) {
      this.#inspectionShowOutcome = !this.#inspectionShowOutcome;
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'escape')) {
      this.#page = 'sessions';
      this.#message = 'Choose a historical session. Discovery did not execute any session content.';
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter') && this.#inspection) {
      this.#message = 'Freezing immutable TaskCase with the displayed privacy policy...';
      this.#render();
      const selected = this.#inspection.transcript.filter((message) => message.role === 'user')[this.#inspectionTaskInput];
      void this.#freeze(this.#inspection.sourcePath, selected?.id);
      return { consume: true };
    }
    return undefined;
  }

  async #openConfig(): Promise<void> {
    const token = this.#beginNavigation();
    this.#configDraft = draftForConfig(this.#modelConfig);
    this.#configSelected = 0;
    this.#configEditing = false;
    this.#configBuffer = '';
    this.#providers = new PiModelCaller(this.#modelConfig, this.#piModels).providers();
    if (token !== this.#generation) return;
    if (this.#configDraft.kind === 'pi-catalog') {
      const provider = this.#providers.find((item) => item.id === this.#configDraft.providerId) ?? this.#providers[0];
      if (provider) this.#configDraft = { ...this.#configDraft, providerId: provider.id };
      this.#refreshDraftModels();
    }
    this.#page = 'config';
    this.#message = 'Edit an in-memory Harness configuration. Save never sends a request; connection testing is explicit.';
    this.#render(true);
  }

  async #saveConfig(): Promise<void> {
    try {
      const config = configForDraft(this.#configDraft);
      await saveHarnessModelConfig(this.#dataDir, config);
      this.#modelConfig = config;
      this.#hasSavedModelConfig = true;
      await this.#loadHome();
      this.#message = 'Configuration saved locally. Use /run when the TaskCase and runtime preflight are ready.';
    } catch (error) {
      this.#page = 'config';
      this.#message = safeConfigError(error);
    }
    this.#render(true);
  }

  async #testConfigConnection(): Promise<void> {
    const loader = isViewportTUI(this.#tui)
      ? new Loader(this.#tui, (text) => text, (text) => text, 'Testing the connection with a minimal request.')
      : undefined;
    const overlay = loader ? this.#tui.showOverlay(loader) : undefined;
    loader?.start();
    try {
      const config = configForDraft(this.#configDraft);
      this.#message = 'Testing the connection with a minimal request. This may call the configured provider.';
      this.#render();
      const caller = config.schemaVersion === 2 && config.provider.kind === 'openai-compatible'
        ? new PiModelCaller(config)
        : new PiModelCaller(config, this.#piModels);
      const validation = await caller.validate();
      this.#message = `Connection test passed${validation.source ? ` using ${validation.source}` : ''}. It was not saved automatically.`;
    } catch (error) {
      this.#message = safeConfigError(error);
    } finally {
      loader?.stop();
      overlay?.hide();
    }
    this.#page = 'config';
    this.#render(true);
  }

  async #loadHome(initialMessage?: string): Promise<void> {
    const token = this.#beginNavigation();
    try {
      this.#recentExperiment = (await readLocalHistory(this.#dataDir)).experiments[0];
      if (token !== this.#generation) return;
    } catch {
      if (token !== this.#generation) return;
      this.#recentExperiment = undefined;
    }
    this.#page = 'home';
    this.#message = initialMessage ?? 'Welcome back. Use /help to see the available local workflows.';
  }

  async #loadSessions(): Promise<void> {
    const token = this.#beginNavigation();
    try {
      this.#sessions = await discoverCodexSessions(this.#sessionsRoot, 150);
      if (token !== this.#generation) return;
      this.#selected = 0;
      this.#searchQuery = '';
      this.#searching = false;
      this.#syncIntakeLevel();
      this.#page = 'sessions';
      this.#message = this.#sessions.length
        ? (this.#intakeLevel === 'projects'
          ? 'Choose a project, then a session. Type / to search.'
          : 'Choose a historical session. Discovery did not execute any session content.')
        : 'No local Codex rollout JSONL sessions were found.';
    } catch (error) {
      if (token !== this.#generation) return;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  #move(amount: number): { consume: true } {
    const count = this.#intakeCount();
    this.#selected = Math.max(0, Math.min(Math.max(0, count - 1), this.#selected + amount));
    this.#render();
    return { consume: true };
  }

  async #inspect(sourcePath: string): Promise<void> {
    const token = this.#beginNavigation();
    try {
      this.#inspection = await inspectCodexSession(sourcePath);
      if (token !== this.#generation) return;
      this.#inspectionTaskInput = 0;
      this.#inspectionShowOutcome = false;
      this.#page = 'inspection';
      this.#message = 'Review the session details and privacy policy before writing a TaskCase.';
    } catch (error) {
      if (token !== this.#generation) return;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  async #freeze(sourcePath: string, initialMessageId?: string): Promise<void> {
    const token = this.#beginNavigation();
    try {
      const result = await freezeCodexSession({
        sourcePath, casesRoot: join(this.#dataDir, 'cases'), now: this.#now(), privacy: this.#privacy,
        ...(initialMessageId ? { initialMessageId } : {}),
      });
      if (token !== this.#generation) return;
      this.#taskCase = result.taskCase;
      this.#page = 'home';
      this.#message = result.reused
        ? `TaskCase ${result.taskCase.caseId} is current and was safely reused.`
        : `TaskCase ${result.taskCase.caseId} is current. No candidate command has started; use /run when ready.`;
    } catch (error) {
      if (token !== this.#generation) return;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  #sourceInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'b')) return this.#backToHome();
    if (matchesKey(data, 'backspace')) {
      this.#sourceRoot = this.#sourceRoot.slice(0, -1);
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {
      if (!this.#taskCase || !this.#workflow) return { consume: true };
      if (!isAbsolute(this.#sourceRoot.trim())) {
        this.#message = 'Source root must be an absolute path that you explicitly provide.';
        this.#render();
        return { consume: true };
      }
      this.#message = 'Inspecting candidate model and source baseline; no workspace will be created.';
      this.#render();
      void this.#loadPreflight();
      return { consume: true };
    }
    if (/^[^\u0000-\u001f\u007f]+$/.test(data)) {
      this.#sourceRoot += data;
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #preflightInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'b')) { this.#page = 'source'; this.#render(); return { consume: true }; }
    if (matchesKey(data, 'enter') && this.#preflight) {
      this.#page = 'confirm';
      this.#message = 'Review the isolated-run confirmation. The replay begins from the selected directory’s current state.';
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #confirmInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'b')) { this.#page = 'preflight'; this.#render(); return { consume: true }; }
    if (matchesKey(data, 'enter')) {
      this.#message = 'Validating Pi credential, then starting the isolated experiment...';
      this.#render();
      void this.#startExperiment();
      return { consume: true };
    }
    return undefined;
  }

  #runningInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'up')) return this.#moveTimeline(-1);
    if (matchesKey(data, 'down')) return this.#moveTimeline(1);
    if (matchesKey(data, 'pageUp')) return this.#moveTimeline(-10);
    if (matchesKey(data, 'pageDown')) return this.#moveTimeline(10);
    if (matchesKey(data, 'end') || matchesKey(data, 'l')) return this.#followTimeline();
    if (matchesKey(data, 'f')) return this.#cycleTimelineFilter();
    if (matchesKey(data, 'd')) {
      this.#detailExpanded = !this.#detailExpanded;
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'escape')) {
      this.#message = 'An experiment is active. Ctrl+C requests cancellation and waits for the Host terminal state.';
      this.#render();
      return { consume: true };
    }
    return undefined;
  }

  #requestCancellation(): { consume: true } {
    if (this.#cancelling) return { consume: true };
    this.#cancelling = true;
    this.#message = 'Cancellation requested; waiting for runtime stop and workspace cleanup...';
    this.#render();
    void this.#activeExperiment?.cancel().catch((error: unknown) => {
      this.#cancelling = false;
      this.#message = errorMessage(error);
      this.#render(true);
    });
    return { consume: true };
  }

  async #loadPreflight(): Promise<void> {
    const token = this.#beginNavigation();
    try {
      if (!this.#workflow || !this.#taskCase) throw new Error('Experiment workflow is unavailable.');
      this.#preflight = await this.#workflow.preflight({ taskCase: this.#taskCase, sourceRoot: this.#sourceRoot.trim() });
      if (token !== this.#generation) return;
      this.#page = 'preflight';
      this.#message = 'Preflight completed without creating an isolated workspace.';
    } catch (error) {
      if (token !== this.#generation) return;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  async #startExperiment(): Promise<void> {
    this.#beginNavigation();
    try {
      if (!this.#workflow || !this.#taskCase) throw new Error('Experiment workflow is unavailable.');
      this.#timeline = [];
      this.#timelineSelected = 0;
      this.#timelineFilterIndex = 0;
      this.#timelineFollowing = true;
      this.#cancelling = false;
      this.#page = 'running';
      this.#message = 'Validating the configured provider before starting the isolated experiment…';
      this.#render(true);
      const handle = await this.#workflow.start({
        taskCase: this.#taskCase, sourceRoot: this.#sourceRoot.trim(), onEvent: (event) => this.#appendTimeline(event),
      });
      this.#activeExperiment = handle;
      if (this.#cancelling) await handle.cancel();
      this.#message = this.#cancelling
        ? 'Cancellation requested; waiting for runtime stop and workspace cleanup...'
        : 'Candidate is running only in an isolated workspace.';
      this.#render(true);
      const result = await handle.result;
      this.#result = result;
      const experimentRoot = result.experimentRoot ?? dirname(result.reportPath);
      const completedCase = result.taskCase ?? this.#taskCase;
      this.#recentExperiment = {
        experimentId: basename(experimentRoot),
        taskCaseId: completedCase?.caseId ?? 'unknown',
        runId: result.record.attempt.runId,
        outcome: `${result.record.outcome.termination.kind} (${result.record.outcome.termination.code})`,
        startedAt: result.record.attempt.createdAt,
        reportPath: result.reportPath,
        path: experimentRoot,
      };
      this.#activeExperiment = undefined;
      this.#page = 'result';
      this.#message = 'Experiment finished. The report and TUI summary use the same persisted facts.';
    } catch (error) {
      this.#activeExperiment = undefined;
      this.#page = 'error';
      this.#message = errorMessage(error);
    }
    this.#render(true);
  }

  #appendTimeline(event: EventEnvelope): void {
    this.#timeline.push(...projectTimelineEvent(event));
    if (this.#timelineFollowing) this.#timelineSelected = Math.max(0, this.#visibleTimeline().length - 1);
    if (this.#page === 'running') this.#scheduleTimelineRender();
  }

  #scheduleTimelineRender(): void {
    if (this.#timelineRenderQueued) return;
    this.#timelineRenderQueued = true;
    setTimeout(() => {
      this.#timelineRenderQueued = false;
      if (this.#page === 'running') this.#render();
    }, 16);
  }

  #visibleTimeline(): readonly TimelineEntry[] {
    const filter = TIMELINE_FILTERS[this.#timelineFilterIndex] ?? 'ALL';
    return filter === 'ALL' ? this.#timeline : this.#timeline.filter((entry) => entry.source === filter);
  }

  #moveTimeline(amount: number): { consume: true } {
    const entries = this.#visibleTimeline();
    this.#timelineSelected = Math.max(0, Math.min(Math.max(0, entries.length - 1), this.#timelineSelected + amount));
    this.#timelineFollowing = this.#timelineSelected === Math.max(0, entries.length - 1);
    this.#render();
    return { consume: true };
  }

  #followTimeline(): { consume: true } {
    this.#timelineSelected = Math.max(0, this.#visibleTimeline().length - 1);
    this.#timelineFollowing = true;
    this.#message = 'Following latest persisted event.';
    this.#render();
    return { consume: true };
  }

  #cycleTimelineFilter(): { consume: true } {
    this.#timelineFilterIndex = (this.#timelineFilterIndex + 1) % TIMELINE_FILTERS.length;
    return this.#followTimeline();
  }

  #backToHome(): { consume: true } {
    this.#generation += 1;
    this.#configEditing = false;
    this.#configBuffer = '';
    this.#historyDetail = undefined;
    this.#hideHelp();
    this.#hideCommandOverlay();
    this.#page = 'home';
    this.#composer = '';
    this.#showSuggestions = false;
    this.#selected = 0;
    this.#inlineHelp = false;
    this.#searching = false;
    this.#searchQuery = '';
    this.#intakeLevel = 'projects';
    this.#message = 'Back at Home. Use /help for available commands.';
    this.#render();
    return { consume: true };
  }

  #close(): { consume: true } {
    if (this.#closed) return { consume: true };
    this.#generation += 1;
    this.#closed = true;
    this.#hideHelp();
    this.#hideCommandOverlay();
    if (this.#started) this.#tui.stop();
    this.#resolveClosed?.();
    return { consume: true };
  }

  #openIntakeSelection(): { consume: true } {
    if (this.#intakeLevel === 'projects') {
      const project = this.#visibleProjects()[this.#selected];
      if (!project) return { consume: true };
      this.#activeProjectKey = project.key;
      this.#intakeLevel = 'sessions';
      this.#selected = 0;
      this.#searching = false;
      this.#searchQuery = '';
      this.#message = 'Choose a historical session. Discovery did not execute any session content.';
      this.#render();
      return { consume: true };
    }
    const selected = this.#visibleSessions()[this.#selected];
    if (!selected) return { consume: true };
    this.#message = 'Inspecting the selected local JSONL; no commands are executed.';
    this.#render();
    void this.#inspect(selected.sourcePath);
    return { consume: true };
  }

  #syncIntakeLevel(): void {
    const projects = this.#groupedProjects();
    if (projects.length <= 1) {
      this.#intakeLevel = 'sessions';
      this.#activeProjectKey = projects[0]?.key ?? '';
      return;
    }
    if (this.#intakeLevel === 'sessions' && !projects.some((project) => project.key === this.#activeProjectKey)) {
      this.#intakeLevel = 'projects';
      this.#activeProjectKey = projects[0]?.key ?? '';
    }
  }

  #groupedProjects(): SessionProject[] {
    return groupSessionsByProject(this.#filterEligible ? this.#sessions.filter(isEligible) : this.#sessions);
  }

  #visibleProjects(): SessionProject[] {
    return this.#groupedProjects().filter((project) => matchesProjectQuery(project, this.#searchQuery));
  }

  #visibleSessions(): readonly CodexSessionSummary[] {
    const pool = this.#filterEligible ? this.#sessions.filter(isEligible) : this.#sessions;
    const project = this.#groupedProjects().find((item) => item.key === this.#activeProjectKey);
    const scoped = this.#intakeLevel === 'sessions' && project ? project.sessions : pool;
    return scoped.filter((session) => matchesIntakeQuery(session, this.#searchQuery));
  }

  #intakeCount(): number {
    return this.#intakeLevel === 'projects' ? this.#visibleProjects().length : this.#visibleSessions().length;
  }

  #beginNavigation(): number {
    this.#generation += 1;
    return this.#generation;
  }

  #isEditingText(): boolean {
    return this.#configEditing || this.#searching || this.#page === 'source' || (this.#page === 'home' && this.#composer.length > 0);
  }

  #showHelp(): { consume: true } {
    this.#message = HELP_COMMANDS_LINE;
    if (typeof this.#tui.showOverlay === 'function') {
      this.#hideHelp();
      this.#helpOverlay = this.#tui.showOverlay(new HelpOverlay(createTheme(120)));
    } else {
      this.#inlineHelp = true;
    }
    this.#render();
    return { consume: true };
  }

  #hideHelp(): void {
    this.#helpOverlay?.hide();
    this.#helpOverlay = undefined;
    this.#inlineHelp = false;
  }

  #syncCommandOverlay(): void {
    if (!this.#showSuggestions || typeof this.#tui.showOverlay !== 'function') {
      this.#hideCommandOverlay();
      return;
    }
    this.#hideCommandOverlay();
    this.#commandOverlay = this.#tui.showOverlay(commandSelectList(createTheme(80), this.#composer), {
      anchor: 'bottom-left',
      width: 48,
      maxHeight: 8,
      nonCapturing: true,
    });
  }

  #hideCommandOverlay(): void {
    this.#commandOverlay?.hide();
    this.#commandOverlay = undefined;
  }

  #configDirty(): boolean {
    try {
      return JSON.stringify(configForDraft(this.#configDraft)) !== JSON.stringify(this.#modelConfig);
    } catch {
      return true;
    }
  }

  #viewport(): { height?: number } {
    const rows = this.#tui.terminal?.rows;
    return typeof rows === 'number' && rows > 0 ? { height: rows } : {};
  }

  #render(immediate = false): void {
    this.#workbench.invalidate();
    if (immediate) this.#tui.renderNow();
    else this.#tui.requestRender();
  }

  #view(): WorkbenchView {
    const base: WorkbenchView = {
      page: this.#page,
      cwd: process.cwd(),
      ...(this.#hasSavedModelConfig ? { modelId: this.#modelConfig.modelId, effort: this.#modelConfig.effort } : {}),
      hasApiConfig: this.#hasSavedModelConfig,
      hasTaskCase: Boolean(this.#taskCase),
      message: this.#message,
      ...(this.#inlineHelp ? { inlineHelp: true } : {}),
      cancelling: this.#cancelling,
    };
    if (this.#page === 'home') return { ...base, home: { taskCase: this.#taskCase, recentExperiment: this.#recentExperiment, hasApiConfig: this.#hasSavedModelConfig, composer: this.#composer, showSuggestions: this.#showSuggestions && !this.#commandOverlay } };
    if (this.#page === 'config') return { ...base, config: { draft: this.#configDraft, selected: this.#configSelected, editing: this.#configEditing, buffer: this.#configBuffer, dirty: this.#configDirty(), saved: this.#hasSavedModelConfig } };
    if (this.#page === 'history') return { ...base, history: { tab: this.#historyTab, items: this.#historyItems(), selected: this.#historySelected } };
    if (this.#page === 'history-detail' && this.#historyDetail) return { ...base, historyDetail: this.#historyDetail };
    if (this.#page === 'sessions') {
      const projects = this.#intakeLevel === 'projects' ? this.#visibleProjects() : this.#visibleProjects().filter((project) => project.key === this.#activeProjectKey);
      return {
        ...base,
        sessions: {
          level: this.#intakeLevel,
          projects: this.#intakeLevel === 'projects' ? this.#visibleProjects() : projects,
          sessions: this.#visibleSessions(),
          selected: this.#selected,
          filterEligible: this.#filterEligible,
          query: this.#searchQuery,
          searching: this.#searching,
        },
      };
    }
    if (this.#page === 'inspection' && this.#inspection) {
      return {
        ...base,
        inspection: {
          inspection: this.#inspection,
          privacy: this.#privacy,
          selectedTaskInput: this.#inspectionTaskInput,
          showOutcome: this.#inspectionShowOutcome,
        },
      };
    }
    if (this.#page === 'source') return { ...base, source: { sourceRoot: this.#sourceRoot, step: 1 } };
    if (this.#page === 'preflight' && this.#preflight) return { ...base, preflight: { preflight: this.#preflight, candidate: this.#workflow?.candidate, step: 2 } };
    if (this.#page === 'confirm' && this.#preflight) {
      return {
        ...base,
        confirm: {
          preflight: this.#preflight,
          candidate: this.#workflow?.candidate,
          sourceRoot: this.#sourceRoot,
          effort: this.#modelConfig.effort,
          harnessModel: this.#modelConfig.modelId,
          step: 3,
        },
      };
    }
    if (this.#page === 'running') {
      const entries = this.#visibleTimeline();
      const policy = this.#workflow?.policy;
      return { ...base, running: { entries, selected: this.#timelineSelected, filter: TIMELINE_FILTERS[this.#timelineFilterIndex] ?? 'ALL', following: this.#timelineFollowing, cancelling: this.#cancelling, currentState: currentRunState(this.#timeline), elapsed: elapsedFrom(this.#timeline), turns: { used: countTurns(this.#timeline), ...(policy ? { max: policy.maxTargetTurns } : {}) }, calls: { used: countCalls(this.#timeline), ...(policy ? { max: policy.maxModelCalls } : {}) }, detailExpanded: this.#detailExpanded, ...(policy ? { policy } : {}) } };
    }
    if (this.#page === 'result' && this.#result) return { ...base, result: this.#result };
    return base;
  }
}

function historicalCwd(taskCase: TaskCase | undefined): string | undefined {
  const cwd = taskCase?.taskContext?.historicalCwd;
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined;
}
