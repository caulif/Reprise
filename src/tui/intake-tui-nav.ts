import type { IntakeTui } from "./intake-tui.js";
import { importPacks } from "../products/pack-access.js";
import { draftForConfig, emptyHarnessConfigDraft } from "../infrastructure/harness-model-config.js";
import { classifyAgentFailure } from '../infrastructure/agent/failure.js';
import { operatorErrorMessage, TIMELINE_FILTERS } from "./format.js";
import { HelpOverlay, commandSelectList } from "./overlays.js";
import { handleControllerInput } from "./controller-input.js";
import { productContext as activeProductContext, view as projectView } from "./controller-view.js";
import { discardRecovery, stopRunClock } from "./controller-run.js";
import { formatHarnessFailure, nextLocale, parseLocale, sessionReplayErrorMessage, t } from "./i18n.js";
import { saveTuiPreferences } from "./preferences.js";
import { matchesFilter } from "./scrollback.js";
import { mouseReportingSequence } from "./terminal-guard.js";
import { createTheme } from "./theme.js";
import { type TimelineEntry } from "./timeline.js";
import { type WorkbenchView } from "./workbench.js";
type Page = import("./workbench.js").WorkbenchView["page"];

export function IntakeTui_handleInput(this: IntakeTui, data: string): { consume: true } | undefined {
    return handleControllerInput(this, data);
  }

export function IntakeTui_setHomeMessage(this: IntakeTui, message: string): { consume: true } {
    this.message = message;
    this.render();
    return { consume: true };
  }

export function IntakeTui_move(this: IntakeTui, amount: number): { consume: true } {
    const count = this.intakeCount();
    this.selected = Math.max(
      0,
      Math.min(Math.max(0, count - 1), this.selected + amount),
    );
    if (this.page === "sessions" && this.intakeLevel === "products") {
      const productId = importPacks(this.packs)[this.selected]?.manifest.productId;
      if (productId) this.lastProductId = productId;
    }
    this.render();
    return { consume: true };
  }

export function IntakeTui_scheduleTimelineRender(this: IntakeTui): void {
    if (this.readingMode) return;
    if (this.timelineRenderQueued) return;
    this.timelineRenderQueued = true;
    this.queueTimelineRender(() => {
      this.timelineRenderQueued = false;
      if (this.readingMode) return;
      if (this.page === "running") this.render();
    });
  }

export function IntakeTui_visibleTimeline(this: IntakeTui): readonly TimelineEntry[] {
    const filter = TIMELINE_FILTERS[this.timelineFilterIndex] ?? "ALL";
    return this.timeline.filter((entry) => matchesFilter(entry, filter));
  }

export async function IntakeTui_setLocale(this: IntakeTui, typed: string): Promise<void> {
    const argument = typed.replace(/^\/lang\s*/, "").trim();
    this.locale = parseLocale(argument) ?? nextLocale(this.locale);
    this.setHomeMessage(t(this.locale, "langNow"));
    try {
      await saveTuiPreferences(this.dataDir, { locale: this.locale });
    } catch {
      /* in-memory locale already applied; a locked preferences file must not abort the switch */
    }
  }

export function IntakeTui_showError(this: IntakeTui, error: unknown, returnPage: Exclude<Page, "error" | "running" | "loading">): void {
    this.preparePhase = undefined;
    this.prepareDetail = undefined;
    this.runPhase = undefined;
    this.lastRuntimeEventAt = undefined;
    this.lastRuntimeEventKind = undefined;
    this.modelOutputSeen = false;
    this.reconnectCount = 0;
    this.reconnectTotal = 0;
    stopRunClock(this);
    this.errorReturnPage = returnPage;
    this.page = "error";
    this.message = error instanceof Error && error.name === 'HarnessProbeError'
      ? formatHarnessFailure(this.locale, 'probe', classifyAgentFailure(error.cause))
      : sessionReplayErrorMessage(error, this.locale) ?? operatorErrorMessage(error);
  }

export function IntakeTui_returnFromError(this: IntakeTui): { consume: true } {
    this.page = this.errorReturnPage;
    this.message = t(this.locale, "returnedPrevious");
    this.render();
    return { consume: true };
  }

