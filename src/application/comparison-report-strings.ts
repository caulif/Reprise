import type { AgentLocale } from "../agents/language.js";

type Msg = { readonly en: string; readonly zh: string };

const M = {
  htmlLang: { en: "en", zh: "zh-CN" },
  defaultCategory: { en: "Comparison", zh: "对照" },
  failedCategory: { en: "Comparison failed", zh: "对照失败" },
  titleVs: { en: "{category} · {baseline} vs {candidate}", zh: "{category} · {baseline} vs {candidate} 对比" },
  metricTime: { en: "Time", zh: "时间" },
  metricTokens: { en: "Tokens", zh: "Token" },
  metricCost: { en: "Cost", zh: "费用" },
  unitMinutes: { en: "min", zh: "min" },
  unitSeconds: { en: "s", zh: "s" },
  visualNoMediaRegistered: {
    en: "No preview images were registered for this comparison.",
    zh: "本次对照未登记可用的预览图。",
  },
  visualBaselineMissing: {
    en: "Candidate preview is available; the historical final image could not be recovered or rendered.",
    zh: "候选侧已有预览图；历史侧终稿图未能恢复或渲染。",
  },
  visualCandidateMissing: {
    en: "Historical preview is available; the candidate final image could not be recovered or rendered.",
    zh: "历史侧已有预览图；候选侧终稿图未能恢复或渲染。",
  },
  visualRegisteredUnavailable: {
    en: "Preview images were registered but their source files are unavailable.",
    zh: "预览图已登记，但源文件不可用。",
  },
  visualSourcesMissing: {
    en: "Preview images were referenced but could not be solidified into comparison media.",
    zh: "引用了预览图，但未能固化到对照媒体索引。",
  },
  visualPairingHint: {
    en: "Host listed candidate pairings from registered media. Choose verified same-kind sources; index order is not proof they are comparable.",
    zh: "Host 列出了已登记媒体的候选配对。请选用已核验的同类来源；数组顺序不证明业务可比。",
  },
  visualDerivedPreview: {
    en: "Derived preview (not an original historical screenshot).",
    zh: "派生预览（不是历史当时截图）。",
  },
  visualLoadFailed: {
    en: "Registered image failed to load from the attempt media root.",
    zh: "已登记图片未能从 attempt 媒体根加载。",
  },
  detailsSummary: {
    en: "Evidence and extras",
    zh: "查看依据与补充",
  },
  comparisonZoneComment: {
    en: "Author the main comparison here: paired visuals, tables, excerpts, or steps. Keep limitations that change the choice nearby. Components are optional conveniences.",
    zh: "在此撰写主体对照：并排图、表格、片段或步骤。影响取舍的限制就近写明。组件只是可选便利，不是必填段落。",
  },
  detailsZoneComment: {
    en: "Optional longer methods, file listings, and investigation detail. Host evidence and process follow below.",
    zh: "可选：较长方法、文件清单与调查细节。Host 证据与过程区在下方。",
  },
  missing: { en: "not collected", zh: "未采集" },
  pricingUnavailable: { en: "no price configured", zh: "价格未配置" },
  costUnknown: { en: "not computable", zh: "不可计算" },
  costNote: {
    en: 'Cost uses the pinned price snapshot and excludes tool calls. No tokens shows "not collected"; tokens without a price shows "no price configured". Price table {version}.',
    zh: "费用按本次钉住的价格快照计算，不含工具调用成本。无 Token 显示未采集；有 Token 无价格显示价格未配置。价格表 {version}。",
  },
  runDiagnostics: { en: "Run diagnostics", zh: "运行诊断" },
  evidencePaths: { en: "Real paths and files", zh: "真实路径与文件" },
  registeredMedia: { en: "Registered media", zh: "已注册媒体" },
  unresolvedEvidence: { en: "Unresolved evidence: {refs}", zh: "证据未解析：{refs}" },
  diagFailed: { en: "Comparison could not be completed", zh: "对照未能完成" },
  diagClassPhase: { en: "Failure class: {class}. Phase: {phase}.", zh: "对照失败分类：{class}。失败阶段：{phase}。" },
  diagDraft: { en: "Existing analysis (report structure incompatible)", zh: "已有分析（报告结构未兼容）" },
  diagCandidateCompleted: { en: "Candidate task completed: {value}", zh: "候选任务是否完成：{value}" },
  diagProcessHint: {
    en: "Open the trace and artifacts in the experiment directory to continue; an existing successful report.html belongs to an earlier attempt.",
    zh: "打开实验目录中的 trace 与 artifacts 继续排查；若已有成功 report.html，它属于更早一次 attempt。",
  },
  taskLabel: { en: "Task", zh: "任务描述" },
  headlineLabel: { en: "Main conclusion", zh: "主要结论" },
  sessionHistorical: { en: "Historical session", zh: "历史会话" },
  sessionCurrent: { en: "Current session", zh: "当前会话" },
  sideHistorical: { en: "unrecorded", zh: "未记录" },
  sideCandidate: { en: "unrecorded", zh: "未记录" },
  candidateTaskCompleted: { en: "Candidate task completed", zh: "候选任务已完成" },
  candidateTaskIncomplete: { en: "Candidate task incomplete ({code})", zh: "候选任务未完成（{code}）" },
  candidateTaskOutcome: { en: "Candidate task status: {outcome}", zh: "候选任务状态：{outcome}" },
  hostLimitationHeadlineMissing: { en: "Main conclusion is missing.", zh: "主要结论缺失" },
  hostLimitationCannotDetermine: { en: "cannot be determined", zh: "无法判断" },
  hostLimitationLeakedInternal: {
    en: "Above-the-fold content contained internal run identifiers or restated the full process.",
    zh: "首屏含内部运行标识或复述了完整过程。",
  },
  hostLimitationShareCardPresentation: {
    en: "Share-card presentation could not be fully repaired.",
    zh: "分享卡版式未能完全修好。",
  },
  hostLimitationVerifiedWordlist: {
    en: "The report used verification wording without resolvable evidence.",
    zh: "正文使用了核验措辞但没有可解析证据。",
  },
  hostLimitationVisualWordlist: {
    en: "The report claimed visual inspection without available media.",
    zh: "正文声称已做视觉检查但没有可用媒体。",
  },
  hostLimitationCitedMediaUnresolved: {
    en: "Cited media could not be resolved.",
    zh: "引用的媒体未能解析。",
  },
  hostLimitationUnpairedImages: {
    en: "Share-card shows one side's result only; the missing side and reason must stay visible next to it.",
    zh: "首屏仅展示一侧结果；缺失方及原因须就近可见。",
  },
  hostLimitationOneSidedMissingNote: {
    en: "One-sided preview is shown without an explicit nearby note naming the missing side.",
    zh: "单侧预览已展示，但附近未明确写明缺失方。",
  },
} as const satisfies Record<string, Msg>;

export type ComparisonReportStringKey = keyof typeof M;

export function reportString(locale: AgentLocale, key: ComparisonReportStringKey, vars?: Record<string, string | number>): string {
  let text: string = M[key][locale] ?? M[key].en;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function candidateStatusLabel(outcome: string, terminationCode: string, locale: AgentLocale = "zh"): string {
  if (outcome === "completed" || outcome === "satisfied") return reportString(locale, "candidateTaskCompleted");
  if (outcome === "incomplete" || outcome === "failed") return reportString(locale, "candidateTaskIncomplete", { code: terminationCode });
  return reportString(locale, "candidateTaskOutcome", { outcome });
}
