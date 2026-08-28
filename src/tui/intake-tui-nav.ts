import type { CodexIntakeTui } from "./intake-tui.js";
import { draftForConfig } from "../infrastructure/harness-model-config.js";
import { operatorErrorMessage, TIMELINE_FILTERS } from "./format.js";
import { HelpOverlay, commandSelectList } from "./overlays.js";
import { handleControllerInput } from "./controller-input.js";
import { productContext as activeProductContext, view as projectView } from "./controller-view.js";
import { discardRecovery, stopRunClock } from "./controller-run.js";
import { nextLocale, parseLocale, sessionReplayErrorMessage, t } from "./i18n.js";
import { saveTuiPreferences } from "./preferences.js";
import { matchesCanvasQuery, matchesFilter } from "./scrollback.js";
import { createTheme } from "./theme.js";
import { type TimelineEntry } from "./timeline.js";
import { type WorkbenchView } from "./workbench.js";
type Page = import("./workbench.js").WorkbenchView["page"];

export function CodexIntakeTui_handleInput(this: CodexIntakeTui, data: string): { consume: true } | undefined {
    return handleControllerInput(this, data);
  }

export function CodexIntakeTui_setHomeMessage(this: CodexIntakeTui, message: string): { consume: true } {
    this.message = message;
    this.render();
    return { consume: true };
  }

export function CodexIntakeTui_move(this: CodexIntakeTui, amount: number): { consume: true } {
    const count = this.intakeCount();
    this.selected = Math.max(
      0,
      Math.min(Math.max(0, count - 1), this.selected + amount),
    );
    this.render();
    return { consume: true };
  }

export function CodexIntakeTui_scheduleTimelineRender(this: CodexIntakeTui): void {
    if (this.timelineRenderQueued) return;
    this.timelineRenderQueued = true;
    this.queueTimelineRender(() => {
      this.timelineRenderQueued = false;
      if (this.page === "running") this.render();
    });
  }

export function CodexIntakeTui_visibleTimeline(this: CodexIntakeTui): readonly TimelineEntry[] {
    const filter = TIMELINE_FILTERS[this.timelineFilterIndex] ?? "ALL";
    return this.timeline.filter(
      (entry) =>
        matchesFilter(entry, filter) &&
        matchesCanvasQuery(entry, this.findQuery),
    );
  }

export async function CodexIntakeTui_setLocale(this: CodexIntakeTui, typed: string): Promise<void> {
    const argument = typed.replace(/^\/lang\s*/, "").trim();
    this.locale = parseLocale(argument) ?? nextLocale(this.locale);
    this.setHomeMessage(t(this.locale, "langNow"));
    try {
      await saveTuiPreferences(this.dataDir, { locale: this.locale });
    } catch {
      /* in-memory locale already applied; a locked preferences file must not abort the switch */
    }
  }

export function CodexIntakeTui_showError(this: CodexIntakeTui, error: unknown, returnPage: Exclude<Page, "error" | "running" | "loading">): void {
    this.preparePhase = undefined;
    this.prepareDetail = undefined;
    stopRunClock(this);
    this.errorReturnPage = returnPage;
    this.page = "error";
    this.message = sessionReplayErrorMessage(error, this.locale) ?? operatorErrorMessage(error);
  }

export function CodexIntakeTui_returnFromError(this: CodexIntakeTui): { consume: true } {
    this.page = this.errorReturnPage;
    this.message = t(this.locale, "returnedPrevious");
    this.render();
    return { consume: true };
  }

export function CodexIntakeTui_backToHome(this: CodexIntakeTui): { consume: true } {
    void discardRecovery(this);
    this.discoveryAbort?.abort();
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

export function CodexIntakeTui_close(this: CodexIntakeTui): { consume: true } {
    if (this.closed) return { consume: true };
    this.discoveryAbort?.abort();
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

export function CodexIntakeTui_beginNavigation(this: CodexIntakeTui): number {
    this.generation += 1;
    return this.generation;
  }

export function CodexIntakeTui_isEditingText(this: CodexIntakeTui): boolean {
    return (
      this.configEditing ||
      this.searching ||
      this.finding ||
      this.page === "source" ||
      (this.page === "home" && this.composer.length > 0)
    );
  }

export function CodexIntakeTui_showHelp(this: CodexIntakeTui): { consume: true } {
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

export function CodexIntakeTui_hideHelp(this: CodexIntakeTui): void {
    this.helpOverlay?.hide();
    this.helpOverlay = undefined;
    this.inlineHelp = false;
  }

export function CodexIntakeTui_syncCommandOverlay(this: CodexIntakeTui): void {
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

export function CodexIntakeTui_hideCommandOverlay(this: CodexIntakeTui): void {
    this.commandOverlay?.hide();
    this.commandOverlay = undefined;
    this.commandSelectList = undefined;
  }

export function CodexIntakeTui_muteNodeWarnings(this: CodexIntakeTui): void {
    if (this.emitWarning) return;
    this.emitWarning = process.emitWarning.bind(process);
    process.emitWarning = () => undefined;
  }

export function CodexIntakeTui_restoreNodeWarnings(this: CodexIntakeTui): void {
    if (!this.emitWarning) return;
    process.emitWarning = this.emitWarning;
    this.emitWarning = undefined;
  }

export function CodexIntakeTui_viewport(this: CodexIntakeTui): { height?: number } {
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? { height: rows } : {};
  }

export function CodexIntakeTui_render(this: CodexIntakeTui, immediate = false): void {
    this.workbench.invalidate();
    if (immediate) this.tui.renderNow();
    else this.tui.requestRender();
  }

export function CodexIntakeTui_productContext(this: CodexIntakeTui): { productLabel?: string; productConfigured?: boolean } {
    return activeProductContext(this);
  }

export function CodexIntakeTui_view(this: CodexIntakeTui): WorkbenchView {
    return projectView(this);
  }
