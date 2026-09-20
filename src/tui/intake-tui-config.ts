import { Loader, isViewportTUI } from "@earendil-works/pi-tui";
import {
  configForDraft,
  draftForConfig,
  emptyHarnessConfigDraft,
  saveHarnessModelConfig,
  safeConfigError,
  shellEnvAssignment,
  tryEnvironmentName,
  type HarnessConfigDraft,
  type HarnessModelConfig,
} from "../infrastructure/harness-model-config.js";
import { PiModelCaller } from "../infrastructure/agent/model-caller.js";
import { CONFIG_FIELDS, type ConfigConnectionTestStatus } from "./pages/config.js";
import { handleConfigInput } from "./config-input.js";
import { credentialGapMessage, harnessCaller } from "./controller-auth.js";
import { t, type Locale } from "./i18n.js";
import type { Option } from "./types.js";
import type { WorkbenchView } from "./workbench.js";

type ConfigDraft = HarnessConfigDraft;

export type ConfigReturnTarget = {
  readonly page: "home" | "inspection";
  readonly inspectionTaskInput?: number;
  readonly inspectionShowOutcome?: boolean;
};

/** Config helpers may only touch draft, save/test, and operator feedback. */
export type ConfigPanel = {
  configDraft: HarnessConfigDraft;
  configSelected: number;
  configEditing: boolean;
  configBuffer: string;
  configCursor: number;
  configPendingToggle: boolean;
  configLeaveConfirm: boolean;
  configBusy: boolean;
  configBusyKind: "idle" | "save" | "test";
  configDraftVersion: number;
  configTestDraftVersion: number | undefined;
  configTestStatus: ConfigConnectionTestStatus;
  configTestDetail: string | undefined;
  configReturnTarget: ConfigReturnTarget | undefined;
  providers: readonly Option[];
  models: readonly Option[];
  piModels: ConstructorParameters<typeof PiModelCaller>[1];
  modelConfig: HarnessModelConfig;
  hasSavedModelConfig: boolean;
  dataDir: string;
  locale: Locale;
  message: string;
  page: WorkbenchView["page"];
  generation: number;
  harnessAuthOk: boolean;
  inspection: unknown;
  inspectionTaskInput: number;
  inspectionShowOutcome: boolean;
  dirtyCache: { draft: HarnessConfigDraft; config: HarnessModelConfig; dirty: boolean } | undefined;
  tui: import("@earendil-works/pi-tui").TUI;
  configDirty(): boolean;
  modelsForDraft(draft: HarnessConfigDraft): { draft: HarnessConfigDraft; models: readonly Option[] };
  saveConfig(): Promise<void>;
  testConfigConnection(): Promise<void>;
  refreshHarnessAuth(): Promise<void>;
  loadHome(initialMessage?: string): Promise<void>;
  leaveConfig(): { consume: true };
  setLocale(command: string): Promise<void>;
  beginNavigation(): number;
  render(force?: boolean): void;
};

export function IntakeTui_configPageInput(this: ConfigPanel, data: string): { consume: true } | undefined {
    const previousDraft = this.configDraft;
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
        dirty: this.configDirty(),
        leaveConfirm: this.configLeaveConfirm,
        busy: this.configBusy,
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
    this.configLeaveConfirm = Boolean(result.state.leaveConfirm);
    this.models = result.state.models;
    if (result.state.draft !== previousDraft) noteDraftChanged.call(this);
    if (result.message) this.message = result.message;
    if (result.action === "save") void this.saveConfig();
    else if (result.action === "test") void this.testConfigConnection();
    else if (result.action === "home") return this.leaveConfig();
    else if (result.action === "toggle-locale") {
      void this.setLocale("/lang");
      return { consume: true };
    } else this.render();
    return { consume: true };
  }

function noteDraftChanged(this: ConfigPanel): void {
  this.configDraftVersion += 1;
  this.dirtyCache = undefined;
  if (this.configTestStatus === "passed" || this.configTestStatus === "failed") {
    this.configTestStatus = "stale";
    this.configTestDetail = undefined;
  }
}

