import type { ComparisonReportFacts } from "../agents/comparison-agent.js";
import {
  hostZoneIntegrityError,
  type AgentZoneName,
  type HostZoneName,
  type HostZoneSnapshot,
} from "../core/comparison-html.js";
import type { ComparisonMediaRecord, ComparisonReportModel } from "../core/schema.js";
import { MODEL_PRICING_TABLE_VERSION } from "./model-pricing.js";

export {
  AGENT_ZONES,
  extractHostZoneSnapshot,
  extractInner,
  extractOuter,
  HOST_ZONES,
  missingComparisonSlots,
} from "../core/comparison-html.js";
export type { AgentZoneName, HostZoneName, HostZoneSnapshot };

export type MetricSideProjection = {
  elapsedMs?: number;
  tokens?: { total: number };
  costUsd?: number;
};

export type ComparisonReportDiagnostic = {
  failureClass: string;
  phase: string;
  candidateCompleted: string;
  reason: string;
  details: readonly string[];
  traces: readonly string[];
};

const MISSING = "未采集";

export function renderComparisonReportShell(input: {
  title?: string;
  task: string;
  facts: ComparisonReportFacts;
  metrics: {
    baseline?: MetricSideProjection;
    candidate?: MetricSideProjection;
  };
  evidence?: readonly { side: string; inspectPath: string; reportHref?: string }[];
  media?: readonly ComparisonMediaRecord[];
  slots?: Partial<Record<AgentZoneName | HostZoneName, string>>;
  diagnostic?: ComparisonReportDiagnostic;
}): string {
  const task = oneLine(input.task);
  const title = oneLine(input.title ?? (input.diagnostic ? "Comparison unavailable" : "对照"));
  const slots = input.slots ?? {};
  const header = slots.header ?? defaultHeader(title, task, input.diagnostic);
  const status = renderStatus(input.facts);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style data-host-zone="style" data-id="host-style">
${REPORT_CSS}
</style>
</head>
<body${input.diagnostic ? ' data-report="diagnostic"' : ""}>
<div class="page">
  <header data-host-zone="header" data-id="host-header">${header}</header>
  ${status}
  ${renderMetricsBoard(input.metrics)}
  <p class="kicker cost-note" data-host-zone="cost-note" data-id="host-cost-note">费用不含工具调用成本。价格表 ${escapeHtml(MODEL_PRICING_TABLE_VERSION)}。缺测降低权重，不把可计算费用显示成未采集。</p>
  <section class="slot" data-agent-zone="key-differences" data-id="agent-key-differences">${slots["key-differences"] ?? (input.diagnostic ? diagnosticDifferences(input.diagnostic) : "")}</section>
  <section class="slot" data-agent-zone="visual-evidence" data-id="agent-visual-evidence">${slots["visual-evidence"] ?? ""}</section>
  <section class="slot" data-agent-zone="delivery" data-id="agent-delivery">${slots.delivery ?? (input.diagnostic ? diagnosticDelivery(input.diagnostic) : "")}</section>
  <section class="slot" data-agent-zone="limitations" data-id="agent-limitations">${slots.limitations ?? (input.diagnostic ? diagnosticLimitations(input.diagnostic) : "")}</section>
  <section class="slot" data-host-zone="evidence" data-id="host-evidence">${renderEvidenceCatalog(input.evidence)}${renderMediaCatalog(input.media)}</section>
  <section class="slot" data-host-zone="process" data-id="host-process">${slots.process ?? (input.diagnostic ? diagnosticProcess(input.diagnostic) : "")}</section>
</div>
</body>
</html>
`;
}

export function renderComparisonReportFromModel(input: {
  model: ComparisonReportModel;
  facts: ComparisonReportFacts;
  evidence?: readonly { side: string; inspectPath: string; reportHref?: string }[];
  media?: readonly ComparisonMediaRecord[];
  diagnostic?: ComparisonReportDiagnostic;
}): string {
  return renderComparisonReportShell({
    title: input.model.headline ?? (input.diagnostic ? "Comparison unavailable" : "对照"),
    task: input.model.task,
    facts: input.facts,
    metrics: metricsFromReportFacts(input.facts),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.media ? { media: input.media } : {}),
    slots: input.model.slots,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
  });
}

function hostMetricsFingerprint(metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): string {
  return JSON.stringify({
    b: sideFingerprint(metrics.baseline),
    c: sideFingerprint(metrics.candidate),
  });
}

function hostStatusFingerprint(facts: ComparisonReportFacts): string {
  return JSON.stringify({
    baseline: facts.replay.baselineEvidence,
    outcome: facts.run.outcome,
    termination: facts.run.terminationCode,
    initiatedBy: facts.run.initiatedBy,
  });
}

export function hostMetricsMismatch(html: string, metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): string | undefined {
  const block = html.match(/<section class="board"[^>]*data-host-zone="metrics"[^>]*>[\s\S]*?<\/section>/)
    ?? html.match(/<section class="board" data-host="metrics"[^>]*>[\s\S]*?<\/section>/);
  if (!block) return "Host metrics block is missing.";
  const match = block[0].match(/data-fingerprint="([^"]*)"/);
  const expected = hostMetricsFingerprint(metrics);
  if (!match || decodeHtml(match[1] ?? "") !== expected) return "Host metrics numbers were modified.";
  for (const visible of visibleMetricTexts(metrics)) {
    if (!block[0].includes(visible.text)) return "Host metrics numbers were modified.";
    if (visible.unit && !block[0].includes(`class="unit">${visible.unit}<`)) return "Host metrics numbers were modified.";
  }
  return undefined;
}

export function hostStatusMismatch(html: string, facts: ComparisonReportFacts): string | undefined {
  const block = html.match(/<section[^>]*data-host-zone="status"[^>]*>[\s\S]*?<\/section>/)
    ?? html.match(/<section[^>]*data-host="status"[^>]*>[\s\S]*?<\/section>/);
  if (!block) return "Host status block is missing.";
  const match = block[0].match(/data-fingerprint="([^"]*)"/);
  if (!match || decodeHtml(match[1] ?? "") !== hostStatusFingerprint(facts)) {
    return "Host status values were modified.";
  }
  return undefined;
}

export function hostZonesMismatch(html: string, snapshot: HostZoneSnapshot, metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): string | undefined {
  return hostZoneIntegrityError(html, snapshot) ?? hostMetricsMismatch(html, metrics);
}

function visibleMetricTexts(metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): FormattedMetric[] {
  return [
    formatTime(metrics.baseline?.elapsedMs),
    formatTime(metrics.candidate?.elapsedMs),
    formatTokens(metrics.baseline?.tokens?.total),
    formatTokens(metrics.candidate?.tokens?.total),
    formatCost(metrics.baseline?.costUsd),
    formatCost(metrics.candidate?.costUsd),
  ];
}

export function metricsFromReportFacts(facts: ComparisonReportFacts): {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
} {
  return {
    ...(facts.metrics?.baseline ? { baseline: facts.metrics.baseline } : {}),
    ...(facts.metrics?.candidate ? { candidate: facts.metrics.candidate } : {}),
  };
}

function renderMetricsBoard(metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): string {
  const fingerprint = escapeHtml(hostMetricsFingerprint(metrics));
  return `<section class="board" data-host-zone="metrics" data-id="host-metrics" data-host="metrics" data-fingerprint="${fingerprint}" aria-label="时间、token、费用对照">
    ${card("时间", formatTime(metrics.baseline?.elapsedMs), formatTime(metrics.candidate?.elapsedMs))}
    ${card("Token", formatTokens(metrics.baseline?.tokens?.total), formatTokens(metrics.candidate?.tokens?.total))}
    ${card("费用", formatCost(metrics.baseline?.costUsd), formatCost(metrics.candidate?.costUsd))}
  </section>`;
}

function renderStatus(facts: ComparisonReportFacts): string {
  const fingerprint = escapeHtml(hostStatusFingerprint(facts));
  const baseline = facts.replay.baselineEvidence === "verifiable" ? "历史证据可核对" : "历史证据不足";
  const candidate = candidateStatusLabel(facts.run.outcome, facts.run.terminationCode);
  return `<section class="status" data-host-zone="status" data-id="host-status" data-host="status" data-fingerprint="${fingerprint}" aria-label="双方状态">
    <div class="status-grid">
      <article class="status-card">
        <div class="who">Baseline</div>
        <div class="state">${escapeHtml(baseline)}</div>
      </article>
      <article class="status-card">
        <div class="who">Candidate</div>
        <div class="state">${escapeHtml(candidate)}</div>
        <div class="muted">${escapeHtml(facts.run.outcome)} · ${escapeHtml(facts.run.terminationCode)}</div>
      </article>
    </div>
  </section>`;
}

export function candidateStatusLabel(outcome: string, terminationCode: string): string {
  if (outcome === "completed" || outcome === "satisfied") return "候选任务已完成";
  if (outcome === "incomplete" || outcome === "failed") return `候选任务未完成（${terminationCode}）`;
  return `候选任务状态：${outcome}`;
}

function renderEvidenceCatalog(entries: readonly { side: string; inspectPath: string; reportHref?: string; shortRef?: string; label?: string }[] | undefined): string {
  if (!entries?.length) return "";
  const rows = entries.map((entry) => {
    const name = entry.label ?? entry.inspectPath;
    const ref = entry.shortRef ? `${entry.shortRef} ` : "";
    const href = entry.reportHref ? `<a class="path-link" href="${escapeHtml(entry.reportHref)}">${escapeHtml(entry.inspectPath)}</a>` : escapeHtml(entry.inspectPath);
    return `<li data-component="path-link" data-evidence-ref="${escapeHtml(entry.shortRef ?? "")}"><span class="who">${escapeHtml(entry.side)}</span> ${escapeHtml(ref)}${escapeHtml(name)} ${href}</li>`;
  }).join("");
  return `<details class="evidence-expand" data-component="evidence-expand" data-host="evidence-paths"><summary>真实路径与文件</summary><ul class="kv-list">${rows}</ul></details>`;
}

function renderMediaCatalog(media: readonly ComparisonMediaRecord[] | undefined): string {
  if (!media?.length) return "";
  const rows = media.map((item) => {
    const state = item.available ? "available" : "unavailable";
    const href = item.available
      ? `<a class="path-link" href="${escapeHtml(item.reportHref)}">${escapeHtml(item.inspectPath)}</a>`
      : escapeHtml(item.inspectPath);
    return `<li data-media-ref="${escapeHtml(item.shortRef ?? item.ref)}"><span class="who">${escapeHtml(item.side)}</span> ${escapeHtml(item.shortRef ?? item.ref)} ${href} <span class="muted">${escapeHtml(item.mediaType)} · ${state}</span></li>`;
  }).join("");
  return `<details class="evidence-expand" data-host="media-catalog"><summary>已注册媒体</summary><ul class="kv-list">${rows}</ul></details>`;
}

function defaultHeader(title: string, task: string, diagnostic?: ComparisonReportDiagnostic): string {
  const kicker = diagnostic ? `Comparison · ${diagnostic.failureClass}` : "Comparison";
  return `<p class="kicker">${escapeHtml(kicker)}</p>
  <h1 data-slot="title">${escapeHtml(title)}</h1>
  <p class="task" data-slot="task">${escapeHtml(task)}</p>`;
}

function diagnosticDifferences(diagnostic: ComparisonReportDiagnostic): string {
  return `<article class="result-card" data-component="result-card" data-failure-class="${escapeHtml(diagnostic.failureClass)}" data-failure-phase="${escapeHtml(diagnostic.phase)}">
    <p><strong>Comparison unavailable</strong></p>
    <p>对照失败分类：${escapeHtml(diagnostic.failureClass)}。失败阶段：${escapeHtml(diagnostic.phase)}。</p>
    <p>${escapeHtml(diagnostic.reason)}</p>
  </article>`;
}

function diagnosticDelivery(diagnostic: ComparisonReportDiagnostic): string {
  return `<p>候选任务是否完成：${escapeHtml(diagnostic.candidateCompleted)}</p>`;
}

function diagnosticLimitations(diagnostic: ComparisonReportDiagnostic): string {
  return `<ul>${diagnostic.details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function diagnosticProcess(diagnostic: ComparisonReportDiagnostic): string {
  if (!diagnostic.traces.length) return "<p>打开实验目录中的 trace 与 artifacts 继续排查；若已有成功 report.html，它属于更早一次 attempt。</p>";
  return `<ul>${diagnostic.traces.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function card(label: string, baseline: FormattedMetric, candidate: FormattedMetric): string {
  return `<article class="card">
      <div class="label">${label}</div>
      <div class="pair">
        <div class="col">
          <div class="who">Baseline</div>
          ${metricHtml(baseline)}
        </div>
        <div class="col">
          <div class="who">Candidate</div>
          ${metricHtml(candidate)}
        </div>
      </div>
    </article>`;
}

type FormattedMetric = { text: string; unit?: string; missing: boolean };

function metricHtml(value: FormattedMetric): string {
  if (value.missing) return `<div class="num miss">${MISSING}</div>`;
  const unit = value.unit ? `<span class="unit">${escapeHtml(value.unit)}</span>` : "";
  return `<div class="num">${escapeHtml(value.text)}${unit}</div>`;
}

function formatTime(ms: number | undefined): FormattedMetric {
  if (ms === undefined) return { text: MISSING, missing: true };
  if (ms >= 60_000) return { text: String(Math.round(ms / 60_000)), unit: "分", missing: false };
  return { text: String(Math.round(ms / 1000)), unit: "秒", missing: false };
}

function formatTokens(total: number | undefined): FormattedMetric {
  if (total === undefined) return { text: MISSING, missing: true };
  if (total >= 1_000_000) {
    return { text: trimDecimals((total / 1_000_000).toFixed(2)), unit: "M", missing: false };
  }
  return { text: String(Math.round(total)), missing: false };
}

function formatCost(amount: number | undefined): FormattedMetric {
  if (amount === undefined) return { text: MISSING, missing: true };
  return { text: amount.toFixed(2), unit: "$", missing: false };
}

function sideFingerprint(side: MetricSideProjection | undefined): [number | null, number | null, number | null] {
  return [
    side?.elapsedMs ?? null,
    side?.tokens?.total ?? null,
    side?.costUsd ?? null,
  ];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimDecimals(value: string): string {
  return value.replace(/\.?0+$/, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const REPORT_CSS = `
:root { --paper:#f3efe6; --card:#fffcf7; --ink:#1c1915; --soft:#5c574e; --faint:#8a8478; --line:rgba(28,25,21,.08); --hair:rgba(28,25,21,.12); --shadow:0 18px 40px rgba(40,32,18,.08); --accent:#5b4630; --risk:#8b2e2e; --ok:#2f5d3a; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--paper); color:var(--ink); font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Songti SC","Source Han Serif SC",serif; }
.page { max-width:1080px; margin:0 auto; padding:56px 32px 72px; }
.kicker { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); margin:0 0 12px; }
h1 { font-size:34px; font-weight:600; letter-spacing:-.03em; line-height:1.15; margin:0 0 10px; }
.task { margin:0 0 28px; font-size:16px; color:var(--soft); white-space:nowrap; }
.board { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; margin: 8px 0 12px; }
.card,.status-card,.result-card { background:var(--card); border-radius:22px; box-shadow:var(--shadow); border:1px solid var(--line); padding:22px 22px 20px; }
.card { min-height:168px; }
.card .label { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-bottom:18px; }
.pair { display:grid; grid-template-columns:1fr 1fr; }
.col { padding-right:16px; }
.col + .col { padding-right:0; padding-left:18px; border-left:1px solid var(--hair); }
.who { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.08em; color:var(--faint); margin-bottom:6px; }
.num { font-variant-numeric:tabular-nums; font-size:40px; line-height:.95; letter-spacing:-.04em; font-weight:600; }
.num.miss { font-size:28px; color:#b3ada2; letter-spacing:-.02em; }
.unit { font-size:16px; font-weight:500; color:var(--soft); margin-left:2px; }
.status { margin: 0 0 22px; }
.status-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.state { font-size:20px; font-weight:600; }
.muted,[data-component="muted"] { color:var(--faint); font-size:14px; }
.slot { margin-top:28px; }
.cost-note { margin: 0 0 8px; }
strong,[data-component="judgment"] { font-weight:700; }
[data-component="highlight"] { background:rgba(91,70,48,.12); padding:0 .2em; }
[data-component="strike"] { text-decoration:line-through; color:var(--soft); }
[data-component="quote"] { border-left:3px solid var(--hair); padding-left:12px; color:var(--soft); }
code,[data-component="code"] { font-family:"Cascadia Code","Sarasa Mono SC",monospace; font-size:.92em; }
[data-component="tag-improve"],[data-component="tag-tradeoff"],[data-component="tag-risk"] { display:inline-block; font-size:12px; letter-spacing:.04em; padding:2px 8px; border-radius:999px; }
[data-component="tag-improve"] { background:rgba(47,93,58,.12); color:var(--ok); }
[data-component="tag-tradeoff"] { background:rgba(91,70,48,.12); }
[data-component="tag-risk"] { background:rgba(139,46,46,.12); color:var(--risk); }
[data-component="diff-table"] { width:100%; border-collapse:collapse; }
[data-component="diff-table"] th,[data-component="diff-table"] td { border-bottom:1px solid var(--hair); padding:10px 8px; vertical-align:top; }
[data-component="split-compare"] { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
[data-component="timeline"] { border-left:2px solid var(--hair); padding-left:16px; }
[data-component="media-compare"],[data-component="media-grid"] { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
[data-component="media-single"] img,[data-component="media-compare"] img,[data-component="media-grid"] img { max-width:100%; border-radius:12px; background:var(--card); }
.evidence-expand { margin-top:16px; }
.path-link { color:var(--accent); }
.kv-list { padding-left:18px; }
body[data-report="diagnostic"] .num.miss { font-size:24px; }
@media (max-width:900px) {
  .board,.status-grid,[data-component="split-compare"] { grid-template-columns:1fr; }
  .num { font-size:36px; }
  .task { white-space:normal; }
}
`;
