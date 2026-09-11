import type { ComparisonReportFacts } from "../agents/comparison-agent.js";

export type MetricSideProjection = {
  elapsedMs?: number;
  tokens?: { total: number };
  costUsd?: number;
};

const MISSING = "未采集";

export function renderComparisonReportShell(input: {
  title?: string;
  task: string;
  metrics: {
    baseline?: MetricSideProjection;
    candidate?: MetricSideProjection;
  };
}): string {
  const task = oneLine(input.task);
  const title = oneLine(input.title ?? "对照");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { --paper:#f3efe6; --card:#fffcf7; --ink:#1c1915; --soft:#5c574e; --faint:#8a8478; --line:rgba(28,25,21,.08); --hair:rgba(28,25,21,.12); --shadow:0 18px 40px rgba(40,32,18,.08); }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--paper); color:var(--ink); font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Songti SC","Source Han Serif SC",serif; }
  .page { max-width:1080px; margin:0 auto; padding:56px 32px 72px; }
  .kicker { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); margin:0 0 12px; }
  h1 { font-size:34px; font-weight:600; letter-spacing:-.03em; line-height:1.15; margin:0 0 10px; }
  .task { margin:0 0 36px; font-size:16px; color:var(--soft); white-space:nowrap; }
  .board { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; }
  .card { background:var(--card); border-radius:22px; box-shadow:var(--shadow); border:1px solid var(--line); padding:22px 22px 20px; min-height:168px; }
  .card .label { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-bottom:18px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; }
  .col { padding-right:16px; }
  .col + .col { padding-right:0; padding-left:18px; border-left:1px solid var(--hair); }
  .who { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.08em; color:var(--faint); margin-bottom:6px; }
  .num { font-variant-numeric:tabular-nums; font-size:40px; line-height:.95; letter-spacing:-.04em; font-weight:600; }
  .num.miss { font-size:28px; color:#b3ada2; letter-spacing:-.02em; }
  .unit { font-size:16px; font-weight:500; color:var(--soft); margin-left:2px; }
  .agent-slot { margin-top:28px; min-height:160px; }
  @media (max-width:900px) { .board { grid-template-columns:1fr; } .num { font-size:36px; } }
</style>
</head>
<body>
<div class="page">
  <p class="kicker">Comparison · Host metrics</p>
  <h1 data-slot="title">${escapeHtml(title)}</h1>
  <p class="task" data-slot="task">${escapeHtml(task)}</p>
  ${renderMetricsBoard(input.metrics)}
  <div class="agent-slot" data-slot="body"></div>
</div>
</body>
</html>
`;
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

export function hostMetricsMismatch(html: string, metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}): string | undefined {
  const block = html.match(/<section class="board" data-host="metrics"[^>]*>[\s\S]*?<\/section>/);
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
  return `<section class="board" data-host="metrics" data-fingerprint="${fingerprint}" aria-label="时间、token、费用对照">
    ${card("时间", formatTime(metrics.baseline?.elapsedMs), formatTime(metrics.candidate?.elapsedMs))}
    ${card("Token", formatTokens(metrics.baseline?.tokens?.total), formatTokens(metrics.candidate?.tokens?.total))}
    ${card("费用", formatCost(metrics.baseline?.costUsd), formatCost(metrics.candidate?.costUsd))}
  </section>`;
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
