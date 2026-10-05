import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { parseFragment } from "parse5";
import { comparisonDetailsTextCharacters, comparisonDetailsText, comparisonMainTextCharacters, comparisonVisibleMainText } from "./comparison-report-text.js";
import type { ComparisonReportFacts, ComparisonResult } from "../agents/comparison-agent.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { extractInner } from "../core/comparison-html.js";
import { ComparisonDraftSubmissionSchema, ComparisonReportModelSchema, ComparisonFindingsSubmissionSchema, type ComparisonDraftSubmission } from "../core/schema.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import type { AgentLocale } from "../agents/language.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";
import { metricsFromReportFacts, renderComparisonReportShell } from "./comparison-report-shell.js";
import { comparisonReportModelFromHtml, verifyAndRenderComparisonReport } from "./comparison-publication.js";
import type { ComparisonRenderedCheck, PreparedReportPreview } from "./comparison-render-tools.js";
import type { ComparisonDiscovery } from "./comparison-discovery.js";
import type { ComparisonDraftBinding } from "../core/comparison-discovery-schema.js";
import type { ComparisonQuoteSourcePort } from "./comparison-source.js";
import { ComparisonDraftAcceptanceReceiptSchema, ComparisonDraftInspectionSchema } from "../core/comparison-review-schema.js";
import { comparisonToolTextBytes, serializeComparisonPagedJson } from './comparison-render-output.js';
import { pathContainedBy } from '../core/paths.js';
import { toolDeliveryToken, withToolDelivery } from '../infrastructure/agent/tool-delivery.js';
import { redactModelVisibleText } from '../infrastructure/agent/model-input.js';
import { decisionTextHtml, decisionSupportDetailsHtml, decisionContractError } from './comparison-decision-contract.js';

type HtmlNode = { nodeName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode };
type AcceptedDraft = { digest: string; revision: number; discoveryRevision?: number; result: ComparisonResult; decisionShape?: ComparisonDraftSubmission["decisionShape"] };
type DraftInspectionDelivery = { accepted: AcceptedDraft; reviewEpoch: number; catalogRevision: number; findingsRevision: number | undefined; formal: boolean };
const InspectionMaterialTextSchema = Type.Object({ status: Type.Union([Type.Literal('available'), Type.Literal('stale')]),
  headline: Type.String(), comparisonHtml: Type.String(), detailsHtml: Type.Optional(Type.String()), truncated: Type.Optional(Type.Boolean()),
});
type InspectionMaterialText = { status: 'available' | 'stale'; headline: string; comparisonHtml: string; detailsHtml?: string; truncated?: boolean };

function inspectionMaterialText(content: string): InspectionMaterialText | undefined {
  let payload: unknown;
  try { payload = JSON.parse(content); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return undefined; }
  return Value.Check(InspectionMaterialTextSchema, payload) && payload.truncated !== true ? payload : undefined;
}

function completeInspectionMaterial(result: AgentToolResult, expected: InspectionMaterialText): boolean {
  const texts = result.contentBlocks === undefined ? [result.content] : result.contentBlocks.flatMap(block => block.type === 'text' ? [block.text] : []);
  return texts.some(text => {
    const actual = inspectionMaterialText(text);
    return actual?.status === expected.status && actual.headline === expected.headline
      && actual.comparisonHtml === expected.comparisonHtml && actual.detailsHtml === expected.detailsHtml;
  });
}

