import type { CodexIntakeTui } from "./intake-tui.js";
import { readLocalHistory, type HistoryCase, type HistoryExperiment } from "./local-history.js";
import { handleHistoryInput } from "./history-input.js";
import { t } from "./i18n.js";

export function CodexIntakeTui_historyInput(this: CodexIntakeTui, data: string): { consume: true } | undefined {
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

export function CodexIntakeTui_historyItems(this: CodexIntakeTui): readonly (HistoryCase | HistoryExperiment)[] {
    return this.historyTab === "runs"
      ? this.historyExperiments
      : this.historyCases;
  }

export async function CodexIntakeTui_loadHistory(this: CodexIntakeTui): Promise<void> {
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