export function IntakeTui_backToHome(this: IntakeTui): { consume: true } {
    this.startupAbort?.abort();
    void discardRecovery(this).catch((error: unknown) => { this.showError(error, 'home'); this.render(true); });
    this.discoveryAbort?.abort();
    this.recoveryAbort?.abort();
    this.generation += 1;
    this.configEditing = false;
    this.configBuffer = "";
    this.configCursor = 0;
    this.configDraft = this.hasSavedModelConfig ? draftForConfig(this.modelConfig) : emptyHarnessConfigDraft();
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
    this.readingMode = false;
    this.intakeLevel = "projects";
    this.preparePhase = undefined;
    this.prepareDetail = undefined;
    this.detailExpanded = false;
    this.message = t(this.locale, "backAtHome");
    this.render();
    return { consume: true };
  }

export function IntakeTui_close(this: IntakeTui): { consume: true } {
    if (this.closed) return { consume: true };
    this.startupAbort?.abort();
    this.discoveryAbort?.abort();
    this.recoveryAbort?.abort();
    this.generation += 1;
    this.closed = true;
    this.compareChoice?.resolve(false);
    this.compareChoice = undefined;
    stopRunClock(this);
    this.hideHelp();
    this.hideCommandOverlay();
    // An experiment that started but never reached the running page would otherwise outlive the TUI.
    const experiment = this.activeExperiment;
    this.activeExperiment = undefined;
    const pending: Promise<unknown>[] = [this.closing];
    if (this.workflowFinished) pending.push(this.workflowFinished);
    if (experiment) {
      if (!this.cancelling) pending.push(experiment.cancel());
      pending.push(experiment.result.then((result) => {
        if (result.record.outcome.cleanup.status !== 'complete') throw new Error(t(this.locale, 'cleanupFailed'));
      }));
    }
    if (this.recoveryFinished) pending.push(this.recoveryFinished);
    this.closing = (async () => {
      const settled = await Promise.allSettled(pending);
      const discarded = await Promise.allSettled([discardRecovery(this)]);
      if ([...settled, ...discarded].some((result) => result.status === 'rejected')) throw new Error(t(this.locale, 'cleanupFailed'));
    })();
    // run() observes the original rejection; this handler also covers callers that only use start()/close().
    void this.closing.catch(() => { this.message = t(this.locale, 'cleanupFailed'); });
    this.terminalGuard?.();
    this.terminalGuard = undefined;
    if (this.started) this.tui.stop();
    this.resolveClosed?.();
    return { consume: true };
  }

export function IntakeTui_beginNavigation(this: IntakeTui): number {
    this.generation += 1;
    return this.generation;
  }

export function IntakeTui_isEditingText(this: IntakeTui): boolean {
    return (
      this.configEditing ||
      this.searching ||
      this.finding ||
      this.page === "source" ||
      (this.page === "home" && this.composer.length > 0)
    );
  }

export function IntakeTui_showHelp(this: IntakeTui): { consume: true } {
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

export function IntakeTui_hideHelp(this: IntakeTui): void {
    this.helpOverlay?.hide();
    this.helpOverlay = undefined;
    this.inlineHelp = false;
  }

export function IntakeTui_syncCommandOverlay(this: IntakeTui): void {
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

export function IntakeTui_hideCommandOverlay(this: IntakeTui): void {
    this.commandOverlay?.hide();
    this.commandOverlay = undefined;
    this.commandSelectList = undefined;
  }

export function IntakeTui_muteNodeWarnings(this: IntakeTui): void {
    if (this.emitWarning) return;
    this.emitWarning = process.emitWarning.bind(process);
    process.emitWarning = () => undefined;
  }

export function IntakeTui_restoreNodeWarnings(this: IntakeTui): void {
    if (!this.emitWarning) return;
    process.emitWarning = this.emitWarning;
    this.emitWarning = undefined;
  }

export function IntakeTui_viewport(this: IntakeTui): { height?: number } {
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? { height: rows } : {};
  }

export function IntakeTui_setMouseReporting(this: IntakeTui, enabled: boolean): void {
    const terminal = this.tui as { terminal?: { write?: (data: string) => void } };
    terminal.terminal?.write?.(mouseReportingSequence(enabled));
  }

export function IntakeTui_render(this: IntakeTui, immediate = false): void {
    if (this.readingMode && !immediate) return;
    this.workbench.invalidate();
    if (immediate) this.tui.renderNow();
    else this.tui.requestRender();
  }

export function IntakeTui_productContext(this: IntakeTui): { productLabel?: string; productConfigured?: boolean } {
    return activeProductContext(this);
  }

export function IntakeTui_view(this: IntakeTui): WorkbenchView {
    return projectView(this);
  }
