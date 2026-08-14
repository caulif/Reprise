export type ReportLang = "zh" | "en";

export function reportCopy(lang: ReportLang) {
  return lang === "zh" ? ZH : EN;
}

const EN = {
  product: "Reprise comparison",
  started: (at: string) => `started ${at}`,
  noRuns: "No persisted candidate runs are available.",
  notice:
    "Single run; results are affected by randomness. This report is not a ranking.",
  noNarrative:
    "No validated comparison narrative is available. The files below hold the persisted record.",
  contrast: "Host contrast",
  baseline: "Baseline",
  candidate: "Candidate",
  onDisk: "On disk",
  outcome: "Outcome",
  identity: "Identity",
  baselineDisk: "Final message only; workspace files were not captured.",
  frozenSession: "Frozen historical session",
  noChangedPaths: "No changed paths recorded.",
  changedPaths: (count: number, sample: string, extra: number) =>
    `${count} changed path${count === 1 ? "" : "s"} recorded: ${sample}${extra ? ` (+${extra} more)` : ""}`,
  limits: "Replay limits",
  evidence: "Evidence",
  evidenceNote: "Changed paths are Host-recorded; JSON traces stay folded.",
  pathInScope: "path recorded in workspace scope",
  noChangedPathsListed: "No changed paths were recorded.",
  narrativeLabel: "comparison narrative",
  catalog: "Catalog attachments",
  noFiles: "No experiment-owned files are available.",
  unavailable: "unavailable",
  turns: (n: number) => `Turns: ${n}`,
  wallClock: (ms: number) => `Wall-clock: ${ms} ms`,
  changedFiles: (n: number) => `Changed files: ${n}`,
  tokens: (n: number) => `Tokens: ${n}`,
  traceEvents: (first: number, last: number) => `Trace events ${first}-${last}.`,
  baselineFallback: (status: string) => `Baseline ${status}.`,
  baselineStatus: (status: string) => status,
};

const ZH = {
  product: "Reprise 比较",
  started: (at: string) => `开始于 ${at}`,
  noRuns: "没有已保存的候选运行。",
  notice: "单次运行；结果受随机性影响。本报告不是排名。",
  noNarrative: "没有通过校验的比较正文。下列文件保存了持久化记录。",
  contrast: "宿主对照",
  baseline: "基线",
  candidate: "候选",
  onDisk: "磁盘",
  outcome: "结果",
  identity: "身份",
  baselineDisk: "仅有终稿；未采集工作区文件。",
  frozenSession: "冻结的历史会话",
  noChangedPaths: "未记录到改动路径。",
  changedPaths: (count: number, sample: string, extra: number) =>
    `记录到 ${count} 条改动路径：${sample}${extra ? `（另有 ${extra} 条）` : ""}`,
  limits: "回放限制",
  evidence: "证据",
  evidenceNote: "改动路径由 Host 记录；JSON 轨迹默认折叠。",
  pathInScope: "工作区范围中记录的路径",
  noChangedPathsListed: "未记录到改动路径。",
  narrativeLabel: "比较正文",
  catalog: "目录附件",
  noFiles: "没有实验所属文件。",
  unavailable: "不可用",
  turns: (n: number) => `回合：${n}`,
  wallClock: (ms: number) => `墙钟：${ms} ms`,
  changedFiles: (n: number) => `改动文件：${n}`,
  tokens: (n: number) => `Token：${n}`,
  traceEvents: (first: number, last: number) => `轨迹事件 ${first}-${last}。`,
  baselineFallback: (status: string) => `基线${statusLabel(status)}。`,
  baselineStatus: (status: string) => statusLabel(status),
};

function statusLabel(status: string): string {
  if (status === "available") return "可用";
  if (status === "unavailable") return "不可用";
  if (status === "redacted") return "已脱敏";
  return status;
}
