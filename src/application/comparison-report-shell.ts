import type { AgentLocale } from "../agents/language.js";
import { parse, serializeOuter } from "parse5";
import type { ComparisonMetricSide, ComparisonReportFacts } from "../agents/comparison-agent.js";
import {
  AGENT_ZONES,
  hostZoneIntegrityError,
  extractOuter,
  type AgentZoneName,
  type HostZoneName,
  type HostZoneSnapshot,
} from "../core/comparison-html.js";
import type { ComparisonMediaRecord, ComparisonReportModel } from "../core/schema.js";
import { MODEL_PRICING_TABLE_VERSION } from "./model-pricing.js";
import { reportString } from "./comparison-report-strings.js";
import { renderVisualEvidenceSeed } from "./comparison-visual-evidence.js";

export {
  AGENT_ZONES,
  agentZoneBlank,
  extractHostZoneSnapshot,
  extractInner,
  extractOuter,
  missingComparisonSlots,
} from "../core/comparison-html.js";
export type { AgentZoneName, HostZoneName, HostZoneSnapshot };

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
  const activeTags = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "form", "meta", "base", "link"]);
  const urlAttrs = new Set(["href", "xlink:href", "src", "poster", "cite", "action", "formaction", "background", "data"]);
  const tag = node.tagName?.toLowerCase();
  if (tag && activeTags.has(tag)) return `Agent content cannot contain <${tag}>.`;
  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc" || name === "srcset" || name === "ping" || name === "style") {
      return `Agent content cannot contain ${name}.`;
    }
    const value = attr.value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
    if (urlAttrs.has(name) && (/^[a-z][\w+.-]*:/.test(value) || value.startsWith("//") || value.startsWith("\\\\"))) {
      return `Agent content contains an unsafe ${name} URL.`;
    }
  }
  for (const child of descendants(node)) {
    const error = unsafeAgentContent(child);
    if (error) return error;
  }
  return undefined;
}

export function agentInlineStyleError(html: string): string | undefined {
  const root = parse(html) as unknown as HtmlNode;
  const visit = (node: HtmlNode, inAgent: boolean): boolean => {
    const inside = inAgent || Boolean(node.attrs?.some((attr) => attr.name === "data-agent-zone" || attr.name === "data-agent-slot"));
    if (inside && node.attrs?.some((attr) => attr.name.toLowerCase() === "style")) return true;
    return descendants(node).some((child) => visit(child, inside));
  };
  return visit(root, false) ? "Agent content cannot contain style." : undefined;
}

export function agentContentFromDraft(html: string):
  | { slots: Partial<Record<AgentZoneName | "headline" | "category", string>> }
  | { error: string } {
  const errors: string[] = [];
  const root = parse(html, { onParseError: (error) => errors.push(error.code) }) as unknown as HtmlNode;
  if (errors.length) return { error: `Comparison report HTML is malformed: ${errors[0]}.` };
  const markers = new Map<string, HtmlNode[]>();
  const visit = (node: HtmlNode): void => {
    for (const attr of node.attrs ?? []) {
      if (attr.name !== "data-agent-zone" && attr.name !== "data-agent-slot") continue;
      const key = `${attr.name}:${attr.value}`;
      markers.set(key, [...(markers.get(key) ?? []), node]);
    }
    for (const child of descendants(node)) visit(child);
  };
  visit(root);
  const expected = [
    ...AGENT_ZONES.map((name) => `data-agent-zone:${name}`),
    "data-agent-slot:headline", "data-agent-slot:category", "data-agent-slot:task",
  ];
  for (const key of markers.keys()) {
    if (!expected.includes(key)) return { error: `Comparison report contains unsupported ${key}.` };
  }
  for (const key of expected) {
    if (markers.get(key)?.length !== 1) return { error: `Comparison report requires exactly one ${key}.` };
    const node = markers.get(key)![0]!;
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
      if (parent.attrs?.some((attr) => attr.name === "data-agent-zone" || attr.name === "data-agent-slot")) {
        return { error: `Comparison report has nested Agent markers at ${key}.` };
      }
    }
    const nested = descendants(node).some(function hasMarker(child): boolean {
      return Boolean(child.attrs?.some((attr) => attr.name === "data-agent-zone" || attr.name === "data-agent-slot" || attr.name === "data-host-zone"))
        || descendants(child).some(hasMarker);
    });
    if (nested) return { error: `Comparison report has nested zone markers at ${key}.` };
    if (key.startsWith("data-agent-zone:")) {
      const unsafe = unsafeAgentContent(node);
      if (unsafe) return { error: unsafe };
    }
  }
  const textOf = (node: HtmlNode): string => node.value ?? (node.childNodes ?? []).map(textOf).join("");
  const innerOf = (node: HtmlNode): string => (node.childNodes ?? []).map((child) => serializeOuter(child as never)).join("");
  return { slots: {
    comparison: innerOf(markers.get("data-agent-zone:comparison")![0]!),
    details: innerOf(markers.get("data-agent-zone:details")![0]!),
    headline: escapeHtml(textOf(markers.get("data-agent-slot:headline")![0]!)),
    category: textOf(markers.get("data-agent-slot:category")![0]!),
  } };
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
  const header = slots.header ?? defaultHeader(labels, category, task, locale, input.diagnostic);
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
    ${renderMetricsBoard(input.metrics, labels, locale)}
  </article>
  <details class="details">
    <summary>${escapeHtml(reportString(locale, "detailsSummary"))}</summary>
    <section class="slot" data-agent-zone="details" data-id="agent-details"><!-- ${escapeHtml(reportString(locale, "detailsZoneComment"))} -->${detailsBody}</section>
    <p class="kicker cost-note" data-host-zone="cost-note" data-id="host-cost-note">${escapeHtml(reportString(locale, "costNote", { version: MODEL_PRICING_TABLE_VERSION }))}</p>
    <section class="slot" data-host-zone="evidence" data-id="host-evidence">${renderRunDiagnostics(input.facts, locale)}${renderEvidenceCatalog(input.evidence, locale)}${renderMediaCatalog(input.media, locale)}</section>
    <section class="slot" data-host-zone="process" data-id="host-process">${slots.process ?? (input.diagnostic ? diagnosticProcess(input.diagnostic, locale) : "")}</section>
  </details>
