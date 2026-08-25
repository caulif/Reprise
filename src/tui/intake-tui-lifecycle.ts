import type { CodexIntakeTui } from "./intake-tui.js";
import { dirname } from "node:path";
import { draftForConfig, readHarnessModelConfig, safeConfigError } from "../infrastructure/harness-model-config.js";
import { errorMessage } from "./format.js";
import { t } from "./i18n.js";
import { readTuiPreferences } from "./preferences.js";
import { enableTerminalColor } from "./theme.js";
import { mountWorkbench } from "./workbench.js";
import {
  openAllowedFileUrl,
  openAllowedLocalPath,
  openExperimentReport,
  openExperimentTrace,
} from "./open-report.js";

export async function CodexIntakeTui_start(this: CodexIntakeTui): Promise<void> {
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
    void this.refreshProductAuth();
    this.locale = (await readTuiPreferences(this.dataDir)).locale;
    await this.loadHome(configurationIssue);
    this.render(true);
  }

export async function CodexIntakeTui_run(this: CodexIntakeTui): Promise<void> {
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

export function CodexIntakeTui_preview(this: CodexIntakeTui, width = 120): string {
    return this.workbench.render(width).join("\n");
  }

export function CodexIntakeTui_openReport(this: CodexIntakeTui, experimentRoot: string | undefined, reportPath: string | undefined): { consume: true } {
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

export function CodexIntakeTui_openTrace(this: CodexIntakeTui): { consume: true } {
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

export function CodexIntakeTui_openLocal(this: CodexIntakeTui, target: string | undefined): { consume: true } {
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

export function CodexIntakeTui_openFileUrl(this: CodexIntakeTui, url: string): void {
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
