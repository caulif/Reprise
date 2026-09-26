import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { parseFragment } from "parse5";
import type { ComparisonReportFacts, ComparisonResult } from "../agents/comparison-agent.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonDraftSubmissionSchema, type ComparisonDraftSubmission } from "../core/schema.js";
import type { AgentToolDefinition } from "../infrastructure/agent/host.js";
import type { AgentLocale } from "../agents/language.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";
import { metricsFromReportFacts, renderComparisonReportShell } from "./comparison-report-shell.js";
import { verifyAndRenderComparisonReport } from "./comparison-publication.js";
import type { PreparedReportPreview } from "./comparison-render-tools.js";

type HtmlNode = { attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode };

function citedEvidence(html: string): string[] {
  const refs = new Set<string>();
  const visit = (node: HtmlNode): void => {
    for (const attr of node.attrs ?? []) if (attr.name === "data-evidence-ref") refs.add(attr.value);
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(parseFragment(html) as HtmlNode);
  return [...refs];
}

export class ComparisonDraft {
  readonly #attemptRoot: string;
  readonly #task: string;
  readonly #facts: ComparisonReportFacts;
  readonly #locale: AgentLocale;
  readonly #catalog: ComparisonEvidenceCatalog;
  readonly #deliveredImages: ReadonlySet<string>;
  #accepted: { digest: string; revision: number; result: ComparisonResult } | undefined;
  #previewed: { digest: string; revision: number } | undefined;
  #lastRejection: string | undefined;

  constructor(input: {
    attemptRoot: string;
    task: string;
    facts: ComparisonReportFacts;
    locale: AgentLocale;
    catalog: ComparisonEvidenceCatalog;
    deliveredImages: ReadonlySet<string>;
  }) {
    this.#attemptRoot = input.attemptRoot;
    this.#task = input.task;
    this.#facts = input.facts;
    this.#locale = input.locale;
    this.#catalog = input.catalog;
    this.#deliveredImages = input.deliveredImages;
  }

  tool(): AgentToolDefinition {
    return {
      name: "submit_comparison_draft",
      description: "Submit only the report's category, headline, comparison HTML and optional details. Host validates evidence and builds the complete page. Call again to revise a rejected draft.",
      parameters: ComparisonDraftSubmissionSchema,
      execute: async (params, signal) => {
        if (!Value.Check(ComparisonDraftSubmissionSchema, params)) {
          this.#lastRejection = 'Draft fields failed schema validation.';
          return { content: "status=rejected\ncode=invalid_submission\nmessage=Draft fields failed schema validation." };
        }
        signal.throwIfAborted();
        const result = await this.submit(params);
        return { content: result };
      },
    };
  }

  async submit(draft: ComparisonDraftSubmission): Promise<string> {
    const catalog = this.#catalog.snapshot();
    const result: ComparisonResult = {
      status: draft.status,
      reportPath: "report.html",
      headline: draft.headline,
      evidenceRefs: citedEvidence(`${draft.comparisonHtml}${draft.detailsHtml ?? ""}`),
    };
    const html = renderComparisonReportShell({
      task: this.#task,
      facts: this.#facts,
      metrics: metricsFromReportFacts(this.#facts),
      evidence: catalog.links,
      media: catalog.media,
      slots: {
        category: draft.category,
        headline: draft.headline,
        comparison: draft.comparisonHtml,
        ...(draft.detailsHtml ? { details: draft.detailsHtml } : {}),
      },
      locale: this.#locale,
    });
    const verified = await verifyAndRenderComparisonReport({
      html, hostTask: this.#task, facts: this.#facts, result,
      attemptRoot: this.#attemptRoot, evidence: catalog.links, media: catalog.media,
      locale: this.#locale, deliveredImageContentHashes: this.#deliveredImages,
    });
    if ("failureClass" in verified) {
      this.#lastRejection = `${verified.code}: ${verified.message}`;
      return `status=rejected\ncode=${verified.code}\nmessage=${verified.message}`;
    }
    await writeAtomic(join(this.#attemptRoot, "report.html"), html);
    this.#accepted = { digest: sha256(html), revision: catalog.revision, result };
    this.#previewed = undefined;
    this.#lastRejection = undefined;
    return `status=accepted\ndraftDigest=${this.#accepted.digest}\nrevision=${catalog.revision}\nPreview this exact draft before finishing.`;
  }

  recordPreview(prepared: PreparedReportPreview): void {
    if (this.#accepted?.digest === prepared.draftDigest && this.#accepted.revision === prepared.catalogRevision) {
      this.#previewed = { digest: prepared.draftDigest, revision: prepared.catalogRevision };
    }
  }

  async completedResult(): Promise<ComparisonResult | undefined> {
    const accepted = this.#accepted;
    const previewed = this.#previewed;
    if (!accepted || !previewed || accepted.digest !== previewed.digest || accepted.revision !== previewed.revision) return undefined;
    const catalog = this.#catalog.snapshot();
    if (catalog.revision !== accepted.revision) return undefined;
    const html = await readFile(join(this.#attemptRoot, "report.html"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (html === undefined) return undefined;
    if (sha256(html) !== accepted.digest) return undefined;
    const verified = await verifyAndRenderComparisonReport({
      html, hostTask: this.#task, facts: this.#facts, result: accepted.result,
      attemptRoot: this.#attemptRoot, evidence: catalog.links, media: catalog.media,
      locale: this.#locale, deliveredImageContentHashes: this.#deliveredImages,
    });
    return "failureClass" in verified ? undefined : accepted.result;
  }

  failureReason(): { code: 'draft_invalid' | 'preview_failed'; message: string } {
    if (!this.#accepted) return { code: 'draft_invalid', message: this.#lastRejection ?? 'No valid comparison draft was submitted.' };
    if (!this.#previewed) return { code: 'preview_failed', message: 'The latest accepted draft was not previewed.' };
    return { code: 'draft_invalid', message: 'The draft, preview, or evidence catalog changed after validation.' };
  }
}
