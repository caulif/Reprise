import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonReportFacts, ComparisonResult } from "../agents/comparison-agent.js";
import {
  ComparisonReportModelSchema,
  type ComparisonLinkRecord,
  type ComparisonMediaRecord,
  type ComparisonReportModel,
} from "../core/schema.js";
import { writeAtomic } from "../core/identity.js";
import { isMissing } from "./experiment-helpers.js";
import type { AgentLocale } from "../agents/language.js";
import { candidateStatusLabel, reportString, type ComparisonReportStringKey } from "./comparison-report-strings.js";
import {
  AGENT_ZONES,
  agentZoneBlank,
  extractInner,
  extractOuter,
  hostMetricsMismatch,
  hostZonesMismatch,
  missingComparisonSlots,
  metricsFromReportFacts,
  type ComparisonReportDiagnostic,
  type HostZoneSnapshot,
} from "./comparison-report-shell.js";
import { renderVisualEvidenceSeed } from "./comparison-visual-evidence.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";

export type ComparisonFailureClass =
  | "provider"
  | "protocol"
  | "evidence"
  | "metrics"
  | "media"
  | "publication"
  | "cancelled"
  | "unknown";

export type ComparisonFailurePhase =
  | "understand"
  | "investigate"
  | "compose"
  | "review"
  | "publication";

export type ComparisonPublishCode =
  | "host_zone_modified"
  | "invalid_envelope"
  | "evidence_unresolved"
  | "media_unavailable"
  | "report_incomplete"
  | "publication_failed";

export function classifyComparisonFailure(input: {
  result: StructuredAgentResult<unknown>;
  reportPresent: boolean;
}): { failureClass: ComparisonFailureClass; phase: ComparisonFailurePhase } {
  if (input.result.status === "cancelled") {
    return { failureClass: "cancelled", phase: input.reportPresent ? "review" : "understand" };
  }
  const failed = input.result.status === "failed" ? input.result.failure : undefined;
  const message = failed?.message ?? "";
  const kind = failed?.kind ?? "";
  const code = failed?.code ?? "";
  if (kind === "authentication" || kind === "rate_limited" || kind === "transient_network" || kind === "transient_upstream" || /\b529\b/.test(message)) {
    return { failureClass: "provider", phase: input.reportPresent ? "review" : "compose" };
  }
  if (code === "invalid_envelope" || message === "invalid JSON" || message.startsWith("schema validation failed") || message.includes("invalid JSON")) {
    return { failureClass: "protocol", phase: "review" };
  }
  if (code === "host_zone_modified" || message.includes("Host zone") || message.includes("Host metrics") || message.includes("Host status")) {
    const metrics = message.includes("metrics") || message.includes("Host metrics") || message.includes("Host status");
    return { failureClass: metrics ? "metrics" : "publication", phase: "publication" };
  }
  if (code === "evidence_unresolved" || message.includes("unknown evidence")) {
    return { failureClass: "evidence", phase: "review" };
  }
  if (code === "media_unavailable") {
    return { failureClass: "media", phase: "publication" };
  }
  if (code === "report_incomplete" || code === "publication_failed" || message.includes("without writing report.html")) {
    return { failureClass: "publication", phase: code === "report_incomplete" ? "compose" : "publication" };
  }
  return { failureClass: "unknown", phase: input.reportPresent ? "review" : "compose" };
}

export async function verifyAndRenderComparisonReport(input: {
  html: string;
  facts: ComparisonReportFacts;
  result: ComparisonResult;
  attemptRoot: string;
  media: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
  hostZoneSnapshot?: HostZoneSnapshot;
  locale?: AgentLocale;
  /**
   * When set (including empty), `data-claim="visual"` also requires the cited media
   * `contentHash` to appear in this Session's delivered native-image set.
   * Bare `<img data-media-ref>` for human readers does not need delivery.
   */
  deliveredImageContentHashes?: ReadonlySet<string>;
}): Promise<
  { html: string; model: ComparisonReportModel }
  | { failureClass: ComparisonFailureClass; code: ComparisonPublishCode; message: string }
