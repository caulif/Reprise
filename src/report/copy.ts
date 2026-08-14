export type ReportLang = "zh" | "en";

export function reportCopy(lang: ReportLang) {
  return lang === "zh" ? ZH : EN;
}

const EN = {
  product: "Reprise comparison",
  noRuns: "No persisted candidate runs are available.",
  notice: "Not a ranking",
  noNarrative:
    "No validated comparison narrative is available. The files below hold the persisted record.",
  limits: "Replay limits",
  files: "Files",
  noDeliveries: "No delivery paths recorded.",
  narrativeLabel: "comparison narrative",
  records: "Raw records",
  noFiles: "No experiment-owned files are available.",
  unavailable: "unavailable",
  turns: (n: number) => `${n} turn${n === 1 ? "" : "s"}`,
  wallClock: (ms: number) => `${ms} ms`,
  tokens: (n: number) => `${n} tokens`,
  baselineFallback: (status: string) => `Baseline ${status}.`,
  baselineStatus: (status: string) => status,
};

const ZH = {
  product: "Reprise 比较",
  noRuns: "没有已保存的候选运行。",
  notice: "不是排名",
  noNarrative: "没有通过校验的比较正文。下列文件保存了持久化记录。",
  limits: "回放限制",
  files: "文件",
  noDeliveries: "未记录到交付路径。",
  narrativeLabel: "比较正文",
  records: "原始记录",
  noFiles: "没有实验所属文件。",
  unavailable: "不可用",
  turns: (n: number) => `${n} 回合`,
  wallClock: (ms: number) => `${ms} ms`,
  tokens: (n: number) => `${n} token`,
  baselineFallback: (status: string) => `基线${statusLabel(status)}。`,
  baselineStatus: (status: string) => statusLabel(status),
};

function statusLabel(status: string): string {
  if (status === "available") return "可用";
  if (status === "unavailable") return "不可用";
  if (status === "redacted") return "已脱敏";
  return status;
}
