import { Value } from "@sinclair/typebox/value";
import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import { sha256 } from "../core/identity.js";
import {
  ComparisonEvidenceQuoteParamsSchema, ComparisonEvidenceQuoteSpecSchema,
  type ComparisonEvidenceQuoteParams, type ComparisonEvidenceQuoteSpec,
} from "../core/schema.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import type { ComparisonQuoteSource, ComparisonQuoteSourcePort } from "./comparison-source.js";

const MAX_EVIDENCE_QUOTE_BYTES = 16_384;
type QuoteSelection = { spec: ComparisonEvidenceQuoteSpec; scope: "full" | "excerpt"; text: string; caption: string; sourceBytes: number };
type QuoteFailure = { status: "invalid_request" | "unknown_source" | "source_changed" | "not_text" | "invalid_range" | "too_large" | "cancelled"; message: string };
type Element = DefaultTreeAdapterMap["element"];

function selection(source: ComparisonQuoteSource, params: ComparisonEvidenceQuoteParams): QuoteSelection | QuoteFailure {
  if (sha256(source.bytes) !== source.sourceHash) return { status: "source_changed", message: "Source hash does not match actual bytes." };
  if (source.mediaType && !/^(text\/|application\/(json|javascript|xml)(?:;|$)|image\/svg\+xml(?:;|$))/.test(source.mediaType)) {
    return { status: "not_text", message: "Registered source is not a text document." };
  }
  const sourceBytes = source.bytes.byteLength;
  const { startByte, endByte } = params.range ?? { startByte: 0, endByte: sourceBytes };
  if (startByte > endByte || endByte > sourceBytes) return { status: "invalid_range", message: "Range must be inside the source, with startByte <= endByte." };
  if (endByte - startByte > MAX_EVIDENCE_QUOTE_BYTES) return { status: "too_large", message: "Choose an explicit excerpt of at most 16384 UTF-8 bytes. Full sources are never silently truncated." };
  let text: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const full = decoder.decode(source.bytes);
    if (full.includes("\0")) return { status: "not_text", message: "Source contains binary NUL bytes." };
    text = decoder.decode(source.bytes.subarray(startByte, endByte));
  } catch {
    // Fatal decoding rejects binary content and byte ranges splitting a UTF-8 character.
    return { status: "not_text", message: "Source and selected range must be valid UTF-8 text." };
  }
  const scope = startByte === 0 && endByte === sourceBytes ? "full" : "excerpt";
  const side = source.side === "baseline" ? "历史" : source.side === "candidate" ? "当前" : source.side === "derived" ? "派生" : "记录";
  return { spec: { sourceRef: params.sourceRef, sourceHash: source.sourceHash, startByte, endByte }, scope, text, caption: `${side} · ${scope === "full" ? "完整原文" : "节选"}`, sourceBytes };
}

