import { readExperimentEvents } from "../application/experiment-event-read.js";
import { readLocalHistory, type HistoryCase, type HistoryExperiment } from "./local-history.js";
import { handleHistoryInput } from "./history-input.js";
import { t, type Locale } from "./i18n.js";
import { projectPersistedTimeline, type TimelineEntry } from "./timeline.js";
import type { WorkbenchView } from "./workbench.js";

type ReturnPage = Exclude<WorkbenchView["page"], "error" | "running" | "loading">;

/** History helpers may only touch saved history, timeline projection, and page navigation. */
export type HistoryPanel = {
  dataDir: string;
  locale: Locale;
  generation: number;
  page: WorkbenchView["page"];
  message: string;
  historyTab: "runs" | "cases";
  historySelected: number;
  historyCases: readonly HistoryCase[];
  historyExperiments: readonly HistoryExperiment[];
  historyTotalBytes: number;
  historyDetail: HistoryCase | HistoryExperiment | undefined;
  recentExperiment: HistoryExperiment | undefined;
  timeline: TimelineEntry[];
  timelineSelected: number;
  timelineFollowing: boolean;
  historyItems(): readonly (HistoryCase | HistoryExperiment)[];
  beginNavigation(): number;
  render(force?: boolean): void;
  showError(error: unknown, returnPage: ReturnPage): void;
  visibleTimeline(): readonly TimelineEntry[];
};

export function IntakeTui_openRecentExperiment(this: HistoryPanel): { consume: true } {
  const recent = this.recentExperiment;
  if (!recent) {
    void IntakeTui_loadHistory.call(this);
    return { consume: true };
  }
  void openHistoryExperiment(this, recent);
  return { consume: true };
}

export function IntakeTui_historyInput(this: HistoryPanel, data: string): { consume: true } | undefined {
  const result = handleHistoryInput(
    { tab: this.historyTab, selected: this.historySelected },
    data,
    this.historyItems(),
  );
  if (!result) return undefined;
  this.historyTab = result.state.tab;
  this.historySelected = result.state.selected;
  if (result.detail) {
    if ("taskCase" in result.detail) {
      this.historyDetail = result.detail;
      this.page = "history-detail";
      this.message = t(this.locale, "historyDetailMsg");
    } else {
      void openHistoryExperiment(this, result.detail);
      return result;
    }
  }
  this.render();
  return result;
}

async function openHistoryExperiment(c: HistoryPanel, item: HistoryExperiment): Promise<void> {
  const token = c.beginNavigation();
  try {
    const page = await readExperimentEvents({ dataDir: c.dataDir, experimentId: item.experimentId });
    if (token !== c.generation) return;
    c.historyDetail = item;
    c.timeline = projectPersistedTimeline(page.events);
    const visible = c.visibleTimeline();
    c.timelineSelected = Math.max(0, visible.length - 1);
    c.timelineFollowing = true;
    c.page = "history-detail";
    c.message = t(c.locale, "historyDetailMsg");
  } catch (error) {
    if (token !== c.generation) return;
    c.showError(error, "history");
  }
  c.render(true);
}

export function IntakeTui_historyItems(this: HistoryPanel): readonly (HistoryCase | HistoryExperiment)[] {
  return this.historyTab === "runs"
    ? this.historyExperiments
    : this.historyCases;
}

export async function IntakeTui_loadHistory(this: HistoryPanel): Promise<void> {
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