</main>
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
  locale?: AgentLocale;
}): string {
  const mapped = mapLegacyModelSlots(input.model);
  return renderComparisonReportShell({
    ...(input.diagnostic ? { title: "Comparison unavailable" } : {}),
    task: input.model.task,
    facts: input.facts,
    metrics: metricsFromReportFacts(input.facts),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.media ? { media: input.media } : {}),
    slots: {
      ...mapped,
      ...(input.model.headline ? { headline: escapeHtml(input.model.headline) } : {}),
    },
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
  });
}

/** Map legacy audit slots into format-2 comparison/details without rewriting on-disk models. */
function mapLegacyModelSlots(model: ComparisonReportModel): Partial<Record<AgentZoneName | HostZoneName | "headline" | "category" | "task", string>> {
  const slots = model.slots;
  const comparison = slots.comparison
    ?? [slots["visual-evidence"], slots["key-differences"]].filter(Boolean).join("");
  const details = slots.details
    ?? [slots.delivery, slots.limitations].filter(Boolean).join("");
  return {
    ...(slots.header ? { header: slots.header } : {}),
    ...(comparison ? { comparison } : {}),
    ...(details ? { details } : {}),
    ...(slots.process ? { process: slots.process } : {}),
    ...(slots.evidence ? { evidence: slots.evidence } : {}),
  };
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

export function hostZonesMismatch(html: string, snapshot: HostZoneSnapshot, metrics: {
  baseline?: MetricSideProjection;
  candidate?: MetricSideProjection;
}, locale: AgentLocale = "zh"): string | undefined {
  return hostZoneIntegrityError(html, snapshot) ?? hostMetricsMismatch(html, metrics, locale);
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
}, labels: { baseline: string; candidate: string }, locale: AgentLocale): string {
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
  locale: AgentLocale,
  diagnostic?: ComparisonReportDiagnostic,
): string {
  const kicker = diagnostic ? `<p class="kicker">Comparison · ${escapeHtml(diagnostic.failureClass)}</p>` : "";
  const vs = reportString(locale, "titleVs", { category: "", baseline: labels.baseline, candidate: labels.candidate })
    .replace(/^\s*·\s*/, "");
  return `${kicker}<h1><span data-agent-slot="category">${escapeHtml(category)}</span> · ${escapeHtml(vs)}</h1>
  <p class="sessions" data-host="session-labels"><span>${escapeHtml(reportString(locale, "sessionHistorical"))}</span><span>${escapeHtml(reportString(locale, "sessionCurrent"))}</span></p>
  <p class="field-label">${escapeHtml(reportString(locale, "taskLabel"))}</p>
  <p class="task" data-slot="task" data-agent-slot="task">${escapeHtml(task)}</p>`;
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

const REPORT_CSS = `
:root { --paper:#efe8dc; --card:#fffcf7; --ink:#1a1714; --soft:#5a544b; --faint:#8a8378; --line:rgba(26,23,20,.08); --hair:rgba(26,23,20,.12); --shadow:0 22px 50px rgba(40,32,18,.1); --accent:#5b4630; --risk:#8b2e2e; --ok:#2f5d3a; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--paper); color:var(--ink); font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Songti SC","Source Han Serif SC",serif; }
.page { max-width:980px; margin:0 auto; padding:36px 20px 72px; }
.share { background:var(--card); border:1px solid var(--line); border-radius:28px; box-shadow:var(--shadow); padding:28px 28px 24px; }
.share a { color:inherit; text-decoration:none; }
.kicker { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); margin:0 0 12px; }
h1 { font-size:28px; font-weight:650; letter-spacing:-.03em; line-height:1.2; margin:0 0 8px; }
.sessions { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0 12px; font-size:14px; color:var(--soft); }
.field-label { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:13px; color:var(--faint); margin:12px 0 4px; }
.task { margin:0 0 8px; font-size:16px; color:var(--soft); line-height:1.45; }
.note,[data-agent-slot="headline"] { margin:0 0 18px; font-size:16px; line-height:1.5; }
[data-agent-slot="headline"] strong,[data-component="diff-table"] strong,[data-claim] { font-weight:inherit; }
.board { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin: 8px 0 0; }
.card,.result-card,[data-host="diagnostic-card"],[data-component="difference-card"] { background:#f7f3ea; border-radius:18px; box-shadow:none; border:1px solid var(--line); padding:16px 16px 14px; }
.card { min-height:0; }
.card .label { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); margin-bottom:12px; }
.pair { display:grid; grid-template-columns:1fr 1fr; }
.col { padding-right:8px; }
.col + .col { padding-right:0; padding-left:12px; border-left:1px solid var(--hair); }
.who { font-family:"Segoe UI","PingFang SC",sans-serif; font-size:11px; letter-spacing:.08em; color:var(--faint); margin-bottom:4px; }
.num { font-variant-numeric:tabular-nums; font-size:28px; line-height:1; letter-spacing:-.03em; font-weight:600; }
.num.miss { font-size:16px; color:#b3ada2; letter-spacing:0; font-weight:500; white-space:nowrap; }
.unit { font-size:13px; font-weight:500; color:var(--soft); margin-left:2px; }
.muted,[data-component="muted"] { color:var(--faint); font-size:14px; }
.slot { margin-top:14px; }
.pages { display:flex; flex-direction:column; gap:14px; }
[data-component="page-row"] { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:stretch; }
.cell { border:1px solid var(--hair); border-radius:16px; overflow:hidden; background:#fff; }
.cell .who { padding:8px 12px 0; }
.cell img,[data-component="page-row"] img { width:100%; height:320px; object-fit:contain; object-position:top; display:block; background:#fff; }
[data-agent-zone="comparison"] { margin-top:0; margin-bottom:12px; }
[data-agent-zone="comparison"] p,[data-agent-zone="comparison"] li { font-size:14px; line-height:1.4; color:var(--soft); max-width:48em; }
[data-agent-zone="comparison"] [data-host="visual-unavailable"],[data-agent-zone="comparison"] [data-host="pairing-hint"] { margin:0 0 8px; font-size:14px; }
[data-agent-zone="comparison"] table,[data-component="diff-table"] { width:100%; border-collapse:collapse; margin:8px 0; }
[data-agent-zone="comparison"] th,[data-agent-zone="comparison"] td,[data-component="diff-table"] th,[data-component="diff-table"] td { border:none; padding:10px 8px; vertical-align:top; font-size:16px; font-weight:400; }
.details { margin-top:20px; color:var(--soft); background:var(--card); border:1px solid var(--line); border-radius:18px; padding:12px 18px 16px; }
.details > summary { cursor:pointer; font-family:"Segoe UI","PingFang SC",sans-serif; font-size:14px; color:var(--accent); list-style:none; }
.details > summary::-webkit-details-marker { display:none; }
.cost-note { margin: 12px 0 8px; }
[data-component="judgment"] { font-weight:700; }
[data-component="judgment"] { margin:0 0 16px; }
[data-host="diagnostic-card"] h3,[data-component="difference-card"] h3 { margin:0 0 8px; font-size:18px; }
[data-host="diagnostic-card"] p,[data-component="difference-card"] p { margin:0; color:var(--soft); }
[data-component="highlight"] { background:rgba(91,70,48,.12); padding:0 .2em; }
[data-component="strike"] { text-decoration:line-through; color:var(--soft); }
[data-component="quote"] { border-left:3px solid var(--hair); padding-left:12px; color:var(--soft); }
code,[data-component="code"] { font-family:"Cascadia Code","Sarasa Mono SC",monospace; font-size:.92em; }
[data-component="tag-improve"],[data-component="tag-tradeoff"],[data-component="tag-risk"] { display:inline-block; font-size:12px; letter-spacing:.04em; padding:2px 8px; border-radius:999px; }
[data-component="tag-improve"] { background:rgba(47,93,58,.12); color:var(--ok); }
[data-component="tag-tradeoff"] { background:rgba(91,70,48,.12); }
[data-component="tag-risk"] { background:rgba(139,46,46,.12); color:var(--risk); }
[data-component="diff-table"] .who { letter-spacing:0; text-transform:none; font-size:16px; }
[data-component="split-compare"] { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
[data-component="timeline"] { border-left:2px solid var(--hair); padding-left:16px; }
[data-component="media-compare"],[data-component="media-grid"] { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
[data-component="media-single"] img,[data-component="media-compare"] img,[data-component="media-grid"] img { max-width:100%; border-radius:12px; background:var(--card); }
.evidence-expand { margin-top:16px; }
.path-link { color:var(--accent); }
.kv-list { padding-left:18px; }
body[data-report="diagnostic"] .num.miss { font-size:16px; }
@media (max-width:760px) {
  .board,[data-component="split-compare"],[data-component="page-row"] { grid-template-columns:1fr; }
  .num { font-size:24px; }
  .task { white-space:normal; }
  .cell img,[data-component="page-row"] img { height:160px; }
}
@media print {
  .details { break-inside:avoid; }
  .share { box-shadow:none; }
}
`;