export function IntakeTui_modelsForDraft(this: ConfigPanel, draft: ConfigDraft): {
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

export async function IntakeTui_openConfig(this: ConfigPanel): Promise<void> {
    const token = this.beginNavigation();
    this.configReturnTarget = captureReturnTarget(this);
    this.configDraft = this.hasSavedModelConfig
      ? draftForConfig(this.modelConfig)
      : emptyHarnessConfigDraft();
    this.configDraftVersion += 1;
    this.configSelected =
      this.configDraft.kind === "openai-compatible"
        ? Math.max(0, CONFIG_FIELDS.indexOf("model"))
        : 0;
    this.configEditing = false;
    this.configBuffer = "";
    this.configCursor = 0;
    this.configPendingToggle = false;
    this.configLeaveConfirm = false;
    this.configTestStatus = "idle";
    this.configTestDetail = undefined;
    this.configTestDraftVersion = undefined;
    this.configBusyKind = "idle";
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

function captureReturnTarget(panel: ConfigPanel): ConfigReturnTarget {
  if (panel.page === "inspection") {
    return {
      page: "inspection",
      inspectionTaskInput: panel.inspectionTaskInput,
      inspectionShowOutcome: panel.inspectionShowOutcome,
    };
  }
  return { page: "home" };
}

export function IntakeTui_leaveConfig(this: ConfigPanel): { consume: true } {
    const testing = this.configBusy && this.configBusyKind === "test";
    // Invalidate in-flight save/test results without claiming the request was cancelled.
    this.beginNavigation();
    this.configEditing = false;
    this.configBuffer = "";
    this.configCursor = 0;
    this.configPendingToggle = false;
    this.configLeaveConfirm = false;
    this.configDraft = this.hasSavedModelConfig
      ? draftForConfig(this.modelConfig)
      : emptyHarnessConfigDraft();
    this.configDraftVersion += 1;
    this.configTestStatus = "idle";
    this.configTestDetail = undefined;
    this.configTestDraftVersion = undefined;
    this.configBusyKind = "idle";
    const target = this.configReturnTarget;
    this.configReturnTarget = undefined;
    const backgroundNote = testing
      ? t(this.locale, "configTestBackgroundPending")
      : undefined;
    if (applyConfigReturnTarget.call(this, target, {
      inspectionMessage: backgroundNote ?? t(this.locale, "reviewSession"),
      staleMessage: backgroundNote
        ? `${backgroundNote} ${t(this.locale, "configReturnStale")}`
        : t(this.locale, "configReturnStale"),
    })) {
      this.render(true);
      return { consume: true };
    }
    void this.loadHome(backgroundNote);
    return { consume: true };
  }

export async function IntakeTui_saveConfig(this: ConfigPanel): Promise<void> {
    if (this.configBusy) return;
    this.configBusy = true;
    this.configBusyKind = "save";
    const token = this.beginNavigation();
    try {
      const config = configForDraft(this.configDraft);
      await saveHarnessModelConfig(this.dataDir, config);
      if (token !== this.generation) return;
      this.modelConfig = config;
      this.hasSavedModelConfig = true;
      // Saving never marks the connection as verified.
      this.configTestStatus = "idle";
      this.configTestDetail = undefined;
      this.configTestDraftVersion = undefined;
      await this.refreshHarnessAuth();
      if (token !== this.generation) return;
      await restoreAfterSave.call(this);
    } catch (error) {
      if (token !== this.generation) return;
      this.page = "config";
      this.message = safeConfigError(error);
    } finally {
      this.configBusy = false;
      this.configBusyKind = "idle";
    }
    this.render(true);
  }

async function restoreAfterSave(this: ConfigPanel): Promise<void> {
  const target = this.configReturnTarget;
  this.configReturnTarget = undefined;
  const savedOk = this.harnessAuthOk
    ? t(this.locale, "configSavedReturn")
    : `${t(this.locale, "configSavedReturn")} ${credentialGapMessage(this.configDraft) ?? "Harness has no usable credential."}`;
  if (applyConfigReturnTarget.call(this, target, {
    inspectionMessage: savedOk,
    staleMessage: t(this.locale, "configSavedReturnStale"),
  })) {
    return;
  }
  await this.loadHome(
    this.harnessAuthOk
      ? t(this.locale, "configSavedIntake")
      : `Configuration saved locally. ${credentialGapMessage(this.configDraft) ?? "Harness has no usable credential."}`,
  );
}

/** Restore inspection focus when possible; otherwise climb to sessions. Returns true if handled. */
function applyConfigReturnTarget(
  this: ConfigPanel,
  target: ConfigReturnTarget | undefined,
  messages: { readonly inspectionMessage: string; readonly staleMessage: string },
): boolean {
  if (target?.page !== "inspection") return false;
  if (this.inspection) {
    this.page = "inspection";
    if (target.inspectionTaskInput !== undefined) {
      this.inspectionTaskInput = target.inspectionTaskInput;
    }
    if (target.inspectionShowOutcome !== undefined) {
      this.inspectionShowOutcome = target.inspectionShowOutcome;
    }
    this.message = messages.inspectionMessage;
    return true;
  }
  this.page = "sessions";
  this.message = messages.staleMessage;
  return true;
}

export async function IntakeTui_testConfigConnection(this: ConfigPanel): Promise<void> {
    if (this.configBusy) return;
    const unset = credentialGapMessage(this.configDraft);
    if (unset) {
      this.message = unset;
      this.configTestStatus = "failed";
      this.configTestDetail = unset;
      this.page = "config";
      this.render(true);
      return;
    }
    this.configBusy = true;
    this.configBusyKind = "test";
    const draftVersion = this.configDraftVersion;
    this.configTestDraftVersion = draftVersion;
    this.configTestStatus = "testing";
    this.configTestDetail = undefined;
    const token = this.beginNavigation();
    const loaderText = t(this.locale, "testingConnection");
    const loader = isViewportTUI(this.tui)
      ? new Loader(
          this.tui,
          (text) => text,
          (text) => text,
          loaderText,
        )
      : undefined;
    const overlay = loader ? this.tui.showOverlay(loader) : undefined;
    loader?.start();
    let outcome: "passed" | "failed";
    let detail: string;
    try {
      const config = configForDraft(this.configDraft);
      this.message = loaderText;
      this.render();
      const caller = harnessCaller(config, this.piModels);
      const validation = await caller.validate();
      const source = validation.source
        ? t(this.locale, "configTestPassedSource", { source: validation.source })
        : "";
      detail = t(this.locale, "configTestPassed", { source });
      outcome = "passed";
    } catch (error) {
      detail =
        credentialGapMessage(this.configDraft) ?? safeConfigError(error);
      outcome = "failed";
    } finally {
      loader?.stop();
      overlay?.hide();
      this.configBusy = false;
      this.configBusyKind = "idle";
    }
    // A provider round trip outlives the keypress; by now the operator may have navigated elsewhere.
    if (token !== this.generation) return;
    if (draftVersion !== this.configDraftVersion) {
      this.configTestStatus = "stale";
      this.configTestDetail = undefined;
      this.message = t(this.locale, "configTestDraftChanged");
      this.page = "config";
      this.render(true);
      return;
    }
    this.configTestStatus = outcome;
    this.configTestDetail = outcome === "failed" ? detail : undefined;
    this.message = detail;
    this.page = "config";
    this.render(true);
  }

export async function IntakeTui_refreshHarnessAuth(this: ConfigPanel): Promise<void> {
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
      // hasAuth probes local credential material only; treat probe failures as "no usable auth".
      this.harnessAuthOk = false;
    }
  }

export function IntakeTui_configDirty(this: ConfigPanel): boolean {
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