> {
  const locale = input.locale ?? "zh";
  const metrics = metricsFromReportFacts(input.facts);
  const zoneError = input.hostZoneSnapshot
    ? hostZonesMismatch(input.html, input.hostZoneSnapshot, metrics, locale)
    : missingComparisonSlots(input.html) ?? hostMetricsMismatch(input.html, metrics, locale);
  if (zoneError) {
    const incompleteSlot = /missing data-(?:agent|host)-zone|missing data-agent-slot|missing component template|Share card order|outside the share card|data-report-format/.test(zoneError);
    const code: ComparisonPublishCode = incompleteSlot ? "report_incomplete" : "host_zone_modified";
    return { failureClass: code === "report_incomplete" ? "publication" : "metrics", code, message: zoneError };
  }
  const unexpected = unexpectedAgentZones(input.html);
  if (unexpected) return { failureClass: "publication", code: "report_incomplete", message: unexpected };
  const structuredEvidence = claimsVerifiedWithoutResolvableEvidence(input.html, input.evidence ?? []);
  if (structuredEvidence) return { failureClass: "evidence", code: "evidence_unresolved", message: structuredEvidence };
  const structuredVisual = claimsVisualWithoutUsableMedia(input.html, input.media, input.deliveredImageContentHashes);
  if (structuredVisual) return { failureClass: "media", code: "media_unavailable", message: structuredVisual };
  const rewritten = await rewritePublishableHtml(input);
  if (hasExternalNetwork(rewritten.html)) {
    return { failureClass: "publication", code: "publication_failed", message: "Comparison report contains external network resources." };
  }
  let html = rewritten.html;
  const limitations: ComparisonReportStringKey[] = [];
  const visual = repairEmptyComparisonZone(html, input.media, locale);
  html = visual.html;
  const incomplete = repairIncompleteAboveTheFold(html, input.result.headline, locale);
  html = incomplete.html;
  limitations.push(...incomplete.limitations);
  const leaked = repairLeakedInternalRunInfo(html);
  html = leaked.html;
  limitations.push(...leaked.limitations);
  const presentation = repairShareCardPresentation(html, locale);
  html = presentation.html;
  limitations.push(...presentation.limitations);
  if (claimsVerifiedWithoutEvidence(html, rewritten.unresolvedEvidence, locale) && rewritten.unresolvedEvidence.length > 0) {
    limitations.push("hostLimitationVerifiedWordlist");
  }
  if (wordlistVerifiedWithoutResolvableEvidence(html, input.evidence ?? [], locale)) {
    limitations.push("hostLimitationVerifiedWordlist");
  }
  if (claimsVisualWithoutMedia(html, input.media, locale)) {
    limitations.push("hostLimitationVisualWordlist");
  }
  if (citedMediaAllUnresolved(html, rewritten.unresolvedMedia, locale)) {
    limitations.push("hostLimitationCitedMediaUnresolved");
  }
  const unpaired = unpairedShareCardImages(html, input.media);
  if (unpaired === "missing_note") {
    limitations.push("hostLimitationOneSidedMissingNote");
  } else if (unpaired === "one_sided") {
    limitations.push("hostLimitationUnpairedImages");
  }
  html = markUnresolvedInHostEvidence(html, [...rewritten.unresolvedEvidence, ...rewritten.unresolvedMedia], locale);
  html = appendHostLimitations(html, locale, limitations);
  if (agentZoneBlank(html, "comparison")) {
    return {
      failureClass: "publication",
      code: "report_incomplete",
      message: 'Agent comparison zone is empty; fill data-agent-zone="comparison" with the task comparison (comments alone do not count).',
    };
  }
  const model = comparisonReportModelFromHtml(html, input.facts, input.result, input.media, input.evidence, locale);
  return { html, model };
}

export async function persistComparisonReportModel(root: string, model: ComparisonReportModel): Promise<void> {
  if (!Value.Check(ComparisonReportModelSchema, model)) throw new Error("Comparison report model does not satisfy ComparisonReportModelSchema.");
  await writeAtomic(join(root, "report-model.json"), `${JSON.stringify(model)}\n`);
}

export async function publishComparisonArtifacts(input: {
  attemptRoot: string;
  experimentRoot: string;
  html: string;
  media?: readonly ComparisonMediaRecord[];
  model?: ComparisonReportModel;
}): Promise<{ html: string }> {
  const staged = await stagePublishedMedia({
    attemptRoot: input.attemptRoot,
    experimentRoot: input.experimentRoot,
    html: input.html,
    media: input.media ?? [],
  });
  if (input.model) {
    await persistComparisonReportModel(
      input.experimentRoot,
      rewriteReportModelMediaHrefs(input.model, staged.hrefMap),
    );
  }
  await writeAtomic(join(input.experimentRoot, "report.html"), staged.html);
  return { html: staged.html };
}

