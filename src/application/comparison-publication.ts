import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import {
  AGENT_ZONES,
  candidateStatusLabel,
  extractInner,
  extractOuter,
  hostMetricsMismatch,
  hostStatusMismatch,
  hostZonesMismatch,
  missingComparisonSlots,
  metricsFromReportFacts,
  type ComparisonReportDiagnostic,
  type HostZoneSnapshot,
} from "./comparison-report-shell.js";
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
}): Promise<
  { html: string; model: ComparisonReportModel }
  | { failureClass: ComparisonFailureClass; code: ComparisonPublishCode; message: string }
> {
  const metrics = metricsFromReportFacts(input.facts);
  const zoneError = input.hostZoneSnapshot
    ? hostZonesMismatch(input.html, input.hostZoneSnapshot, metrics)
    : missingComparisonSlots(input.html) ?? hostMetricsMismatch(input.html, metrics) ?? hostStatusMismatch(input.html, input.facts);
  if (zoneError) {
    const code: ComparisonPublishCode = zoneError.includes("missing data-agent-zone") ? "report_incomplete" : "host_zone_modified";
    return { failureClass: code === "report_incomplete" ? "publication" : "metrics", code, message: zoneError };
  }
  const incomplete = incompleteKeyDifferences(input.html);
  if (incomplete) return { failureClass: "publication", code: "report_incomplete", message: incomplete };
  const rewritten = await rewritePublishableHtml(input);
  if (hasExternalNetwork(rewritten.html)) {
    return { failureClass: "publication", code: "publication_failed", message: "Comparison report contains external network resources." };
  }
  if (claimsVerifiedWithoutEvidence(input.html, rewritten.unresolvedEvidence) && rewritten.unresolvedEvidence.length > 0) {
    return { failureClass: "evidence", code: "evidence_unresolved", message: "Comparison claimed verification but related evidence is unresolved." };
  }
  if (citedMediaAllUnresolved(input.html, rewritten.unresolvedMedia)) {
    return { failureClass: "media", code: "media_unavailable", message: "Comparison cited media that is not available." };
  }
  const html = markUnresolvedInHostEvidence(rewritten.html, [...rewritten.unresolvedEvidence, ...rewritten.unresolvedMedia]);
  const model = comparisonReportModelFromHtml(html, input.facts, input.result, input.media, input.evidence);
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
}): Promise<void> {
  await writeAtomic(join(input.experimentRoot, "report.html"), input.html);
  await copyPublishedMedia(input.attemptRoot, input.experimentRoot);
}

async function copyPublishedMedia(attemptRoot: string, experimentRoot: string): Promise<void> {
  try {
    await mkdir(join(experimentRoot, "media"), { recursive: true });
    await cp(join(attemptRoot, "media"), join(experimentRoot, "media"), { recursive: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

export function comparisonReportModelFromHtml(
  html: string,
  facts: ComparisonReportFacts,
  result: ComparisonResult,
  media: readonly ComparisonMediaRecord[],
  evidence: readonly ComparisonLinkRecord[] = [],
): ComparisonReportModel {
  const slots = {
    header: extractInner(html, "data-host-zone", "header"),
    "key-differences": extractInner(html, "data-agent-zone", "key-differences"),
    "visual-evidence": extractInner(html, "data-agent-zone", "visual-evidence"),
    delivery: extractInner(html, "data-agent-zone", "delivery"),
    limitations: extractInner(html, "data-agent-zone", "limitations"),
    evidence: extractInner(html, "data-host-zone", "evidence"),
    process: extractInner(html, "data-host-zone", "process"),
  };
  const evidenceRefs = result.evidenceRefs.flatMap((short) => {
    const hit = evidence.find((item) => item.shortRef === short)?.evidenceRef;
    return hit ? [hit] : [];
  });
  const mediaRefs = media.filter((item) => html.includes(item.reportHref) || (item.shortRef && html.includes(item.shortRef))).map((item) => item.ref);
  return {
    schemaVersion: 1,
    task: facts.run.runId ? oneLineFromHtml(slots.header) || "对照" : "对照",
    status: {
      baseline: facts.replay.baselineEvidence,
      candidate: candidateStatusLabel(facts.run.outcome, facts.run.terminationCode),
      candidateOutcome: facts.run.outcome,
      terminationCode: facts.run.terminationCode,
    },
    ...(facts.metrics ? { metrics: facts.metrics } : {}),
    slots,
    evidenceRefs,
    mediaRefs,
    ...(result.headline ? { headline: result.headline } : {}),
  };
}

export function comparisonFailureDiagnostic(input: {
  result: StructuredAgentResult<unknown>;
  facts: ComparisonReportFacts;
  reportPresent: boolean;
  attemptId: string;
}): ComparisonReportDiagnostic {
  const classified = classifyComparisonFailure(input);
  const failed = input.result.status === "failed" ? input.result.failure : undefined;
  return {
    failureClass: classified.failureClass,
    phase: classified.phase,
    candidateCompleted: candidateStatusLabel(input.facts.run.outcome, input.facts.run.terminationCode),
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
  };
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

function incompleteKeyDifferences(html: string): string | undefined {
  const inner = extractInner(html, "data-agent-zone", "key-differences");
  const text = oneLineFromHtml(inner);
  if (text.length > 0) return undefined;
  return 'Comparison report is missing key differences (or an explicit "无法判断").';
}

function claimsVerifiedWithoutEvidence(html: string, unresolved: readonly string[]): boolean {
  const body = extractInner(html, "data-agent-zone", "key-differences");
  if (!/已核验|已经核验|\bverified\b/i.test(body)) return false;
  const cited = unique([...body.matchAll(/\bdata-evidence-ref="([^"]+)"/gi)].map((match) => match[1] ?? "").filter(Boolean));
  if (cited.length === 0) return false;
  const missing = new Set(unresolved);
  return cited.every((ref) => missing.has(ref));
}

function citedMediaAllUnresolved(html: string, unresolved: readonly string[]): boolean {
  if (unresolved.length === 0) return false;
  const body = `${extractInner(html, "data-agent-zone", "visual-evidence")}${extractInner(html, "data-agent-zone", "key-differences")}`;
  if (!/已核验|已经核验|\bverified\b/i.test(body)) return false;
  const cited = unique([...body.matchAll(/\bdata-media-ref="([^"]+)"/gi)].map((match) => match[1] ?? "").filter(Boolean));
  if (cited.length === 0) return false;
  const missing = new Set(unresolved);
  return cited.every((ref) => missing.has(ref));
}

function markUnresolvedInHostEvidence(html: string, unresolved: readonly string[]): string {
  if (unresolved.length === 0) return html;
  const outer = extractOuter(html, "data-host-zone", "evidence");
  if (!outer) return html;
  const note = `<p data-host="unresolved-evidence">证据未解析：${escapeText(unresolved.join("、"))}</p>`;
  if (outer.includes("证据未解析")) return html;
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
    if (href.startsWith("data:") || href.startsWith("#")) continue;
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
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
