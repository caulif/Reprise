import type { AgentLocale } from "../agents/language.js";
import { parseFragment, serializeOuter } from "parse5";
import type { ComparisonMetricSide, ComparisonReportFacts } from "../agents/comparison-agent.js";
import {
  extractOuter,
  type AgentZoneName,
  type HostZoneName,
} from "../core/comparison-html.js";
import type { ComparisonMediaRecord } from "../core/schema.js";
import { MODEL_PRICING_TABLE_VERSION } from "./model-pricing.js";
import { candidateStatusLabel, reportString } from "./comparison-report-strings.js";
import { renderVisualEvidenceSeed } from "./comparison-visual-evidence.js";

export {
  AGENT_ZONES,
  agentZoneBlank,
  extractInner,
  extractOuter,
  missingComparisonSlots,
} from "../core/comparison-html.js";
export type { AgentZoneName, HostZoneName };

export type MetricSideProjection = {
  elapsedMs?: number;
  tokens?: { total: number };
  costUsd?: number;
  pricingStatus?: "collected" | "not_collected" | "pricing_unavailable" | "unknown";
};

export type ComparisonReportDiagnostic = {
  failureClass: string;
  phase: string;
  candidateCompleted: string;
  reason: string;
  details: readonly string[];
  traces: readonly string[];
};

type HtmlNode = {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  parentNode?: HtmlNode;
  value?: string;
};

function descendants(node: HtmlNode): HtmlNode[] {
  return [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])];
}

function unsafeAgentContent(node: HtmlNode): string | undefined {
  const activeTags = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "form", "meta", "base", "link", "dialog", "svg", "math", "template", "noscript", "input", "textarea", "select", "button"]);
  const unsupportedResourceAttrs = new Set(["xlink:href", "poster", "cite", "action", "formaction", "background", "data"]);
  const tag = node.tagName?.toLowerCase();
  if (tag && activeTags.has(tag)) return `Agent content cannot contain <${tag}>.`;
  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    if (name === "hidden" || name === "inert" || (name === "aria-hidden" && attr.value.toLowerCase() === "true")) {
      return `Agent content cannot be hidden with ${name}.`;
    }
    if (name === "id" || name.startsWith("data-host") || name === "data-id") {
      return `Agent content cannot contain Host-reserved ${name}.`;
    }
    if (unsupportedResourceAttrs.has(name) || (name === "src" && tag !== "img") || (name === "href" && tag !== "a")) {
      return `Agent content cannot contain ${name}.`;
    }
    if (name.startsWith("on") || name === "srcdoc" || name === "srcset" || name === "ping" || name === "style"
      || name === "tabindex" || name === "autofocus"
      || name === "popover" || name === "popovertarget" || name === "popovertargetaction") {
      return `Agent content cannot contain ${name}.`;
    }
    const value = attr.value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
    if ((name === "href" || name === "src") && (/^[a-z][\w+.-]*:/.test(value) || value.startsWith("//") || value.startsWith("\\\\"))) {
      return `Agent content contains an unsafe ${name} URL.`;
    }
  }
  for (const child of descendants(node)) {
    const error = unsafeAgentContent(child);
    if (error) return error;
  }
  return undefined;
}

export function agentFragmentError(html: string): string | undefined {
  if (/<\/?(?:html|head|body)\b/i.test(html)) return "Report content must be an HTML fragment, not a document.";
  const parseErrors: string[] = [];
  const root = parseFragment(html, { onParseError: (error) => parseErrors.push(error.code) }) as unknown as HtmlNode;
  if (parseErrors.length) return `Report fragment is malformed: ${parseErrors[0]}.`;
  const visit = (node: HtmlNode): string | undefined => {
    if (node.attrs?.some((attr) => ["data-agent-zone", "data-agent-slot", "data-host-zone"].includes(attr.name))) {
      return "Report fragment cannot contain zone markers.";
    }
    return descendants(node).map(visit).find(Boolean);
  };
  return visit(root) ?? unsafeAgentContent(root);
}

