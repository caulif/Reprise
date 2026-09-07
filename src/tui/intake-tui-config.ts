import type { CodexIntakeTui } from "./intake-tui.js";
import { Loader, isViewportTUI } from "@earendil-works/pi-tui";
import {
  configForDraft,
  draftForConfig,
  emptyHarnessConfigDraft,
  saveHarnessModelConfig,
  safeConfigError,
  shellEnvAssignment,
  tryEnvironmentName,
} from "../infrastructure/harness-model-config.js";
import { PiModelCaller } from "../infrastructure/pi-model-caller.js";
import { CONFIG_FIELDS } from "./pages/config.js";
import { handleConfigInput } from "./config-input.js";
import { credentialGapMessage, harnessCaller } from "./controller-auth.js";
import { t } from "./i18n.js";
type ConfigDraft = import("../infrastructure/harness-model-config.js").HarnessConfigDraft;
type Option = import("./types.js").Option;

export function CodexIntakeTui_configPageInput(this: CodexIntakeTui, data: string): { consume: true } | undefined {
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

export function CodexIntakeTui_modelsForDraft(this: CodexIntakeTui, draft: ConfigDraft): {
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

export async function CodexIntakeTui_openConfig(this: CodexIntakeTui): Promise<void> {
    const token = this.beginNavigation();
    this.configDraft = this.hasSavedModelConfig
      ? draftForConfig(this.modelConfig)
      : emptyHarnessConfigDraft();
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

export async function CodexIntakeTui_saveConfig(this: CodexIntakeTui): Promise<void> {
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

export async function CodexIntakeTui_testConfigConnection(this: CodexIntakeTui): Promise<void> {
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

export async function CodexIntakeTui_refreshHarnessAuth(this: CodexIntakeTui): Promise<void> {
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

export function CodexIntakeTui_configDirty(this: CodexIntakeTui): boolean {
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