async function stagePublishedMedia(input: {
  attemptRoot: string;
  experimentRoot: string;
  html: string;
  media: readonly ComparisonMediaRecord[];
}): Promise<{ html: string; hrefMap: ReadonlyMap<string, string> }> {
  const mediaRoot = join(input.experimentRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  const byHref = new Map(input.media.map((item) => [item.reportHref.replaceAll("\\", "/").replace(/^\.\//, ""), item]));
  let html = input.html;
  const published = new Map<string, string>();
  for (const href of mediaHrefs(html)) {
    if (href.startsWith("#")) continue;
    if (href.startsWith("data:")) {
      throw new Error("Comparison report contains unregistered data URL media.");
    }
    if (/^(https?:|\/\/)/i.test(href)) {
      throw new Error("Comparison report contains external network resources.");
    }
    const normalized = href.replaceAll("\\", "/").replace(/^\.\//, "");
    if (published.has(normalized)) {
      html = rewriteMediaHref(html, href, published.get(normalized)!);
      continue;
    }
    const record = byHref.get(normalized);
    if (!record?.available) {
      throw new Error(`Comparison media reference is not publishable: ${normalized}`);
    }
    const source = resolve(input.attemptRoot, ...normalized.split("/"));
    const attemptRootResolved = resolve(input.attemptRoot);
    const rel = relative(attemptRootResolved, source);
    if (!rel || rel.startsWith("..") || rel.includes("..")) {
      throw new Error(`Comparison media path escapes attempt root: ${normalized}`);
    }
    const bytes = await readFile(source);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    const extension = extname(basename(normalized)) || extensionForMediaType(record.mediaType);
    const publishedHref = `media/${digest}${extension}`;
    const destination = join(input.experimentRoot, publishedHref);
    await mkdir(join(input.experimentRoot, "media"), { recursive: true });
    try {
      await copyFile(source, destination);
    } catch (error) {
      if (!isMissing(error)) throw error;
      throw new Error(`Comparison media file missing at publish time: ${normalized}`, { cause: error });
    }
    published.set(normalized, publishedHref);
    html = rewriteMediaHref(html, href, publishedHref);
  }
  return { html, hrefMap: published };
}

function rewriteReportModelMediaHrefs(
  model: ComparisonReportModel,
  hrefMap: ReadonlyMap<string, string>,
): ComparisonReportModel {
  if (hrefMap.size === 0) return model;
  const slots: ComparisonReportModel["slots"] = { ...model.slots };
  for (const key of Object.keys(slots) as (keyof ComparisonReportModel["slots"])[]) {
    const value = slots[key];
    if (typeof value !== "string") continue;
    let next = value;
    for (const [from, to] of hrefMap) next = rewriteMediaHref(next, from, to);
    slots[key] = next;
  }
  return { ...model, slots };
}

function rewriteMediaHref(html: string, from: string, to: string): string {
  const escaped = escapeRegExp(from);
  return html
    .replace(new RegExp(`(\\b(?:src|href)\\s*=\\s*["'])${escaped}(["'])`, "gi"), `$1${to}$2`)
    .replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "gi"), `url($1${to}$1)`);
}

function extensionForMediaType(mediaType: string): string {
  if (/svg/i.test(mediaType)) return ".svg";
  if (/webp/i.test(mediaType)) return ".webp";
  if (/gif/i.test(mediaType)) return ".gif";
  if (/jpe?g/i.test(mediaType)) return ".jpg";
  return ".png";
}

export function comparisonReportModelFromHtml(
  html: string,
  facts: ComparisonReportFacts,
  result: ComparisonResult,
  media: readonly ComparisonMediaRecord[],
  evidence: readonly ComparisonLinkRecord[] = [],
  locale: AgentLocale = "zh",
): ComparisonReportModel {
  const slots = {
    header: extractInner(html, "data-host-zone", "header"),
    comparison: extractInner(html, "data-agent-zone", "comparison"),
    details: extractInner(html, "data-agent-zone", "details"),
    evidence: extractInner(html, "data-host-zone", "evidence"),
    process: extractInner(html, "data-host-zone", "process"),
  };
  const evidenceRefs = result.evidenceRefs.flatMap((short) => {
    const hit = evidence.find((item) => item.shortRef === short)?.evidenceRef;
    return hit ? [hit] : [];
  });
  const mediaRefs = media.filter((item) => html.includes(item.reportHref) || (item.shortRef && html.includes(item.shortRef))).map((item) => item.ref);
  const slotHeadline = oneLineFromHtml(extractInner(html, "data-agent-slot", "headline"));
  const headline = result.headline ?? (slotHeadline.length > 0 && slotHeadline.length <= 280 ? slotHeadline : undefined);
  return {
    schemaVersion: 1,
    formatVersion: 2,
    task: oneLineFromHtml(extractInner(html, "data-agent-slot", "task")) || oneLineFromHtml(extractInner(html, "data-slot", "task")) || reportString(locale, "defaultCategory"),
    status: {
      baseline: facts.replay.baselineEvidence,
      candidate: candidateStatusLabel(facts.run.outcome, facts.run.terminationCode, locale),
      candidateOutcome: facts.run.outcome,
      terminationCode: facts.run.terminationCode,
    },
    ...(facts.metrics ? { metrics: facts.metrics } : {}),
    slots,
    evidenceRefs,
    mediaRefs,
    ...(headline ? { headline } : {}),
  };
}

export function comparisonFailureDiagnostic(input: {
  result: StructuredAgentResult<unknown>;
  facts: ComparisonReportFacts;
  reportPresent: boolean;
  attemptId: string;
  draftHtml?: string;
  locale?: AgentLocale;
}): ComparisonReportDiagnostic {
  const classified = classifyComparisonFailure(input);
  const failed = input.result.status === "failed" ? input.result.failure : undefined;
  const draftAnalysis = input.draftHtml ? extraAgentAnalysis(input.draftHtml) : undefined;
  const locale = input.locale ?? "zh";
  return {
    failureClass: classified.failureClass,
    phase: classified.phase,
    candidateCompleted: candidateStatusLabel(input.facts.run.outcome, input.facts.run.terminationCode, locale),
    reason: failed?.message
      ?? (input.result.status === "cancelled" ? "Comparison was cancelled." : "Comparison did not return a completed report."),
    details: [
      `failureClass=${classified.failureClass}`,
      `phase=${classified.phase}`,
      failed ? `code=${failed.code}` : "code=none",
      failed?.kind ? `kind=${failed.kind}` : "kind=none",
    ],
    traces: [
      `attempt=${input.attemptId}`,
      "trace: experiment events and comparison.json",
      "artifacts: comparison-attempts/ and evidence/",
      input.reportPresent ? "draft: comparison-attempts/*/report.html" : "draft: none",
    ],
    ...(draftAnalysis ? { draftAnalysis } : {}),
  };
}

export function draftAgentSlots(html: string | undefined): Partial<Record<(typeof AGENT_ZONES)[number] | "headline", string>> {
  if (!html) return {};
  const slots: Partial<Record<(typeof AGENT_ZONES)[number] | "headline", string>> = {};
  const headline = extractInner(html, "data-agent-slot", "headline");
  if (oneLineFromHtml(headline)) slots.headline = headline;
  for (const zone of AGENT_ZONES) {
    const inner = extractInner(html, "data-agent-zone", zone);
    if (oneLineFromHtml(inner)) slots[zone] = inner;
  }
  return slots;
}

function extraAgentAnalysis(html: string): string | undefined {
  const chunks: string[] = [];
  for (const match of html.matchAll(/<(?:section|article|div)\b[^>]*data-agent-zone=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:section|article|div)>/gi)) {
    const zone = match[1] ?? "";
    if ((AGENT_ZONES as readonly string[]).includes(zone)) continue;
    const text = oneLineFromHtml(match[2] ?? "");
    if (text) chunks.push(`${zone}: ${text.slice(0, 1000)}`);
  }
  return chunks.length ? chunks.join("\n") : undefined;
}

/** Shared publish/preview preprocessing: resolve short refs, strip broken media, drop external attrs. */
export async function preparePublishableComparisonHtml(input: {
  html: string;
  attemptRoot: string;
  media: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
}): Promise<{ html: string; unresolvedEvidence: string[]; unresolvedMedia: string[] }> {
  return rewritePublishableHtml(input);
}

async function rewritePublishableHtml(input: {
  html: string;
  attemptRoot: string;
  media: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
}): Promise<{ html: string; unresolvedEvidence: string[]; unresolvedMedia: string[] }> {
  const evidenceByShort = new Map((input.evidence ?? []).filter((item) => item.shortRef).map((item) => [item.shortRef as string, item]));
  const mediaByShort = new Map(input.media.filter((item) => item.shortRef).map((item) => [item.shortRef as string, item]));
  const unresolvedEvidence: string[] = [];
  const unresolvedMedia: string[] = [];
  let html = rewriteAgentZones(input.html, (zone) => {
    let next = zone;
    next = next.replace(/<a\b([^>]*)\bdata-evidence-ref="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi, (_all: string, pre: string, ref: string, post: string, text: string) => {
      const link = evidenceByShort.get(ref);
      const href = link?.reportHref ?? link?.inspectPath;
      if (!href) {
        unresolvedEvidence.push(ref);
        return text;
      }
      return `<a href="${escapeAttr(href)}"${pre}${post}>${text}</a>`;
    });
    next = next.replace(/<img\b([^>]*)\bdata-media-ref="([^"]+)"([^>]*)>/gi, (_all: string, pre: string, ref: string, post: string) => {
      const record = mediaByShort.get(ref);
      if (!record?.available) {
        unresolvedMedia.push(ref);
        return imgFallback(`${pre}${post}`);
      }
      return `<img src="${escapeAttr(record.reportHref)}"${pre}${post}>`;
    });
    return next;
  });
  html = await stripBrokenMedia(html, input.attemptRoot, input.media, unresolvedMedia);
  html = stripExternalAttributes(html);
  return { html, unresolvedEvidence: unique(unresolvedEvidence), unresolvedMedia: unique(unresolvedMedia) };
}