function escapeQuoteText(text: string): string {
  // HTML preprocessing normalizes CRLF/CR; apply it once before any parse/serialize round trips.
  // The source hash and range still refer to original bytes. <code> preserves a leading LF inside <pre>.
  return text.replace(/\r\n?/g, "\n").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function quoteHtml(quote: QuoteSelection): string {
  const { sourceRef, sourceHash, startByte, endByte } = quote.spec;
  return `<figure data-component="evidence-quote" data-evidence-ref="${sourceRef}" data-source-hash="${sourceHash}" data-start-byte="${startByte}" data-end-byte="${endByte}" data-quote-scope="${quote.scope}"><figcaption>${quote.caption}</figcaption><pre><code>${escapeQuoteText(quote.text)}</code></pre></figure>`;
}

function quoteResponse(quote: QuoteSelection): Record<string, unknown> {
  return { status: "ok", ...quote.spec, range: { startByte: quote.spec.startByte, endByte: quote.spec.endByte }, sourceBytes: quote.sourceBytes, scope: quote.scope, textNormalization: "html_line_endings", html: quoteHtml(quote) };
}

function outputTooLarge(quote: QuoteSelection): boolean {
  return Buffer.byteLength(JSON.stringify(quoteResponse(quote)), "utf8") > MAX_EVIDENCE_QUOTE_BYTES;
}

function result(value: Record<string, unknown>): AgentToolResult {
  return { content: JSON.stringify(value), details: value };
}

export function createQuoteEvidenceTool(deps: { sources: ComparisonQuoteSourcePort }): AgentToolDefinition {
  return {
    name: "quote_evidence",
    description: "Return a Host-generated exact text quotation from a registered ev short reference. Omit range for the complete source, or select a UTF-8 byte range [startByte,endByte). Copy the returned HTML unchanged. Full/excerpt is calculated from the actual source, not a model declaration. The quotation payload is limited to 16384 bytes before Host progress feedback is added.",
    parameters: ComparisonEvidenceQuoteParamsSchema,
    async execute(params: unknown, signal: AbortSignal) {
      if (!Value.Check(ComparisonEvidenceQuoteParamsSchema, params)) return result({ status: "invalid_request", message: "Parameters failed schema check." });
      if (signal.aborted) return result({ status: "cancelled", message: "Quotation cancelled." });
      const source = await deps.sources.resolveTextSource(params.sourceRef);
      if (signal.aborted) return result({ status: "cancelled", message: "Quotation cancelled." });
      if (!source) return result({ status: "unknown_source", message: "Registered source is unavailable or no longer matches its identity." });
      const quote = selection(source, params);
      if ("status" in quote) return result(quote);
      if (outputTooLarge(quote)) return result({ status: "too_large", message: "Escaped quotation payload exceeds 16384 bytes before Host progress feedback. Select a smaller explicit excerpt; no automatic truncation is performed." });
      return result(quoteResponse(quote));
    },
  };
}

function quoteElements(html: string): Element[] {
  const found: Element[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("attrs" in node && node.attrs.some(attr => attr.name === "data-component" && attr.value === "evidence-quote")) found.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if ("content" in node) visit(node.content);
  };
  visit(parseFragment(html));
  return found;
}

/** Recomputes quotes from registered source bytes; no in-memory receipt or quote registry is authoritative. */
export async function validateComparisonEvidenceQuotes(html: string, sources?: ComparisonQuoteSourcePort): Promise<string | undefined> {
  const elements = quoteElements(html);
  if (elements.length && !sources) return "Evidence quote cannot be verified without its registered source resolver.";
  if (!sources) return undefined;
  for (const element of elements) {
    const attrs = Object.fromEntries(element.attrs.map(attr => [attr.name, attr.value]));
    const spec: unknown = {
      sourceRef: attrs["data-evidence-ref"], sourceHash: attrs["data-source-hash"],
      startByte: /^\d+$/.test(attrs["data-start-byte"] ?? "") ? Number(attrs["data-start-byte"]) : NaN,
      endByte: /^\d+$/.test(attrs["data-end-byte"] ?? "") ? Number(attrs["data-end-byte"]) : NaN,
    };
    if (!Value.Check(ComparisonEvidenceQuoteSpecSchema, spec)) return "Evidence quote has invalid source identity or UTF-8 byte range.";
    const source = await sources.resolveTextSource(spec.sourceRef);
    if (!source || source.sourceHash !== spec.sourceHash) return `Evidence quote source is unavailable or changed: ${spec.sourceRef}.`;
    const quote = selection(source, { sourceRef: spec.sourceRef, range: { startByte: spec.startByte, endByte: spec.endByte } });
    if ("status" in quote) return `Evidence quote rejected: ${quote.status}.`;
    if (outputTooLarge(quote)) return "Evidence quote output exceeds 16384 bytes.";
    const expected = quoteElements(quoteHtml(quote))[0];
    // Canonical DOM comparison tolerates HTML entity spelling while checking exact text, fixed labels and structure.
    if (!expected || serializeOuter(element) !== serializeOuter(expected)) return `Evidence quote text, scope, caption or structure differs from its source: ${spec.sourceRef}.`;
  }
  return undefined;
}
