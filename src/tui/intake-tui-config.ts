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
import type { ConfigSession } from './config-session.js';
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
  readonly configSession: ConfigSession;
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
    const result = this.configSession.dispatch(data, {
      providers: this.providers, models: this.models, savedConfig: this.modelConfig, locale: this.locale,
    }, (draft) => this.modelsForDraft(draft));
    if (!result) return undefined;
    this.models = result.models;
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
    this.configSession.reset(this.hasSavedModelConfig
        ? draftForConfig(this.modelConfig)
        : emptyHarnessConfigDraft());
    this.providers = new PiModelCaller(
      this.modelConfig,
      this.piModels,
    ).providers();
    if (token !== this.generation) return;
    if (this.configSession.state.draft.kind === "pi-catalog") {
      const provider =
        this.providers.find(
          (item) => item.id === this.configSession.state.draft.providerId,
        ) ?? this.providers[0];
      if (provider)
        this.configSession.replaceDraft({ ...this.configSession.state.draft, providerId: provider.id });
      const refreshed = this.modelsForDraft(this.configSession.state.draft);
      this.configSession.replaceDraft(refreshed.draft);
      this.models = refreshed.models;
    }
    this.page = "config";
    const envName = tryEnvironmentName(this.configSession.state.draft.keyRef);
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
    const testing = this.configSession.state.busy === "test";
    // Invalidate in-flight save/test results without claiming the request was cancelled.
    this.beginNavigation();
    this.configSession.reset(this.hasSavedModelConfig
        ? draftForConfig(this.modelConfig)
        : emptyHarnessConfigDraft());
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
    const ticket = this.configSession.beginRequest('save');
    if (!ticket) return;
    const token = this.beginNavigation();
    try {
      const config = configForDraft(this.configSession.state.draft);
      await saveHarnessModelConfig(this.dataDir, config);
      if (token !== this.generation) return;
      this.modelConfig = config;
      this.hasSavedModelConfig = true;
      // Saving never marks the connection as verified.
      this.configSession.clearTest();
      await this.refreshHarnessAuth();
      if (token !== this.generation) return;
      await restoreAfterSave.call(this);
    } catch (error) {
      if (token !== this.generation) return;
      this.page = "config";
      this.message = safeConfigError(error);
    } finally {
      // Only the owning generation may drop the gate — an abandoned save must not clear a newer request.
      if (token === this.generation) this.configSession.finishRequest(ticket);
    }
    this.render(true);
  }

async function restoreAfterSave(this: ConfigPanel): Promise<void> {
  const target = this.configReturnTarget;
  this.configReturnTarget = undefined;
  const savedOk = this.harnessAuthOk
    ? t(this.locale, "configSavedReturn")
    : `${t(this.locale, "configSavedReturn")} ${credentialGapMessage(this.configSession.state.draft) ?? "Harness has no usable credential."}`;
  if (applyConfigReturnTarget.call(this, target, {
    inspectionMessage: savedOk,
    staleMessage: t(this.locale, "configSavedReturnStale"),
  })) {
    return;
  }
  await this.loadHome(
    this.harnessAuthOk
      ? t(this.locale, "configSavedIntake")
      : `Configuration saved locally. ${credentialGapMessage(this.configSession.state.draft) ?? "Harness has no usable credential."}`,
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
    if (this.configSession.state.busy !== "idle") return;
    const unset = credentialGapMessage(this.configSession.state.draft);
    if (unset) {
      // Credential axis only — do not mark the connection-test axis as failed.
      this.message = unset;
      this.page = "config";
      this.render(true);
      return;
    }
    const ticket = this.configSession.beginRequest('test');
    if (!ticket) return;
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
      const config = configForDraft(this.configSession.state.draft);
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
        credentialGapMessage(this.configSession.state.draft) ?? safeConfigError(error);
      outcome = "failed";
    } finally {
      loader?.stop();
      overlay?.hide();
      // Only the owning generation may drop the gate — an abandoned probe must not clear a newer request.
      if (token === this.generation) this.configSession.finishRequest(ticket);
    }
    // A provider round trip outlives the keypress; by now the operator may have navigated elsewhere.
    if (token !== this.generation) return;
    const status = this.configSession.completeTest(ticket, outcome, detail);
    if (status === 'ignored') return;
    if (status === 'stale') {
      this.message = t(this.locale, "configTestDraftChanged");
      this.page = "config";
      this.render(true);
      return;
    }
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
  return this.configSession.dirty(this.modelConfig);
}