function rewriteAgentZones(html: string, rewrite: (inner: string) => string): string {
  let next = html;
  for (const zone of AGENT_ZONES) {
    const outer = extractOuter(next, "data-agent-zone", zone);
    const inner = extractInner(next, "data-agent-zone", zone);
    if (!outer || !inner) continue;
    next = next.replace(outer, outer.replace(inner, rewrite(inner)));
  }
  return next;
}

function replaceZoneInner(html: string, attr: string, name: string, nextInner: string): string {
  const outer = extractOuter(html, attr, name);
  if (!outer) return html;
  const open = outer.match(new RegExp(`^<(${ZONE_TAG})\\b[^>]*>`, "i"));
  if (!open) return html;
  const tag = open[1] ?? "section";
  return html.replace(outer, `${open[0]}${nextInner}</${tag}>`);
}

const ZONE_TAG = "header|section|style|p|span";

function appendHostLimitations(html: string, locale: AgentLocale, keys: readonly ComparisonReportStringKey[]): string {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return html;
  const outer = extractOuter(html, "data-agent-zone", "comparison");
  if (!outer) return html;
  const notes = uniqueKeys.map((key) => `<p data-host-limitation>${escapeText(reportString(locale, key))}</p>`).join("");
  return html.replace(outer, outer.replace(/<\/section>\s*$/i, `${notes}</section>`));
}

