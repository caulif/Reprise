import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { parseFragment } from "parse5";
import { comparisonMainTextCharacters } from "./comparison-report-text.js";
import type { ComparisonReportFacts, ComparisonResult } from "../agents/comparison-agent.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonDraftSubmissionSchema, type ComparisonDraftSubmission } from "../core/schema.js";
import type { AgentToolDefinition } from "../infrastructure/agent/host.js";
import type { AgentLocale } from "../agents/language.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";
import { metricsFromReportFacts, renderComparisonReportShell } from "./comparison-report-shell.js";
import { verifyAndRenderComparisonReport } from "./comparison-publication.js";
import type { PreparedReportPreview } from "./comparison-render-tools.js";
import type { ComparisonDiscovery } from "./comparison-discovery.js";
import type { ComparisonDraftBinding } from "../core/comparison-discovery-schema.js";

type HtmlNode = { nodeName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode };

function citedEvidence(html: string): string[] {
  const refs = new Set<string>();
  const visit = (node: HtmlNode): void => {
    for (const attr of node.attrs ?? []) if (attr.name === "data-evidence-ref") refs.add(attr.value);
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(parseFragment(html));
  return [...refs];
}

export class ComparisonDraft {
  readonly #attemptRoot: string;
  readonly #task: string;
  readonly #facts: ComparisonReportFacts;
  readonly #locale: AgentLocale;
  readonly #catalog: ComparisonEvidenceCatalog;
  readonly #deliveredImages: ReadonlySet<string>;
  readonly #discovery: ComparisonDiscovery | undefined;
  readonly #persistAccepted: ((binding: ComparisonDraftBinding) => Promise<void>) | undefined;
  #accepted: { digest: string; revision: number; discoveryRevision?: number; result: ComparisonResult } | undefined;
  #previewed: { digest: string; revision: number } | undefined;
  #previewFailure: { digest: string; revision: number; status: string; message?: string } | undefined;
  #lastRejection: string | undefined;

  constructor(input: {
    attemptRoot: string;
    task: string;
    facts: ComparisonReportFacts;
    locale: AgentLocale;
    catalog: ComparisonEvidenceCatalog;
    deliveredImages: ReadonlySet<string>;
    discovery?: ComparisonDiscovery;
    persistAccepted?: (binding: ComparisonDraftBinding) => Promise<void>;
  }) {
    this.#attemptRoot = input.attemptRoot;
    this.#task = input.task;
    this.#facts = input.facts;
    this.#locale = input.locale;
    this.#catalog = input.catalog;
    this.#deliveredImages = input.deliveredImages;
    this.#discovery = input.discovery;
    this.#persistAccepted = input.persistAccepted;
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
    if (this.#discovery && !this.#discovery.readyToCompose()) {
      this.#lastRejection = "findings_not_ready: Save findings and resolve decision questions or mark evidence unavailable before composing.";
      return `status=rejected\ncode=findings_not_ready\nmessage=${this.#lastRejection}`;
    }
    const discovery = this.#discovery?.snapshot();
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
    await writeAtomic(join(this.#attemptRoot, "report.html"), verified.html);
    const digest = sha256(verified.html);
    const changed = this.#accepted?.digest !== digest || this.#accepted.revision !== catalog.revision || this.#accepted.discoveryRevision !== discovery?.revision;
    if (changed && discovery && this.#persistAccepted) await this.#persistAccepted({ draftDigest: digest, catalogRevision: catalog.revision, findingsRevision: discovery.revision });
    if (changed) {
      this.#previewed = undefined;
      this.#previewFailure = undefined;
    }
    this.#accepted = { digest, revision: catalog.revision, ...(discovery ? { discoveryRevision: discovery.revision } : {}), result };
    this.#lastRejection = undefined;
    const length = comparisonMainTextCharacters(verified.html);
    const feedback = length > 600
      ? "Shorten repeated conclusions and move methods to details; preserve decisive evidence and limitations. This is advisory, not a word-limit gate."
      : "Match length to the decision: a single difference usually needs only a headline, paired excerpts and its consequence (about 100–250 Chinese characters); several consequential differences may need 300–600. Do not repeat the headline or add generic provenance/checking caveats that do not change this choice.";
    return `status=accepted\ndraftDigest=${digest}\nrevision=${catalog.revision}\nmainTextCharacters=${length}\nreadabilityFeedback=${feedback}\nimportantLimitations=${JSON.stringify(discovery?.submission.importantLimitations ?? [])}\nEnsure important limitations remain visible in the main comparison; their semantic coverage needs review.\nPreview this exact draft in the review turn before finishing.`;
  }

  submissionState(): string {
    return JSON.stringify({ accepted: this.#accepted && { digest: this.#accepted.digest, revision: this.#accepted.revision, discoveryRevision: this.#accepted.discoveryRevision }, previewed: this.#previewed, revision: this.#catalog.snapshot().revision, discoveryRevision: this.#discovery?.snapshot()?.revision, rejection: this.#lastRejection });
  }

  recordPreview(prepared: PreparedReportPreview): void {
    this.recordPreviewOutcome(prepared, { status: "ok" });
  }

  /** Remember a preview_report result for the current accepted draft, including timeout. */
  recordPreviewOutcome(prepared: PreparedReportPreview, outcome: { status: string; message?: string }): void {
    if (this.#accepted?.digest !== prepared.draftDigest || this.#accepted.revision !== prepared.catalogRevision) return;
    if (outcome.status === "ok") {
      this.#previewed = { digest: prepared.draftDigest, revision: prepared.catalogRevision };
      this.#previewFailure = undefined;
      return;
    }
    this.#previewFailure = {
      digest: prepared.draftDigest,
      revision: prepared.catalogRevision,
      status: outcome.status,
      ...(outcome.message ? { message: outcome.message } : {}),
    };
  }

  async completedResult(): Promise<ComparisonResult | undefined> {
    const accepted = this.#accepted;
    const previewed = this.#previewed;
    if (this.#discovery && (!this.#discovery.readyToCompose() || accepted?.discoveryRevision !== this.#discovery.snapshot()?.revision)) return undefined;
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

  failureReason(): { code: 'draft_invalid' | 'preview_failed'; message: string; kind?: 'protocol' | 'timeout' | 'tool' } {
    if (this.#discovery && (!this.#discovery.readyToCompose() || this.#accepted?.discoveryRevision !== this.#discovery.snapshot()?.revision)) return { code: 'draft_invalid', message: 'findings_not_ready: Update findings for the latest evidence catalog, resolve pending questions or explain unavailable evidence, then resubmit and preview the draft.' };
    if (!this.#accepted) return { code: 'draft_invalid', message: this.#lastRejection ?? 'No valid comparison draft was submitted.' };
    const failed = this.#previewFailure;
    if (failed && failed.digest === this.#accepted.digest && failed.revision === this.#accepted.revision) {
      const detail = failed.message ? ` ${failed.message}` : "";
      return {
        code: 'preview_failed',
        kind: failed.status === 'timeout' ? 'timeout' : 'tool',
        message: `Preview of the latest accepted draft returned ${failed.status}: digest=${this.#accepted.digest}, revision=${this.#accepted.revision}.${detail}`,
      };
    }
    if (!this.#previewed) return { code: 'preview_failed', message: `The latest accepted draft was not previewed: digest=${this.#accepted.digest}, revision=${this.#accepted.revision}. Call preview_report in the current review turn.` };
    return { code: 'draft_invalid', message: 'The draft, preview, or evidence catalog changed after validation.' };
  }
}