export function normalizeAgentFragment(html: string): string {
  const root = parseFragment(html) as unknown as HtmlNode;
  return (root.childNodes ?? []).map((node) => serializeOuter(node as never)).join("");
}

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
  slots?: Partial<Record<AgentZoneName | HostZoneName | "headline" | "category" | "task", string>>;
  diagnostic?: ComparisonReportDiagnostic;
  locale?: AgentLocale;
}): string {
  const locale = input.locale ?? "zh";
  const labels = comparisonSideLabels(input.facts, locale);
  const category = oneLine(input.slots?.category ?? reportString(locale, input.diagnostic ? "failedCategory" : "defaultCategory"));
  const task = oneLine(input.slots?.task ?? input.task);
  const title = oneLine(input.title ?? (input.diagnostic
    ? "Comparison unavailable"
    : reportString(locale, "titleVs", { category, baseline: labels.baseline, candidate: labels.candidate })));
  const slots = input.slots ?? {};
  const header = slots.header ?? defaultHeader(labels, category, task, input.task, input.facts, locale, input.diagnostic);
  const headline = slots.headline ?? (input.diagnostic ? escapeHtml(input.diagnostic.reason) : "");
  const comparisonBody = [
    input.diagnostic ? diagnosticDifferences(input.diagnostic, locale) : "",
    slots.comparison
      ?? (input.diagnostic ? "" : renderVisualEvidenceSeed(input.media, locale)),
  ].filter(Boolean).join("");
  const detailsBody = slots.details
    ?? [
      input.diagnostic ? diagnosticDelivery(input.diagnostic, locale) : "",
      input.diagnostic ? diagnosticLimitations(input.diagnostic) : "",
    ].filter(Boolean).join("");
  return `<!DOCTYPE html>
<html lang="${escapeHtml(reportString(locale, "htmlLang"))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style data-host-zone="style" data-id="host-style">
${REPORT_CSS}
</style>
</head>
<body${input.diagnostic ? ' data-report="diagnostic"' : ""}>
${componentTemplateHtml(locale)}
<main class="page" data-report-format="2">
  <article class="share">
    <header data-host-zone="header" data-id="host-header">${header}</header>
    <p class="field-label">${escapeHtml(reportString(locale, "headlineLabel"))}</p>
    <p class="note" data-agent-slot="headline">${headline}</p>
    <section class="slot" data-agent-zone="comparison" data-id="agent-comparison"><!-- ${escapeHtml(reportString(locale, "comparisonZoneComment"))} -->${comparisonBody}</section>
    ${renderMetricsBoard(input.metrics, locale)}
  </article>
  <details class="details">
    <summary>${escapeHtml(reportString(locale, "detailsSummary"))}</summary>
    <section class="slot" data-agent-zone="details" data-id="agent-details"><!-- ${escapeHtml(reportString(locale, "detailsZoneComment"))} -->${detailsBody}</section>
    <p class="kicker cost-note" data-host-zone="cost-note" data-id="host-cost-note">${escapeHtml(reportString(locale, "costNote", { version: MODEL_PRICING_TABLE_VERSION }))}</p>
    <section class="slot" data-host-zone="evidence" data-id="host-evidence">${renderRunDiagnostics(input.facts, locale)}${renderEvidenceCatalog(input.evidence, locale)}${renderMediaCatalog(input.media, locale)}</section>
    <section class="slot" data-host-zone="process" data-id="host-process">${slots.process ?? (input.diagnostic ? diagnosticProcess(input.diagnostic, locale) : "")}</section>
  </details>
</main>
<dialog class="image-dialog" data-host-dialog="image" aria-label="${escapeHtml(reportString(locale, "detailsSummary"))}"><button type="button" class="image-dialog-close" data-host-dialog-close aria-label="Close image" title="Close image">&times;</button><img alt=""></dialog>
<script>${reportInteractionScript(locale)}</script>
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
}, locale: AgentLocale = "zh"): string | undefined {
  const block = extractOuter(html, "data-host-zone", "metrics")
    ?? extractOuter(html, "data-host", "metrics");
  if (!block) return "Host metrics block is missing.";
  const fingerprint = attributeValue(block, "data-fingerprint");
  const expected = hostMetricsFingerprint(metrics);
  if (!fingerprint) return "Host metrics numbers were modified.";
  try {
    if (JSON.stringify(JSON.parse(decodeHtml(fingerprint))) !== JSON.stringify(JSON.parse(expected))) return "Host metrics numbers were modified.";
  } catch {
    return "Host metrics numbers were modified.";
  }
  const normalizedBlock = block.replace(/\s+/g, " ");
  for (const visible of visibleMetricTexts(metrics, locale)) {
    if (visible.missing) continue;
    if (!normalizedBlock.includes(visible.text)) return "Host metrics numbers were modified.";
  }
  return undefined;
}

function attributeValue(html: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  const match = html.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function visibleMetricTexts(metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}, locale: AgentLocale): FormattedMetric[] {
  return [
    formatTime(metrics.baseline?.elapsedMs, locale),
    formatTime(metrics.candidate?.elapsedMs, locale),
    formatTokens(metrics.baseline?.tokens?.total, locale),
    formatTokens(metrics.candidate?.tokens?.total, locale),
    formatCost(metrics.baseline, locale),
    formatCost(metrics.candidate, locale),
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
}, locale: AgentLocale): string {
  const labels = { baseline: reportString(locale, "sessionHistorical"), candidate: reportString(locale, "sessionCurrent") };
  const fingerprint = escapeHtml(hostMetricsFingerprint(metrics));
  const aria = escapeHtml(`${reportString(locale, "metricTime")}, ${reportString(locale, "metricTokens")}, ${reportString(locale, "metricCost")}`);
  return `<section class="board" data-host-zone="metrics" data-id="host-metrics" data-host="metrics" data-fingerprint="${fingerprint}" aria-label="${aria}">
    ${card(reportString(locale, "metricTime"), formatTime(metrics.baseline?.elapsedMs, locale), formatTime(metrics.candidate?.elapsedMs, locale), labels)}
    ${card(reportString(locale, "metricTokens"), formatTokens(metrics.baseline?.tokens?.total, locale), formatTokens(metrics.candidate?.tokens?.total, locale), labels)}
    ${card(reportString(locale, "metricCost"), formatCost(metrics.baseline, locale), formatCost(metrics.candidate, locale), labels)}
  </section>`;
}

function comparisonSideLabels(facts: ComparisonReportFacts, locale: AgentLocale): { baseline: string; candidate: string } {
  const requested = usableModelId(facts.models.candidateRequested);
  const resolved = usableModelId(facts.models.candidateResolved);
  const candidate = requested && resolved && requested !== resolved
    ? (locale === "zh" ? `请求 ${requested} → 解析 ${resolved}` : `requested ${requested} → resolved ${resolved}`)
    : requested && !resolved
      ? (locale === "zh" ? `请求 ${requested} · 解析未确认` : `requested ${requested} · resolution unconfirmed`)
      : resolved ?? requested ?? usableModelId(facts.models.candidate);
  return {
    baseline: usableModelId(facts.models.baseline) ?? reportString(locale, "sideHistorical"),
    candidate: candidate ?? reportString(locale, "sideCandidate"),
  };
}

function usableModelId(value: string | undefined): string | undefined {
  if (!value || value === "unavailable") return undefined;
  return value;
}

function renderRunDiagnostics(facts: ComparisonReportFacts, locale: AgentLocale): string {
  const labels = comparisonSideLabels(facts, locale);
  const baselinePrice = pricingEvidence(facts.metrics?.baseline);
  const candidatePrice = pricingEvidence(facts.metrics?.candidate);
  return `<details class="evidence-expand" data-host="run-diagnostics"><summary>${escapeHtml(reportString(locale, "runDiagnostics"))}</summary><ul class="kv-list">
    <li><span class="who">${escapeHtml(labels.baseline)}</span> ${escapeHtml(facts.replay.baselineEvidence)}</li>
    <li><span class="who">${escapeHtml(labels.candidate)}</span> ${escapeHtml(facts.run.outcome)} · ${escapeHtml(facts.run.terminationCode)} · ${escapeHtml(facts.run.initiatedBy)}</li>
    <li><span class="who">${escapeHtml(labels.baseline)} price</span> ${escapeHtml(baselinePrice)}</li>
    <li><span class="who">${escapeHtml(labels.candidate)} price</span> ${escapeHtml(candidatePrice)}</li>
  </ul></details>`;
}

function pricingEvidence(side: ComparisonMetricSide | undefined): string {
  if (!side) return "unavailable";
  const model = side.pricingModelId ?? "unresolved";
  const source = side.pricingSource ?? side.pricingStatus ?? "unknown";
  const version = side.pricingVersion ?? MODEL_PRICING_TABLE_VERSION;
  const rates = side.pricingRates
    ? ` · in ${side.pricingRates.input} / out ${side.pricingRates.output} / cacheRead ${side.pricingRates.cacheRead} / cacheCreation ${side.pricingRates.cacheCreation}`
    : "";
  return `${model} · ${source} · ${version}${rates}`;
}

function renderEvidenceCatalog(entries: readonly { side: string; inspectPath: string; reportHref?: string; shortRef?: string; label?: string }[] | undefined, locale: AgentLocale): string {
  if (!entries?.length) return "";
  const rows = entries.map((entry) => {
    const name = entry.label ?? entry.inspectPath;
    const ref = entry.shortRef ? `${entry.shortRef} ` : "";
    const href = entry.reportHref ? `<a class="path-link" href="${escapeHtml(entry.reportHref)}">${escapeHtml(entry.inspectPath)}</a>` : escapeHtml(entry.inspectPath);
    return `<li data-component="path-link" data-evidence-ref="${escapeHtml(entry.shortRef ?? "")}"><span class="who">${escapeHtml(entry.side)}</span> ${escapeHtml(ref)}${escapeHtml(name)} ${href}</li>`;
  }).join("");
  return `<details class="evidence-expand" data-component="evidence-expand" data-host="evidence-paths"><summary>${escapeHtml(reportString(locale, "evidencePaths"))}</summary><ul class="kv-list">${rows}</ul></details>`;
}

function renderMediaCatalog(media: readonly ComparisonMediaRecord[] | undefined, locale: AgentLocale): string {
  if (!media?.length) return "";
  const rows = media.map((item) => {
    const state = item.available ? "available" : "unavailable";
    const href = item.available
      ? `<a class="path-link" href="${escapeHtml(item.reportHref)}">${escapeHtml(item.inspectPath)}</a>`
      : escapeHtml(item.inspectPath);
    return `<li data-media-ref="${escapeHtml(item.shortRef ?? item.ref)}"><span class="who">${escapeHtml(item.side)}</span> ${escapeHtml(item.shortRef ?? item.ref)} ${href} <span class="muted">${escapeHtml(item.mediaType)} · ${state}</span></li>`;
  }).join("");
  return `<details class="evidence-expand" data-host="media-catalog"><summary>${escapeHtml(reportString(locale, "registeredMedia"))}</summary><ul class="kv-list">${rows}</ul></details>`;
}

function defaultHeader(
  labels: { baseline: string; candidate: string },
  category: string,
  task: string,
  originalTask: string,
  facts: ComparisonReportFacts,
  locale: AgentLocale,
  diagnostic?: ComparisonReportDiagnostic,
): string {
  const kicker = diagnostic ? `<p class="kicker">Comparison · ${escapeHtml(diagnostic.failureClass)}</p>` : "";
  const summary = task.length > 180 ? `${task.slice(0, 177).trimEnd()}...` : task;
  const request = task.length > 180
    ? `<details class="request-expand" data-host="original-request"><summary>${escapeHtml(reportString(locale, "originalRequest"))}</summary><pre>${escapeHtml(originalTask)}</pre></details>`
    : "";
  return `${kicker}<h1><span data-agent-slot="category">${escapeHtml(category)}</span></h1>
  <p class="sessions" data-host="session-labels"><span><small>${escapeHtml(reportString(locale, "sessionHistorical"))}</small><strong>${escapeHtml(labels.baseline)}</strong></span><span><small>${escapeHtml(reportString(locale, "sessionCurrent"))}</small><strong>${escapeHtml(labels.candidate)}</strong></span></p>
  <p class="run-status" data-host="run-status">${escapeHtml(candidateStatusLabel(facts.run.outcome, facts.run.terminationCode, locale))}</p>
  <p class="field-label">${escapeHtml(reportString(locale, "taskLabel"))}</p>
  <p class="task" data-slot="task" data-agent-slot="task">${escapeHtml(summary)}</p>${request}`;
}

function diagnosticDifferences(diagnostic: ComparisonReportDiagnostic, locale: AgentLocale): string {
  return `<article class="result-card" data-host="diagnostic-card" data-failure-class="${escapeHtml(diagnostic.failureClass)}" data-failure-phase="${escapeHtml(diagnostic.phase)}">
    <h3>${escapeHtml(reportString(locale, "diagFailed"))}</h3>
    <p>${escapeHtml(reportString(locale, "diagClassPhase", { class: diagnostic.failureClass, phase: diagnostic.phase }))}</p>
    <p>${escapeHtml(diagnostic.reason)}</p>
  </article>`;
}

function diagnosticDelivery(diagnostic: ComparisonReportDiagnostic, locale: AgentLocale): string {
  return `<p>${escapeHtml(reportString(locale, "diagCandidateCompleted", { value: diagnostic.candidateCompleted }))}</p>`;
}

function diagnosticLimitations(diagnostic: ComparisonReportDiagnostic): string {
  return `<ul>${diagnostic.details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function diagnosticProcess(diagnostic: ComparisonReportDiagnostic, locale: AgentLocale): string {
  if (!diagnostic.traces.length) return `<p>${escapeHtml(reportString(locale, "diagProcessHint"))}</p>`;
  return `<ul>${diagnostic.traces.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function card(
  label: string,
  baseline: FormattedMetric,
  candidate: FormattedMetric,
  labels: { baseline: string; candidate: string },
): string {
  return `<article class="card">
      <div class="label">${label}</div>
      <div class="pair">
        <div class="col">
          <div class="who">${escapeHtml(labels.baseline)}</div>
          ${metricHtml(baseline)}
        </div>
        <div class="col">
          <div class="who">${escapeHtml(labels.candidate)}</div>
          ${metricHtml(candidate)}
        </div>
      </div>
    </article>`;
}

type FormattedMetric = { text: string; unit?: string; missing: boolean };

function metricHtml(value: FormattedMetric): string {
  if (value.missing) return `<div class="num miss">${escapeHtml(value.text)}</div>`;
  const unit = value.unit ? `<span class="unit">${escapeHtml(value.unit)}</span>` : "";
  return `<div class="num">${escapeHtml(value.text)}${unit}</div>`;
}

function formatTime(ms: number | undefined, locale: AgentLocale = "zh"): FormattedMetric {
  if (ms === undefined) return { text: reportString(locale, "missing"), missing: true };
  if (ms >= 60_000) {
    return { text: String(Math.round(ms / 60_000)), unit: reportString(locale, "unitMinutes"), missing: false };
  }
  return { text: String(Math.round(ms / 1000)), unit: reportString(locale, "unitSeconds"), missing: false };
}

function formatTokens(total: number | undefined, locale: AgentLocale = "zh"): FormattedMetric {
  if (total === undefined) return { text: reportString(locale, "missing"), missing: true };
  if (total >= 1_000_000) {
    return { text: trimDecimals((total / 1_000_000).toFixed(2)), unit: "M", missing: false };
  }
  return { text: String(Math.round(total)), missing: false };
}

export function formatCost(side: MetricSideProjection | undefined, locale: AgentLocale = "zh"): FormattedMetric {
  if (side?.pricingStatus === "pricing_unavailable") return { text: reportString(locale, "pricingUnavailable"), missing: true };
  if (side?.pricingStatus === "unknown") return { text: reportString(locale, "costUnknown"), missing: true };
  if (side?.costUsd !== undefined) return { text: side.costUsd.toFixed(2), unit: "$", missing: false };
  if (side?.tokens) return { text: reportString(locale, "pricingUnavailable"), missing: true };
  return { text: reportString(locale, "missing"), missing: true };
}

function sideFingerprint(side: MetricSideProjection | undefined): [number | null, number | null, number | null, string | null] {
  return [
    side?.elapsedMs ?? null,
    side?.tokens?.total ?? null,
    side?.costUsd ?? null,
    side?.pricingStatus ?? null,
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

function componentTemplateHtml(locale: AgentLocale): string {
  const historical = escapeHtml(reportString(locale, "sessionHistorical"));
  const current = escapeHtml(reportString(locale, "sessionCurrent"));
  return `<!-- Component prototypes: reference only. Agent authors data-agent-zone="comparison" with any useful combination (pair-pages, tables, excerpts, steps). Host CSS does not hide diff-table / split-compare / timeline / difference-card inside .share.
     Wrap verified statements in <span data-claim="verified"> with a data-evidence-ref inside or immediately after;
     wrap visual descriptions in <span data-claim="visual"> with a data-media-ref inside or immediately after. -->
<template data-component-template="headline">
  <div data-component="judgment"><p></p></div>
</template>
<template data-component-template="difference-card">
  <article data-component="difference-card"><h3></h3><p></p></article>
</template>
<template data-component-template="split-compare">
  <div data-component="split-compare"><section></section><section></section></div>
</template>
<template data-component-template="diff-table">
  <table data-component="diff-table"><thead></thead><tbody></tbody></table>
</template>
<template data-component-template="timeline">
  <ol data-component="timeline"><li></li></ol>
</template>
<template data-component-template="media-compare">
  <figure data-component="media-compare"><img data-media-ref="media-01" alt=""><figcaption></figcaption></figure>
</template>
<template data-component-template="pair-pages">
  <div data-component="page-row">
    <div class="cell"><div class="who">${historical}</div><img data-media-ref="" alt=""></div>
    <div class="cell"><div class="who">${current}</div><img data-media-ref="" alt=""></div>
  </div>
</template>
`;
}

function reportInteractionScript(locale: AgentLocale): string {
  const tableHint = JSON.stringify(locale === "zh" ? "表格可横向滚动" : "Scroll table horizontally");
  const imageHint = JSON.stringify(locale === "zh" ? "放大图片" : "Enlarge image");
  return `(() => {
    const zones = document.querySelectorAll('main.page > article.share > section[data-id="agent-comparison"], main.page > details.details > section[data-id="agent-details"]');
    for (const zone of zones) {
      for (const table of zone.querySelectorAll('table')) {
        const frame = document.createElement('div');
        frame.className = 'table-scroll';
        frame.tabIndex = 0;
        frame.setAttribute('role', 'region');
        frame.setAttribute('aria-label', ${tableHint});
        table.replaceWith(frame);
        frame.append(table);
        const hint = document.createElement('p');
        hint.className = 'table-hint';
        hint.textContent = ${tableHint};
        frame.before(hint);
      }
    }
    const dialog = document.querySelector('body > dialog[data-host-dialog="image"]');
    const large = dialog?.querySelector('img');
    const close = dialog?.querySelector('[data-host-dialog-close]');
    if (!dialog || !large || !close) return;
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    for (const image of document.querySelectorAll('main.page > article.share > section[data-id="agent-comparison"] img')) {
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', (image.alt ? image.alt + ' - ' : '') + ${imageHint});
      image.title = ${imageHint};
      const open = () => { large.src = image.currentSrc || image.src; large.alt = image.alt; dialog.showModal(); };
      image.addEventListener('click', open);
      image.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    }
  })();`;
}

const REPORT_CSS = `
:root { --paper:#fff; --card:#fff; --ink:#20282b; --soft:#47545a; --faint:#66757b; --line:#e3e9e7; --hair:#d4deda; --accent:#12685f; --risk:#a2443d; --ok:#277049; }
* { box-sizing:border-box; }
.page { max-width:1080px; margin:0 auto; padding:32px 24px 72px; }
html,body { margin:0; background:var(--paper); color:var(--ink); font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
.share { padding:0; min-width:0; }
.share a { color:var(--accent); text-underline-offset:2px; }
.kicker { font-size:11px; color:var(--faint); margin:0 0 12px; }
h1 { font-size:25px; font-weight:700; line-height:1.28; margin:0 0 10px; overflow-wrap:anywhere; }
.sessions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:0 0 20px; padding:0 0 16px; border-bottom:1px solid var(--line); }
.sessions span { min-width:0; }
.sessions small { display:block; font-size:12px; color:var(--faint); margin-bottom:4px; }
.sessions strong { display:block; font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.field-label { font-size:12px; color:var(--faint); margin:12px 0 4px; }
.task { margin:0 0 10px; font-size:14px; color:var(--soft); line-height:1.5; overflow-wrap:anywhere; }
.run-status { margin:0 0 12px; font-size:12px; font-weight:600; color:var(--accent); }
.request-expand { margin:0 0 14px; font-size:12px; color:var(--soft); }
.request-expand summary { cursor:pointer; color:var(--accent); }
.request-expand pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:16rem; overflow:auto; font:inherit; line-height:1.5; }
.note,[data-agent-slot="headline"] { margin:0 0 18px; font-size:17px; line-height:1.48; font-weight:600; overflow-wrap:anywhere; }
h2 { font-size:18px; line-height:1.35; margin:18px 0 9px; }
h3 { font-size:16px; line-height:1.4; }
pre { max-width:100%; overflow-x:auto; padding:12px; background:#f4f7f6; border:1px solid var(--line); border-radius:4px; }
[data-agent-slot="headline"] strong,[data-component="diff-table"] strong,[data-claim] { font-weight:inherit; }
.board { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; margin:24px 0 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.card { padding:14px 18px 16px 0; min-width:0; }
.card + .card { padding-left:18px; border-left:1px solid var(--line); }
.result-card,[data-host="diagnostic-card"],[data-component="difference-card"] { border-left:3px solid var(--accent); padding:10px 14px; margin:10px 0; background:#f4f8f7; }
.card .label { font-size:12px; color:var(--faint); margin-bottom:10px; }
.pair { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
.col { padding-right:8px; }
.col + .col { padding-right:0; padding-left:12px; border-left:1px solid var(--hair); }
.who { font-size:11px; color:var(--faint); margin-bottom:5px; overflow-wrap:anywhere; }
.num { font-variant-numeric:tabular-nums; font-size:22px; line-height:1.2; font-weight:650; overflow-wrap:anywhere; }
.num.miss { font-size:13px; color:var(--faint); font-weight:500; white-space:normal; }
.unit { font-size:13px; font-weight:500; color:var(--soft); margin-left:2px; }
.muted,[data-component="muted"] { color:var(--faint); font-size:14px; }
.slot { margin-top:14px; min-width:0; }
.pages { display:flex; flex-direction:column; gap:14px; }
[data-component="page-row"] { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:stretch; }
.cell { border:1px solid var(--hair); border-radius:4px; overflow:hidden; background:#fff; }
.cell .who { padding:8px 12px 0; }
.cell img,[data-component="page-row"] img { width:100%; height:320px; object-fit:contain; object-position:top; display:block; background:#fff; }
[data-agent-zone="comparison"] { margin-top:0; margin-bottom:12px; }
[data-agent-zone="comparison"] p,[data-agent-zone="comparison"] li { font-size:14px; line-height:1.5; color:var(--soft); max-width:72em; overflow-wrap:anywhere; }
[data-agent-zone="comparison"] [data-host="visual-unavailable"],[data-agent-zone="comparison"] [data-host="pairing-hint"] { margin:0 0 8px; font-size:14px; }
[data-agent-zone="comparison"] table,[data-component="diff-table"] { display:block; width:100%; max-width:100%; overflow-x:auto; border-collapse:collapse; margin:12px 0; white-space:nowrap; }
[data-agent-zone="comparison"] th,[data-agent-zone="comparison"] td,[data-component="diff-table"] th,[data-component="diff-table"] td { border-bottom:1px solid var(--line); padding:9px 12px 9px 0; vertical-align:top; font-size:13px; font-weight:400; }
.table-scroll { max-width:100%; overflow-x:auto; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.table-scroll:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.table-scroll table,[data-agent-zone="comparison"] .table-scroll table { display:table; width:max-content; min-width:100%; max-width:none; overflow:visible; margin:0; }
.table-hint { margin:8px 0 3px; font-size:11px; color:var(--faint); }
.details { margin-top:22px; color:var(--soft); border-top:1px solid var(--line); padding:16px 0; }
.details > summary { cursor:pointer; font-size:14px; color:var(--accent); }
.details > summary::-webkit-details-marker { display:none; }
.cost-note { margin: 12px 0 8px; }
[data-component="judgment"] { font-weight:700; }
[data-component="judgment"] { margin:0 0 16px; }
[data-host="diagnostic-card"] h3,[data-component="difference-card"] h3 { margin:0 0 8px; font-size:18px; }
[data-host="diagnostic-card"] p,[data-component="difference-card"] p { margin:0; color:var(--soft); }
[data-component="highlight"] { background:#e9f2ef; padding:0 .2em; }
[data-component="strike"] { text-decoration:line-through; color:var(--soft); }
[data-component="quote"] { border-left:3px solid var(--hair); padding-left:12px; color:var(--soft); }
code,[data-component="code"] { font-family:"Cascadia Code","Sarasa Mono SC",monospace; font-size:.92em; }
[data-component="tag-improve"],[data-component="tag-tradeoff"],[data-component="tag-risk"] { display:inline-block; font-size:12px; padding:2px 6px; border-radius:3px; }
[data-component="tag-improve"] { background:rgba(47,93,58,.12); color:var(--ok); }
[data-component="tag-tradeoff"] { background:#edf1f1; }
[data-component="tag-risk"] { background:rgba(139,46,46,.12); color:var(--risk); }
[data-component="diff-table"] .who { font-size:13px; }
[data-component="split-compare"] { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
[data-component="timeline"] { border-left:2px solid var(--hair); padding-left:16px; }
[data-component="media-compare"],[data-component="media-grid"] { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
[data-component="media-single"] img,[data-component="media-compare"] img,[data-component="media-grid"] img { max-width:100%; border-radius:4px; background:var(--card); }
.evidence-expand { margin-top:16px; }
.path-link { color:var(--accent); }
.image-dialog { max-width:min(96vw,1400px); max-height:94vh; padding:38px 12px 12px; border:1px solid var(--line); border-radius:4px; background:#fff; }
.image-dialog::backdrop { background:rgba(17,29,32,.78); }
.image-dialog img { display:block; max-width:calc(96vw - 24px); max-height:calc(94vh - 50px); object-fit:contain; }
.image-dialog-close { position:absolute; top:4px; right:8px; border:0; background:transparent; color:var(--ink); font-size:28px; line-height:1; cursor:pointer; }
[data-agent-zone="comparison"] img[role="button"] { cursor:zoom-in; }
[data-agent-zone="comparison"] img[role="button"]:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.kv-list { padding-left:18px; }
body[data-report="diagnostic"] .num.miss { font-size:16px; }
@media (max-width:760px) {
  .page { padding:20px 14px 48px; }
  .board { grid-template-columns:1fr; }
  .card,.card + .card { padding:11px 0; border-left:0; }
  .card + .card { border-top:1px solid var(--line); }
  [data-component="split-compare"],[data-component="page-row"] { grid-template-columns:1fr; }
  .num { font-size:20px; }
  .task { white-space:normal; }
  .cell img,[data-component="page-row"] img { height:160px; }
}
@media print {
  .details { break-inside:avoid; }
  .share { box-shadow:none; }
  .table-hint,.image-dialog { display:none; }
}
`;