function repairEmptyComparisonZone(
  html: string,
  media: readonly ComparisonMediaRecord[],
  locale: AgentLocale,
): { html: string; limitations: ComparisonReportStringKey[] } {
  if (!agentZoneBlank(html, "comparison")) return { html, limitations: [] };
  const seeded = renderVisualEvidenceSeed(media, locale);
  if (!seeded) return { html, limitations: [] };
  return {
    html: replaceZoneInner(html, "data-agent-zone", "comparison", seeded),
    limitations: [],
  };
}

function repairIncompleteAboveTheFold(
  html: string,
  envelopeHeadline: string | undefined,
  locale: AgentLocale,
): { html: string; limitations: ComparisonReportStringKey[] } {
  const limitations: ComparisonReportStringKey[] = [];
  let next = html;
  if (!oneLineFromHtml(extractInner(next, "data-agent-slot", "headline"))) {
    const fromEnvelope = envelopeHeadline?.trim() ?? "";
    if (fromEnvelope) next = replaceZoneInner(next, "data-agent-slot", "headline", escapeText(fromEnvelope));
    else limitations.push("hostLimitationHeadlineMissing");
  }
  if (agentZoneBlank(next, "comparison")) {
    next = replaceZoneInner(
      next,
      "data-agent-zone",
      "comparison",
      `<p>${escapeText(reportString(locale, "hostLimitationCannotDetermine"))}</p>`,
    );
  }
  return { html: next, limitations };
}

function stripInternalRunTokens(value: string): string {
  return value
    .replace(/\battemptId\b|\brunId\b|comparison-attempts\/|\\runs\\/gi, "")
    .replace(/attempt-[a-z0-9-]{8,}/gi, "");
}

function repairLeakedInternalRunInfo(html: string): { html: string; limitations: ComparisonReportStringKey[] } {
  let next = html;
  for (const [attr, name] of [
    ["data-agent-slot", "headline"],
    ["data-agent-zone", "comparison"],
  ] as const) {
    const inner = extractInner(next, attr, name);
    if (!inner) continue;
    const stripped = stripInternalRunTokens(inner);
    if (stripped !== inner) next = replaceZoneInner(next, attr, name, stripped);
  }
  return { html: next, limitations: leakedInternalRunInfo(next) ? ["hostLimitationLeakedInternal"] : [] };
}

function unwrapTag(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "").replace(new RegExp(`</${tag}>`, "gi"), "");
}