const DraftToolSchema = Type.Object({
  ...ComparisonDraftSubmissionSchema.properties,
  decisionShape: Type.Required(Type.Pick(ComparisonDraftSubmissionSchema, ["decisionShape"])).properties.decisionShape,
  ...Type.Required(Type.Pick(ComparisonDraftSubmissionSchema, ["decisionSummary", "decisionBoundary", "decisionBasis", "conclusionScope", "findingDispositions"])).properties,
});
const RepairReadSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  maxBytes: Type.Integer({ minimum: 1, maximum: 4096 }), format: Type.Optional(Type.Literal('text')),
}, { additionalProperties: false });
const RepairHistorySchema = Type.Pick(ComparisonFindingsSubmissionSchema, ['decisionQuestions']);

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
  readonly #renderCheckHistory: (() => { records: readonly ComparisonRenderedCheck[]; omitted: number }) | undefined;
  readonly #quoteSources: ComparisonQuoteSourcePort | undefined;
  #accepted: AcceptedDraft | undefined;
  #previewed: { digest: string; revision: number } | undefined;
  #previewFailure: { digest: string; revision: number; status: string; message?: string } | undefined;
  #lastRejection: string | undefined;
  #reviewInspectionRequired = false;
  #inspected: AcceptedDraft | undefined;
  #bindingRevision = 0;
  #reviewEpoch = 0;
  #reviewDraftMaterial: DraftInspectionDelivery | undefined;
  readonly #pendingInspections = new WeakMap<object, DraftInspectionDelivery>();
  #pendingReviewMaterials = new WeakMap<object, DraftInspectionDelivery & { text: InspectionMaterialText }>();
  readonly #repairReadFiles = new Map<string, string>();

  constructor(input: {
    attemptRoot: string;
    task: string;
    facts: ComparisonReportFacts;
    locale: AgentLocale;
    catalog: ComparisonEvidenceCatalog;
    deliveredImages: ReadonlySet<string>;
    discovery?: ComparisonDiscovery;
    persistAccepted?: (binding: ComparisonDraftBinding) => Promise<void>;
    renderCheckHistory?: () => { records: readonly ComparisonRenderedCheck[]; omitted: number };
    quoteSources?: ComparisonQuoteSourcePort;
  }) {
    this.#attemptRoot = input.attemptRoot;
    this.#task = input.task;
    this.#facts = input.facts;
    this.#locale = input.locale;
    this.#catalog = input.catalog;
    this.#deliveredImages = input.deliveredImages;
    this.#discovery = input.discovery;
    this.#persistAccepted = input.persistAccepted;
    this.#renderCheckHistory = input.renderCheckHistory;
    this.#quoteSources = input.quoteSources;
  }

  tool(): AgentToolDefinition {
    return {
      name: "submit_comparison_draft",
      description: "Submit plain-text decisionSummary describing this task's actual usability and user tradeoff, conditional choice or inability to judge. Preserve task-critical branches, not only the strongest technical advantage. Required decisionBoundary contains decision-changing unknowns or counterevidence, not a method inventory; empty only when none identified and no saved important limitations exist. Cover each current finding once in findingDispositions; decisionBasis exactly matches basis IDs. completed with findings requires a basis; insufficient_evidence requires undetermined. Incomplete basis/boundary output support cannot use supported_in_scope. These are model declarations, not semantic certification. Host visibly renders summary, boundary and incomplete support before comparisonHtml. Main headline plus all visible comparison is limited to 250 characters for one consequential difference or 600 for multiple independent differences. Supporting details, including folded and hidden explanations, are limited to 400 or 1000 respectively; validated evidence quotes are excluded. Evidence, consequences and caveats of one difference do not make it multiple.",
      parameters: DraftToolSchema,
      execute: async (params, signal) => {
        if (!Value.Check(DraftToolSchema, params)) {
          this.#lastRejection = 'Draft fields failed schema validation.';
          return { content: "status=rejected\ncode=invalid_submission\nmessage=Draft fields failed schema validation." };
        }
        signal.throwIfAborted();
        const result = await this.submit(params);
        if (!result.startsWith("status=accepted") || !this.#accepted) return { content: result };
        const accepted = this.#accepted;
        const receipt = { schemaVersion: 1 as const, status: "accepted" as const, draftDigest: accepted.digest,
          catalogRevision: accepted.revision, bindingRevision: this.#bindingRevision,
          ...(accepted.discoveryRevision === undefined ? {} : { findingsRevision: accepted.discoveryRevision }),
          decisionShape: accepted.decisionShape ?? "unknown" };
        if (!Value.Check(ComparisonDraftAcceptanceReceiptSchema, receipt)) throw new Error("Invalid comparison acceptance receipt.");
        return { content: result, details: receipt };
      },
    };
  }

  inspectTool(): AgentToolDefinition {
    return {
      name: "inspect_comparison_draft",
      description: "Read accepted draft headline, comparison and all details without Host CSS or private paths. Current bindings return an inspection receipt; stale bindings return actual unverified author text and historical question identities for repair, never a completion receipt. Revise from independent source observations and resubmit before final inspection and preview. Missing or changed files remain unavailable. Structural validation does not certify semantics.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (params, signal) => {
        if (!Value.Check(Type.Object({}, { additionalProperties: false }), params)) throw new Error("Invalid draft inspection parameters.");
        signal.throwIfAborted();
        this.#reviewDraftMaterial = undefined;
        this.#pendingReviewMaterials = new WeakMap();
        const accepted = this.#accepted;
        const catalog = this.#catalog.snapshot();
        const findingsRevision = this.#discovery?.snapshot()?.revision;
        const reviewEpoch = this.#reviewEpoch;
        if (!accepted) return { content: JSON.stringify(await this.#boundedInspection({ status: "unavailable", reason: "No accepted draft exists.", repairContext: this.#repairContext() })) };
        const html = await this.#readAcceptedHtml(accepted.digest);
        if (html === undefined) return { content: JSON.stringify({ status: "unavailable", reason: "Accepted draft file is missing or changed." }) };
        if (this.#accepted !== accepted || this.#catalog.snapshot().revision !== catalog.revision || this.#discovery?.snapshot()?.revision !== findingsRevision) {
          return { content: JSON.stringify({ status: "unavailable", reason: "Draft binding changed during inspection; inspect again." }) };
        }
        const model = comparisonReportModelFromHtml(html, this.#facts, accepted.result, catalog.media, catalog.links, this.#locale);
        if (!Value.Check(ComparisonReportModelSchema, model)) throw new Error("Invalid persisted comparison report content.");
        if (accepted.revision !== catalog.revision || accepted.discoveryRevision !== findingsRevision) {
          signal.throwIfAborted();
          const content = await this.#boundedInspection({ status: "stale", draftDigest: accepted.digest,
            acceptedCatalogRevision: accepted.revision, acceptedFindingsRevision: accepted.discoveryRevision,
            headline: model.headline, comparisonHtml: model.slots.comparison, detailsHtml: model.slots.details,
            semanticValidation: "not_performed", certification: "none",
            meaning: "Actual unverified author draft with stale bindings. Historical questions are hypotheses, not certified observations. Revise from independent source evidence, preserve question identities, resubmit current findings and draft, then inspect and preview. This result cannot satisfy final inspection or publication.",
            repairContext: this.#repairContext(),
            renderCheckHistory: this.#inspectionRenderHistory(),
          });
          if (content.status !== 'stale') return { content: JSON.stringify(content) };
          const result = withToolDelivery({ content: JSON.stringify(content) });
          const text = inspectionMaterialText(redactModelVisibleText(result.content).text);
          if (text) this.#pendingReviewMaterials.set(toolDeliveryToken(result)!, { accepted, reviewEpoch, catalogRevision: catalog.revision, findingsRevision, formal: false, text });
          return result;
        }
        const receipt = { schemaVersion: 1 as const, status: "available" as const, draftDigest: accepted.digest,
          bindingRevision: this.#bindingRevision,
          catalogRevision: accepted.revision, ...(accepted.discoveryRevision === undefined ? {} : { findingsRevision: accepted.discoveryRevision }),
          decisionShape: accepted.decisionShape ?? "unknown", reviewInspectionRequired: this.#reviewInspectionRequired,
          semanticValidation: "not_performed" as const };
        if (!Value.Check(ComparisonDraftInspectionSchema, receipt)) throw new Error("Invalid comparison inspection receipt.");
        signal.throwIfAborted();
        const content = await this.#boundedInspection({ ...receipt,
          reportStatus: accepted.result.status, category: extractInner(html, "data-agent-slot", "category"),
          decisionShapeValidation: "model_declaration_only",
          headline: model.headline, comparisonHtml: model.slots.comparison, detailsHtml: model.slots.details,
          mainTextCharacters: comparisonMainTextCharacters(html),
          renderCheckHistory: this.#inspectionRenderHistory(),
        });
        if (content.status !== 'available') return { content: JSON.stringify(content) };
        this.#pendingInspections.set(receipt, { accepted, reviewEpoch, catalogRevision: catalog.revision, findingsRevision, formal: true });
        const result = withToolDelivery({ details: receipt, content: JSON.stringify(content) });
        const text = inspectionMaterialText(redactModelVisibleText(result.content).text);
        if (text) this.#pendingReviewMaterials.set(toolDeliveryToken(result)!, { accepted, reviewEpoch, catalogRevision: catalog.revision, findingsRevision, formal: true, text });
        return result;
      },
      onCompleted: async result => {
        const key = toolDeliveryToken(result);
        const material = key === undefined ? undefined : this.#pendingReviewMaterials.get(key);
        if (key !== undefined) this.#pendingReviewMaterials.delete(key);
        if (material && this.#currentInspectionDelivery(material) && completeInspectionMaterial(result, material.text)) this.#reviewDraftMaterial = material;
        if (!result.details || typeof result.details !== "object") return;
        const pending = this.#pendingInspections.get(result.details);
        this.#pendingInspections.delete(result.details);
        if (pending && material?.formal && this.#currentInspectionDelivery(pending) && completeInspectionMaterial(result, material.text)) {
          if (pending.formal) this.#inspected = pending.accepted;
        }
      },
    };
  }

  #inspectionRenderHistory() {
    const checks = this.#renderCheckHistory?.();
    return {
      coverage: checks ? "recorded_outcomes_in_this_process" : "unavailable",
      origin: "this_comparison_attempt_not_candidate_runtime",
      omitted: checks?.omitted ?? 0,
      records: (checks?.records ?? []).map(check => ({ sourceRef: check.sourceRef, side: check.side,
        sourceHash: check.sourceHash, status: check.status, viewport: check.viewport,
        frames: check.frames.map(frame => ({ sampleTimeMs: frame.sampleTimeMs, actualTimeMs: frame.actualTimeMs,
          contentHash: frame.contentHash, geometryUnavailable: frame.geometryUnavailable,
          geometryWindow: frame.geometrySample && { coordinateDomain: frame.geometrySample.coordinateDomain,
            startedAtMs: frame.geometrySample.startedAtMs, finishedAtMs: frame.geometrySample.finishedAtMs },
          nativeImageDeliveredToCurrentSession: this.#deliveredImages.has(frame.contentHash),
        })),
      })),
      limitation: "Inventory only: geometry values, selectors and transforms are not repeated here. Use original render_artifact measurements or their fullMeasurement paged JSON. Rendering and image delivery are distinct; this tool does not deliver images or establish visual inspection. Empty history does not prove no checks occurred.",
    };
  }

  async #boundedInspection(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const history = payload.renderCheckHistory as { records: unknown[]; omitted: number } | undefined;
    while (history?.records.length && comparisonToolTextBytes(payload) > 12_288) {
      history.records.shift();
      history.omitted++;
    }
    const repair = payload.repairContext as { decisionQuestions: unknown[] } | undefined;
    if (repair?.decisionQuestions.length && comparisonToolTextBytes(payload) > 12_288) {
      const data = { decisionQuestions: repair.decisionQuestions };
      if (!Value.Check(RepairHistorySchema, data)) throw new Error('Invalid persisted question repair history.');
      const bytes = serializeComparisonPagedJson(data);
      const relativePath = `scratch/question-history-${sha256(bytes).slice(0, 24)}.json`;
      await writeAtomic(join(this.#attemptRoot, relativePath), bytes);
      this.#repairReadFiles.set(relativePath, sha256(bytes));
      payload.repairContext = { ...repair, decisionQuestions: data.decisionQuestions.map(question => ({ id: question.id, status: question.status })),
        fullHistory: { path: relativePath, contentHash: sha256(bytes), read: 'Read with byte offset and maxBytes=4096, continuing at nextCursor. Preserve the exact historical IDs, questions and decisionImpact from these pages before updating findings. Prior resolutions are unverified hypotheses.' } };
    }
    if (comparisonToolTextBytes(payload) <= 12_288) return payload;
    return { status: 'unavailable', reason: 'Complete inspection text exceeds the bounded tool-result budget. Reduce excessive report markup or quoted source before resubmitting; no partial text can certify inspection.', certification: 'none' };
  }

  async isRepairRead(params: unknown): Promise<boolean> {
    if (!Value.Check(RepairReadSchema, params) || !Number.isSafeInteger(params.offset ?? 0)) return false;
    const expectedHash = this.#repairReadFiles.get(params.path);
    if (!expectedHash) return false;
    try {
      const path = join(this.#attemptRoot, params.path);
      const [root, canonical] = await Promise.all([realpath(this.#attemptRoot), realpath(path)]);
      if (!pathContainedBy(root, canonical)) return false;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (params.offset ?? 0) > info.size) return false;
      const bytes = await readFile(path);
      if (sha256(bytes) !== expectedHash) return false;
      let data: unknown;
      try { data = JSON.parse(bytes.toString('utf8')); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return false;
      }
      return Value.Check(RepairHistorySchema, data);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  #repairContext() {
    const record = this.#discovery?.snapshot();
    return {
      catalogRevision: this.#catalog.snapshot().revision,
      findingsRevision: record?.revision,
      findingsCatalogRevision: record?.catalogRevision,
      readyToCompose: this.#discovery?.readyToCompose() ?? true,
      decisionQuestions: record?.submission.decisionQuestions ?? [],
      meaning: "Historical question identities and unverified hypotheses for repair only. Reassess using independent source observations; preserve these IDs in the complete updated findings record. No author finding observations are injected here.",
    };
  }

  beginReview(): void {
    this.#reviewInspectionRequired = true;
    this.#reviewEpoch++;
    this.#inspected = undefined;
    this.#reviewDraftMaterial = undefined;
    this.#pendingReviewMaterials = new WeakMap();
  }

  hasReviewDraftMaterial(): boolean {
    return this.#reviewInspectionRequired && this.#reviewDraftMaterial !== undefined && this.#currentInspectionDelivery(this.#reviewDraftMaterial);
  }

  beginDraftAudit(): void {
    const material = this.#reviewDraftMaterial;
    const retained = material && this.#currentInspectionDelivery(material);
    this.#reviewEpoch++;
    this.#reviewDraftMaterial = retained ? { ...material, reviewEpoch: this.#reviewEpoch, formal: false } : undefined;
    this.#inspected = undefined;
    this.#previewed = undefined;
    this.#pendingReviewMaterials = new WeakMap();
  }

  hasCurrentReviewInspection(): boolean {
    const material = this.#reviewDraftMaterial;
    return Boolean(this.#reviewInspectionRequired && material?.formal && this.#inspected === this.#accepted && this.#currentInspectionDelivery(material)
      && (this.#discovery?.readyToCompose() ?? true));
  }

  #currentInspectionDelivery(delivery: DraftInspectionDelivery): boolean {
    return delivery.accepted === this.#accepted && delivery.reviewEpoch === this.#reviewEpoch
      && delivery.catalogRevision === this.#catalog.snapshot().revision && delivery.findingsRevision === this.#discovery?.snapshot()?.revision;
  }

  async submit(draft: ComparisonDraftSubmission): Promise<string> {
    if (this.#discovery && !this.#discovery.readyToCompose()) {
      this.#lastRejection = "findings_not_ready: Save findings and resolve decision questions or mark evidence unavailable before composing.";
      return `status=rejected\ncode=findings_not_ready\nmessage=${this.#lastRejection}`;
    }
    const discovery = this.#discovery?.snapshot();
    const contractError = decisionContractError(draft, discovery?.submission);
    if (contractError) {
      this.#lastRejection = contractError;
      return `status=rejected\n${contractError}`;
    }
    if (draft.decisionSummary !== undefined && discovery?.submission.importantLimitations.length && !draft.decisionBoundary?.trim()) {
      this.#lastRejection = "decision_boundary_missing: Saved important limitations require a visible decision boundary.";
      return `status=rejected\ncode=decision_boundary_missing\nimportantLimitations=${JSON.stringify(discovery.submission.importantLimitations)}\nmessage=These saved limitations are unverified model-authored repair material, not certified facts. Preserve those that change the task decision in decisionBoundary; do not mechanically copy the inventory or hide them only in details.`;
    }
    const catalog = this.#catalog.snapshot();
    const result: ComparisonResult = {
      status: draft.status,
      reportPath: "report.html",
      headline: draft.headline,
      evidenceRefs: citedEvidence(`${draft.comparisonHtml}${draft.detailsHtml ?? ""}`),
    };
    const details = `${draft.detailsHtml ?? ''}${decisionSupportDetailsHtml(draft, discovery?.submission, this.#locale)}`;
    const html = renderComparisonReportShell({
      task: this.#task,
      facts: this.#facts,
      metrics: metricsFromReportFacts(this.#facts),
      evidence: catalog.links,
      media: catalog.media,
      slots: {
        category: draft.category,
        headline: draft.headline,
        comparison: decisionTextHtml(draft, discovery?.submission, this.#locale),
        ...(details ? { details } : {}),
      },
      locale: this.#locale,
    });
    const verified = await verifyAndRenderComparisonReport({
      html, hostTask: this.#task, facts: this.#facts, result,
      attemptRoot: this.#attemptRoot, evidence: catalog.links, media: catalog.media,
      locale: this.#locale, deliveredImageContentHashes: this.#deliveredImages,
      ...(this.#quoteSources ? { quoteSources: this.#quoteSources } : {}),
    });
    if ("failureClass" in verified) {
      this.#lastRejection = `${verified.code}: ${verified.message}`;
      return `status=rejected\ncode=${verified.code}\nmessage=${verified.message}`;
    }
    const length = comparisonMainTextCharacters(verified.html);
    const target = draft.decisionShape === "single_difference" ? 250 : draft.decisionShape === "multiple_differences" ? 600 : undefined;
    if (target !== undefined && length > target) {
      this.#lastRejection = `draft_too_long: declared ${draft.decisionShape} has ${length} main characters; maximum=${target}.`;
      return `status=rejected\ncode=draft_too_long\ndecisionShape=${draft.decisionShape}\nmainTextCharacters=${length}\nvisibleMainText=${JSON.stringify(comparisonVisibleMainText(verified.html))}\nmaximum=${target}\nmessage=Shorten this actual visible text (including the headline) in one batch revision; do not write a shell counting script. Preserve decisive evidence, counterevidence and limitations that change the choice, and move routine methods to details. Do not relabel one difference as multiple to bypass the limit; then submit and preview.`;
    }
    const detailsLength = comparisonDetailsTextCharacters(verified.html, { excludeValidatedQuotes: true });
    const detailsMaximum = draft.decisionShape === "single_difference" ? 400 : draft.decisionShape === "multiple_differences" ? 1000 : undefined;
    if (detailsMaximum !== undefined && detailsLength > detailsMaximum) {
      this.#lastRejection = `draft_details_too_long: declared ${draft.decisionShape} has ${detailsLength} explanation characters; maximum=${detailsMaximum}.`;
      return `status=rejected\ncode=draft_details_too_long\ndecisionShape=${draft.decisionShape}\ndetailsTextCharacters=${detailsLength}\nmaximum=${detailsMaximum}\ndetailsText=${JSON.stringify(comparisonDetailsText(verified.html, { excludeValidatedQuotes: true }))}\nmessage=Keep only supporting arguments and limitations that change the decision. Remove repeated conclusions and routine inventories in one batch; folded and hidden explanations count. Validated fixed evidence quotes are excluded. Do not relabel one difference as multiple to bypass the limit.`;
    }
    await writeAtomic(join(this.#attemptRoot, "report.html"), verified.html);
    const digest = sha256(verified.html);
    const changed = this.#accepted?.digest !== digest || this.#accepted.revision !== catalog.revision || this.#accepted.discoveryRevision !== discovery?.revision || this.#accepted.decisionShape !== draft.decisionShape;
    if (changed && discovery && this.#persistAccepted) await this.#persistAccepted({ draftDigest: digest, catalogRevision: catalog.revision, findingsRevision: discovery.revision });
    if (changed) {
      this.#bindingRevision++;
      this.#previewed = undefined;
      this.#previewFailure = undefined;
      this.#inspected = undefined;
      this.#reviewDraftMaterial = undefined;
      this.#pendingReviewMaterials = new WeakMap();
    }
    if (changed) this.#accepted = { digest, revision: catalog.revision, ...(discovery ? { discoveryRevision: discovery.revision } : {}), result, ...(draft.decisionShape ? { decisionShape: draft.decisionShape } : {}) };
    this.#lastRejection = undefined;
    const feedback = length > 600
      ? "Shorten repeated conclusions and move methods to details in one batch revision; preserve decisive evidence and limitations, then preview. This is advisory, not a word-limit gate."
      : "Length below 600 (advisory). Preview the accepted draft rather than tuning its length repeatedly.";
    return `status=accepted\ndraftDigest=${digest}\nrevision=${catalog.revision}\ndecisionShape=${draft.decisionShape ?? "unknown"}\nmainTextMaximum=${target ?? "legacy_unbounded"}\ndetailsTextMaximum=${detailsMaximum ?? "legacy_unbounded"}\ndetailsTextCharacters=${detailsLength}\ndecisionShapeValidation=model_declaration_only\nmainTextCharacters=${length}\nreadabilityFeedback=${feedback}\nimportantLimitations=${JSON.stringify(discovery?.submission.importantLimitations ?? [])}\nSaved limitations are unverified semantic hypotheses: keep only those changing the task decision visible. Omit routine provenance, edit-history and metrics inventories already supplied by the Host. Details are optional; use them only for a necessary supporting argument or method boundary, not speculative descriptions of unused records.\nOnce accepted, inspect this actual current draft after any correction and preview its exact digest before finishing; reopen only for material evidence or failed validation, not repeated length tuning.`;
  }

  submissionState(): string {
    return JSON.stringify({ accepted: this.#accepted && { digest: this.#accepted.digest, revision: this.#accepted.revision, discoveryRevision: this.#accepted.discoveryRevision }, inspected: this.#inspected && { digest: this.#inspected.digest, revision: this.#inspected.revision, discoveryRevision: this.#inspected.discoveryRevision }, reviewInspectionRequired: this.#reviewInspectionRequired, previewed: this.#previewed, revision: this.#catalog.snapshot().revision, discoveryRevision: this.#discovery?.snapshot()?.revision, rejection: this.#lastRejection });
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
    this.#previewed = undefined;
  }

  async completedResult(): Promise<ComparisonResult | undefined> {
    const accepted = this.#accepted;
    const previewed = this.#previewed;
    if (this.#reviewInspectionRequired && (!accepted || this.#inspected !== accepted)) return undefined;
    if (this.#discovery && (!this.#discovery.readyToCompose() || accepted?.discoveryRevision !== this.#discovery.snapshot()?.revision)) return undefined;
    if (!accepted || !previewed || accepted.digest !== previewed.digest || accepted.revision !== previewed.revision) return undefined;
    const catalog = this.#catalog.snapshot();
    if (catalog.revision !== accepted.revision) return undefined;
    const html = await this.#readAcceptedHtml(accepted.digest);
    if (html === undefined) return undefined;
    if (sha256(html) !== accepted.digest) return undefined;
    const verified = await verifyAndRenderComparisonReport({
      html, hostTask: this.#task, facts: this.#facts, result: accepted.result,
      attemptRoot: this.#attemptRoot, evidence: catalog.links, media: catalog.media,
      locale: this.#locale, deliveredImageContentHashes: this.#deliveredImages,
      ...(this.#quoteSources ? { quoteSources: this.#quoteSources } : {}),
    });
    if (this.#accepted !== accepted || this.#previewed !== previewed || this.#catalog.snapshot().revision !== catalog.revision || this.#discovery?.snapshot()?.revision !== accepted.discoveryRevision
      || (this.#reviewInspectionRequired && this.#inspected !== accepted)) return undefined;
    return "failureClass" in verified ? undefined : accepted.result;
  }

  async #readAcceptedHtml(digest: string): Promise<string | undefined> {
    const html = await readFile(join(this.#attemptRoot, "report.html"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    return html !== undefined && sha256(html) === digest ? html : undefined;
  }

  failureReason(): { code: 'draft_invalid' | 'preview_failed'; message: string; kind?: 'protocol' | 'timeout' | 'tool' } {
    if (this.#discovery && (!this.#discovery.readyToCompose() || this.#accepted?.discoveryRevision !== this.#discovery.snapshot()?.revision)) return { code: 'draft_invalid', message: 'findings_not_ready: Update findings for the latest evidence catalog, resolve pending questions or explain unavailable evidence, then resubmit and preview the draft.' };
    if (!this.#accepted) return { code: 'draft_invalid', message: this.#lastRejection ?? 'No valid comparison draft was submitted.' };
    if (this.#reviewInspectionRequired && this.#inspected !== this.#accepted) return { code: 'draft_invalid', message: `final_inspection_required: Read the actual latest accepted draft with inspect_comparison_draft: digest=${this.#accepted.digest}. Check headline, comparison and all details including folded limitations against each other and the supported observations. This records content delivery, not semantic approval; any revision requires another inspection.` };
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