function applyShareCardPresentationFixes(html: string, locale: AgentLocale): string {
  let next = html;
  const headline = extractInner(next, "data-agent-slot", "headline");
  if (/<strong\b/i.test(headline)) {
    next = replaceZoneInner(next, "data-agent-slot", "headline", unwrapTag(headline, "strong"));
  }
  const style = extractInner(next, "data-host-zone", "style");
  if (style && !/\.share\s+a\s*\{[^}]*text-decoration\s*:\s*none/i.test(style)) {
    next = replaceZoneInner(next, "data-host-zone", "style", `${style}\n.share a { color:inherit; text-decoration:none; }`);
  }
  const share = shareArticleHtml(next);
  if (share) {
    const shareFixed = share
      .replace(/\sstyle=(["'])[^"']*text-decoration\s*:\s*underline[^"']*\1/gi, "")
      .replace(/<u\b[^>]*>/gi, "")
      .replace(/<\/u>/gi, "");
    if (shareFixed !== share) next = next.replace(share, shareFixed);
  }
  next = next.replace(/<summary[^>]*>\s*(价格与证据|Prices and evidence)\s*<\/summary>/gi, "");
  next = next.replace(/本卡由/g, "").replace(/Written by /gi, "");
  const historical = reportString(locale, "sessionHistorical");
  const current = reportString(locale, "sessionCurrent");
  for (const [attr, name] of [
    ["data-agent-slot", "headline"],
    ["data-agent-zone", "comparison"],
  ] as const) {
    const inner = extractInner(next, attr, name);
    if (!inner) continue;
    const replaced = inner.replaceAll("历史侧", historical).replaceAll("候选侧", current);
    if (replaced !== inner) next = replaceZoneInner(next, attr, name, replaced);
  }
  return next;
}

function repairShareCardPresentation(html: string, locale: AgentLocale): { html: string; limitations: ComparisonReportStringKey[] } {
  let next = applyShareCardPresentationFixes(html, locale);
  if (!shareCardPresentationError(next, locale)) return { html: next, limitations: [] };
  next = applyShareCardPresentationFixes(next, locale);
  return { html: next, limitations: shareCardPresentationError(next, locale) ? ["hostLimitationShareCardPresentation"] : [] };
}

function unexpectedAgentZones(html: string): string | undefined {
  const found = [...html.matchAll(/\bdata-agent-zone\s*=\s*(["'])([^"']+)\1/gi)].map((match) => match[2] ?? "");
  const extra = found.find((zone) => zone && !(AGENT_ZONES as readonly string[]).includes(zone));
  if (!extra) return undefined;
  return `Comparison report contains unsupported data-agent-zone="${extra}".`;
}

function shareCardPresentationError(html: string, locale: AgentLocale): string | undefined {
  const headline = extractInner(html, "data-agent-slot", "headline");
  if (/<strong\b/i.test(headline)) return "Headline must not contain <strong>.";
  const style = extractInner(html, "data-host-zone", "style");
  if (!/\.share\s+a\s*\{[^}]*text-decoration\s*:\s*none/i.test(style)) {
    return "Share card links must not use underline.";
  }
  const share = shareArticleHtml(html);
  for (const anchor of share.match(/<a\b[^>]*>/gi) ?? []) {
    if (/text-decoration\s*:\s*underline/i.test(anchor)) return "Share card links must not use underline.";
  }
  if (/<u\b/i.test(share)) return "Share card links must not use underline.";
  const page = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<template[\s\S]*?<\/template>/gi, " ");
  if (/<summary[^>]*>\s*(价格与证据|Prices and evidence)\s*<\/summary>/i.test(page)) {
    return "Share card must not show a prices-and-evidence summary.";
  }
  if (/本卡由|Written by /i.test(page)) return "Share card must not print who wrote the card.";
  const visible = share.replace(/<!--[\s\S]*?-->/g, " ");
  if (/历史侧|候选侧/.test(visible)) return "Share card must not use 历史侧 or 候选侧.";
  const labels = locale === "en"
    ? ["Task", "Main conclusion", "Historical session", "Current session"] as const
    : ["任务描述", "主要结论", "历史会话", "当前会话"] as const;
  for (const label of labels) {
    if (!visible.includes(label)) return `Share card is missing Host label "${label}".`;
  }
  return undefined;
}

function shareArticleHtml(html: string): string {
  const match = html.match(/<article\b[^>]*\bclass=["'][^"']*\bshare\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i);
  return match?.[1] ?? "";
}

function leakedInternalRunInfo(html: string): string | undefined {
  const fold = `${extractInner(html, "data-host-zone", "header")}${extractInner(html, "data-agent-slot", "headline")}${extractInner(html, "data-agent-zone", "comparison")}`;
  if (/\battemptId\b|\brunId\b|comparison-attempts\/|\\runs\\/i.test(fold) || /attempt-[a-z0-9-]{8,}/i.test(fold)) {
    return "Comparison above-the-fold content contains internal run identifiers.";
  }
  const turns = fold.match(/第\s*[一二三四五六七八九十0-9]+\s*轮/g) ?? [];
  if (turns.length >= 5) return "Comparison above-the-fold restates the full process.";
  return undefined;
}

function claimsVisualWithoutMedia(html: string, media: readonly ComparisonMediaRecord[], locale: AgentLocale): string | undefined {
  if (media.some((item) => item.available)) return undefined;
  const body = extractInner(html, "data-agent-zone", "comparison");
  const pattern = locale === "en"
    ? /(visual inspection|looked at (?:the )?(?:PPT|slides|page|UI)|completed visual)/i
    : /(已完成视觉|看过(?:了)?(?:PPT|幻灯片|网页|UI)|视觉检查)/;
  if (pattern.test(body)) {
    return "Comparison claimed visual inspection without available media.";
  }
  return undefined;
}

function verifiedWordlist(locale: AgentLocale): RegExp {
  return locale === "en" ? /\bverified\b/i : /已核验|已经核验|\bverified\b/i;
}

function claimsVerifiedWithoutEvidence(html: string, unresolved: readonly string[], locale: AgentLocale): boolean {
  const body = extractInner(html, "data-agent-zone", "comparison");
  if (!verifiedWordlist(locale).test(body)) return false;
  const cited = unique([...body.matchAll(/\bdata-evidence-ref="([^"]+)"/gi)].map((match) => match[1] ?? "").filter(Boolean));
  if (cited.length === 0) return false;
  const missing = new Set(unresolved);
  return cited.every((ref) => missing.has(ref));
}

function wordlistVerifiedWithoutResolvableEvidence(
  html: string,
  evidence: readonly ComparisonLinkRecord[],
  locale: AgentLocale,
): boolean {
  const body = extractInner(html, "data-agent-zone", "comparison");
  if (!verifiedWordlist(locale).test(body)) return false;
  const cited = unique([...body.matchAll(/\bdata-evidence-ref="([^"]+)"/gi)].map((match) => match[1] ?? "").filter(Boolean));
  const resolvable = new Set(evidence.filter((item) => item.shortRef && (item.reportHref || item.inspectPath)).map((item) => item.shortRef as string));
  if (cited.some((ref) => resolvable.has(ref))) return false;
  return true;
}

function claimsVerifiedWithoutResolvableEvidence(html: string, evidence: readonly ComparisonLinkRecord[]): string | undefined {
  const resolvable = (ref: string) => evidence.some((item) => item.shortRef === ref && Boolean(item.reportHref || item.inspectPath));
  if (claimMissingResolvedRef(html, "verified", "data-evidence-ref", resolvable)) {
    return "Comparison claimed verification without resolvable evidence.";
  }
  return undefined;
}

function claimsVisualWithoutUsableMedia(
  html: string,
  media: readonly ComparisonMediaRecord[],
  deliveredImageContentHashes?: ReadonlySet<string>,
): string | undefined {
  const usable = (ref: string) => {
    const item = media.find((record) => (record.shortRef === ref || record.ref === ref) && record.available);
    if (!item) return false;
    if (!deliveredImageContentHashes) return true;
    return Boolean(item.contentHash && deliveredImageContentHashes.has(item.contentHash));
  };
  if (claimMissingResolvedRef(html, "visual", "data-media-ref", usable)) {
    if (deliveredImageContentHashes && media.some((item) => item.available)) {
      return "Comparison claimed visual inspection without session-delivered media.";
    }
    return "Comparison claimed visual inspection without available media.";
  }
  return undefined;
}

const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source"]);

function claimMissingResolvedRef(
  html: string,
  kind: "verified" | "visual",
  attr: "data-evidence-ref" | "data-media-ref",
  resolve: (ref: string) => boolean,
): boolean {
  const claimRe = new RegExp(`\\bdata-claim\\s*=\\s*(["'])${kind}\\1`, "gi");
  let match: RegExpExecArray | null;
  while ((match = claimRe.exec(html))) {
    if (insideHtmlComment(html, match.index)) continue;
    const tagStart = html.lastIndexOf("<", match.index);
    const tagEnd = html.indexOf(">", match.index);
    if (tagStart < 0 || tagEnd < 0) continue;
    const open = html.slice(tagStart, tagEnd + 1);
    const name = open.match(/^<\/?([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase() ?? "span";
    let elementEnd = tagEnd + 1;
    if (!open.endsWith("/>") && !VOID_TAGS.has(name)) {
      elementEnd = matchingClose(html, name, tagEnd + 1) ?? tagEnd + 1;
    }
    const element = html.slice(tagStart, elementEnd);
    const own = [...element.matchAll(new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']+)\\1`, "gi"))].map((hit) => hit[2] ?? "");
    const ancestors = ancestorAttribute(html, tagStart, attr);
    const trailing = trailingCitationRefs(html, elementEnd, attr);
    const refs = unique([...own, ...ancestors, ...trailing]);
    if (refs.length === 0 || !refs.some(resolve)) return true;
  }
  return false;
}

function insideHtmlComment(html: string, pos: number): boolean {
  const open = html.lastIndexOf("<!--", pos);
  if (open < 0) return false;
  const close = html.lastIndexOf("-->", pos);
  return open > close;
}

function matchingClose(html: string, name: string, from: number): number | undefined {
  const re = new RegExp(`<(/)?${escapeRegExp(name)}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let found: RegExpExecArray | null;
  while ((found = re.exec(html))) {
    if (found[1]) {
      depth -= 1;
      if (depth === 0) return re.lastIndex;
    } else if (!found[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return undefined;
}

function trailingCitationRefs(html: string, from: number, attr: "data-evidence-ref" | "data-media-ref"): string[] {
  const refs: string[] = [];
  let pos = from;
  const skip = /[\s\u3000（）()[\]【】、,，:：;；]/;
  while (pos < html.length) {
    while (pos < html.length && skip.test(html[pos]!)) pos += 1;
    if (html[pos] !== "<") break;
    const tagEnd = html.indexOf(">", pos);
    if (tagEnd < 0) break;
    const open = html.slice(pos, tagEnd + 1);
    if (open.startsWith("</")) break;
    const name = open.match(/^<([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase();
    if (name !== "a" && name !== "img") break;
    const hits = [...open.matchAll(new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']+)\\1`, "gi"))].map((hit) => hit[2] ?? "").filter(Boolean);
    if (hits.length === 0) break;
    refs.push(...hits);
    if (name === "img" || open.endsWith("/>") || VOID_TAGS.has(name)) {
      pos = tagEnd + 1;
      continue;
    }
    pos = matchingClose(html, name, tagEnd + 1) ?? tagEnd + 1;
  }
  return unique(refs);
}

function ancestorAttribute(html: string, pos: number, attr: string): string[] {
  const stack: string[] = [];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let found: RegExpExecArray | null;
  while ((found = re.exec(html)) && found.index < pos) {
    if (found[0].startsWith("<!--")) continue;
    const name = found[1]!.toLowerCase();
    const attrs = found[2] ?? "";
    const closing = found[0].startsWith("</");
    const selfClosing = found[0].endsWith("/>") || VOID_TAGS.has(name);
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]!.startsWith(`${name}\0`)) {
          stack.length = index;
          break;
        }
      }
    } else if (!selfClosing) {
      stack.push(`${name}\0${attrs}`);
    }
  }
  const refs: string[] = [];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const attrs = stack[index]!.slice(stack[index]!.indexOf("\0") + 1);
    const hit = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']*)\\1`, "i"));
    if (hit?.[2]) refs.push(hit[2]);
  }
  return refs;
}

function unpairedShareCardImages(
  html: string,
  media: readonly ComparisonMediaRecord[],
): "one_sided" | "missing_note" | undefined {
  const face = `${extractInner(html, "data-host-zone", "header")}${extractInner(html, "data-agent-slot", "headline")}${extractInner(html, "data-agent-zone", "comparison")}`;
  const imgs = [...face.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0] ?? "");
  if (imgs.length === 0) return undefined;
  const byShort = new Map(media.filter((item) => item.shortRef).map((item) => [item.shortRef as string, item]));
  const byHref = new Map(media.map((item) => [item.reportHref.replaceAll("\\", "/"), item]));
  const sides = new Set<"baseline" | "candidate">();
  for (const img of imgs) {
    const ref = img.match(/\bdata-media-ref=["']([^"']+)["']/i)?.[1];
    const src = img.match(/\bsrc=["']([^"']+)["']/i)?.[1]?.replaceAll("\\", "/").replace(/^\.\//, "");
    const record = (ref ? byShort.get(ref) : undefined)
      ?? (src ? byHref.get(src) : undefined);
    if (record?.side === "baseline" || record?.side === "candidate") sides.add(record.side);
  }
  if (sides.size === 2) return undefined;
  if (sides.size === 0) return undefined;
  const hasMissingNote = /data-host="visual-unavailable"|data-host-limitation|缺失|missing|未能恢复|could not be recovered|unrecoverable|unavailable/i.test(face);
  return hasMissingNote ? "one_sided" : "missing_note";
}

function citedMediaAllUnresolved(html: string, unresolved: readonly string[], locale: AgentLocale): boolean {
  if (unresolved.length === 0) return false;
  const body = extractInner(html, "data-agent-zone", "comparison");
  if (!verifiedWordlist(locale).test(body)) return false;
  const cited = unique([...body.matchAll(/\bdata-media-ref="([^"]+)"/gi)].map((match) => match[1] ?? "").filter(Boolean));
  if (cited.length === 0) return false;
  const missing = new Set(unresolved);
  return cited.every((ref) => missing.has(ref));
}

function markUnresolvedInHostEvidence(html: string, unresolved: readonly string[], locale: AgentLocale): string {
  if (unresolved.length === 0) return html;
  const outer = extractOuter(html, "data-host-zone", "evidence");
  if (!outer) return html;
  if (outer.includes('data-host="unresolved-evidence"')) return html;
  const refs = unresolved.join(locale === "zh" ? "、" : ", ");
  const note = `<p data-host="unresolved-evidence">${escapeText(reportString(locale, "unresolvedEvidence", { refs }))}</p>`;
  return html.replace(outer, outer.replace(/<\/section>\s*$/i, `${note}</section>`));
}

async function stripBrokenMedia(
  html: string,
  attemptRoot: string,
  media: readonly ComparisonMediaRecord[],
  unresolved: string[],
): Promise<string> {
  const allowed = new Map(media.map((item) => [item.reportHref.replaceAll("\\", "/"), item]));
  let next = html;
  for (const href of mediaHrefs(html)) {
    if (href.startsWith("#")) continue;
    if (href.startsWith("data:")) {
      unresolved.push(href.slice(0, 32));
      next = next.replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${escapeRegExp(href)}["'][^>]*>`, "gi"), "");
      continue;
    }
    const normalized = href.replaceAll("\\", "/").replace(/^\.\//, "");
    const item = allowed.get(normalized);
    const readable = item?.available ? await fileReadable(attemptRoot, normalized) : false;
    if (readable) continue;
    unresolved.push(item?.shortRef ?? href);
    next = next.replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${escapeRegExp(href)}["'][^>]*>`, "gi"), "");
  }
  return next;
}

async function fileReadable(root: string, relative: string): Promise<boolean> {
  try {
    await readFile(resolve(root, ...relative.split("/")));
    return true;
  } catch {
    return false;
  }
}

function imgFallback(attrs: string): string {
  const alt = attrs.match(/\balt=["']([^"']*)["']/i)?.[1];
  return alt ? escapeText(alt) : "";
}

function stripExternalAttributes(html: string): string {
  return html
    .replace(/\s(?:src|href)=["']https?:[^"']*["']/gi, "")
    .replace(/\s(?:src|href)=["']\/\/[^"']*["']/gi, "");
}

function hasExternalNetwork(html: string): boolean {
  return /<(?:img|script|link|iframe|source|video|audio)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i.test(html)
    || /url\(\s*["']?https?:/i.test(html);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mediaHrefs(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<(?:img|source|video|image)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    found.add(match[1] ?? "");
  }
  for (const match of html.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) {
    const value = match[2] ?? "";
    if (/\.(png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/i.test(value)) found.add(value);
  }
  return [...found];
}

function oneLineFromHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
