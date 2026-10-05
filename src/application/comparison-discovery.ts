import { Value } from "@sinclair/typebox/value";
import {
  ComparisonDiscoveryRecordSchema, ComparisonFindingsToolSubmissionSchema, ComparisonFindingsCompleteToolSubmissionSchema,
  type ComparisonDiscoveryRecord, type ComparisonFindingsSubmission, type ComparisonInvestigationClosure, type ComparisonFindingsDelta,
} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import type { AgentToolDefinition } from "../infrastructure/agent/host.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";
import { materializeFindingsDelta } from './comparison-findings-delta.js';

export class ComparisonDiscovery {
  readonly #catalog: ComparisonEvidenceCatalog;
  readonly #attemptId: string;
  readonly #persist: (record: ComparisonDiscoveryRecord) => Promise<void>;
  #accepted: ComparisonDiscoveryRecord | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    catalog: ComparisonEvidenceCatalog;
    attemptId: string;
    persist: (record: ComparisonDiscoveryRecord) => Promise<void>;
  }) {
    this.#catalog = input.catalog;
    this.#attemptId = input.attemptId;
    this.#persist = input.persist;
  }

  tool(): AgentToolDefinition {
    return {
      name: "update_comparison_findings",
      description: "Submit a complete initial findings snapshot. With a saved binding, prefer kind=delta against current state.binding. Delta requires one explicit retain/replace decision for every state.findingIds and state.questionIds; replacement objects are complete, existing IDs cannot be omitted, added or deleted, and retained objects are not implicit semantic approval. Use the complete variant for new findings or questions. Task criteria, final-source locations, scoped observations and question history remain mandatory in the materialized record. Each finding has exactly one baseline and one candidate observation; retain historical question and decisionImpact identity. References must be registered. Every observation needs supportBoundary with the same compared relationship, domain, coveredInstances and uncheckedInstances. delivered_output requires actual downstream drawn/written/returned output support and covered instances, not reconstructed targets or self-reports. Unknown checks remain unavailable or conditional with decisive limitations; retaining a pending question does not make findings ready. New grounds and reopenReason are required to reopen settled questions. Both variants run the same full validation; acceptance validates provenance and structure, never semantic truth.",
      parameters: ComparisonFindingsToolSubmissionSchema,
      execute: async (params, signal) => {
        signal.throwIfAborted();
        if (!Value.Check(ComparisonFindingsToolSubmissionSchema, params)) {
          const errors = [...Value.Errors(ComparisonFindingsToolSubmissionSchema, params)].slice(0, 3).map(error => ({ path: error.path, message: error.message }));
          return { content: `status=rejected\ncode=invalid_findings\nerrors=${JSON.stringify(errors)}\nCorrect these fields and resubmit the complete snapshot or strictly bound delta.` };
        }
        const input = structuredClone(params);
        return { content: await this.#enqueue(() => 'kind' in input ? this.#delta(input, signal) : this.#update(input, signal)) };
      },
    };
  }

  update(submission: ComparisonFindingsSubmission, signal?: AbortSignal): Promise<string> {
    return this.#enqueue(() => this.#update(submission, signal));
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(work);
    // Rejection must not poison scheduling; the original operation still rejects to its caller.
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #delta(delta: ComparisonFindingsDelta, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const base = this.#accepted;
    if (!base) return 'status=rejected\ncode=delta_snapshot_missing';
    const currentBinding = () => this.#accepted === base && delta.binding.catalogRevision === this.#catalog.snapshot().revision;
    if (delta.binding.revision !== base.revision || delta.binding.digest !== base.digest || !currentBinding()) return 'status=rejected\ncode=delta_binding_stale';
    const submission = materializeFindingsDelta(base.submission, delta);
    if (!submission) return 'status=rejected\ncode=delta_decisions_invalid';
    if (!Value.Check(ComparisonFindingsCompleteToolSubmissionSchema, submission)) return 'status=rejected\ncode=delta_materialized_invalid';
    return await this.#update(submission, signal, currentBinding);
  }

  async #update(submission: ComparisonFindingsSubmission, signal?: AbortSignal, currentBinding?: () => boolean): Promise<string> {
    signal?.throwIfAborted();
    const catalog = this.#catalog.snapshot();
    const entries = [...catalog.links, ...catalog.media];
    const lookup = new Map(entries.filter((item) => item.shortRef).map((item) => [item.shortRef!, item]));
    const rejection = (code: string) => `status=rejected\ncode=${code}`;
    const unique = (values: readonly { id: string }[]) => new Set(values.map((item) => item.id)).size === values.length;
    if (!unique(submission.findings) || !unique(submission.decisionQuestions)) return rejection("duplicate_id");
    const existingQuestions = this.#accepted?.submission.decisionQuestions ?? [];
    const missingQuestionIds = existingQuestions.filter(previous => !submission.decisionQuestions.some(question => question.id === previous.id)).map(question => question.id);
    if (missingQuestionIds.length) return `${rejection("question_history_missing")}\nrepair=${JSON.stringify({
      requiredQuestionIds: existingQuestions.map(question => question.id), missingQuestionIds, existingQuestions,
      semanticAssessment: "not_certified", repairRequirement: "Resubmit a complete snapshot including every required question ID and unchanged question/decisionImpact. These prior model-authored objects are repair material, not verified answers. Independently reassess evidence; do not automatically resolve questions. A settled question may return to pending only with reopenReason. Keep the 16-question and field-length limits.",
    })}`;
    if (new Set(submission.finals.map((item) => item.side)).size !== 2) return rejection("final_sides");
    const validRefs = (refs: readonly string[], owner?: "baseline" | "candidate") => refs.every((ref) => {
      const entry = lookup.get(ref);
      return entry && (!owner || entry.side === owner);
    });
    const refRejection = (code: string, location: string, submittedRefs: readonly string[], context: {
      side?: "baseline" | "candidate"; findingId?: string; questionId?: string; allowNeutral?: boolean;
    } = {}) => {
      const describe = (ref: string) => {
        const item = lookup.get(ref);
        if (!item) return { ref, status: "not_found" };
        return { ref, status: "catalog_registered", side: item.side,
          kind: "available" in item ? "media" : "evidence",
          ...("available" in item ? { available: item.available } : {}),
          ...("origin" in item && item.origin ? { origin: item.origin } : {}),
          ...("sourceRefs" in item ? { sourceShortRefs: (item.sourceRefs ?? []).filter(source => /^(ev|media)-[0-9]{2,6}$/.test(source)).slice(0, 12) } : {}),
        };
      };
      const eligible = [...lookup].filter(([, item]) => (!context.side || item.side === context.side
        || (context.allowNeutral && (item.side === "host" || item.side === "derived")))
        && (!("available" in item) || item.available)).map(([ref]) => ref);
      const { allowNeutral: _allowNeutral, ...identity } = context;
      return `${rejection(code)}\nrepair=${JSON.stringify({
        location, ...identity, submittedRefs, submittedRefMetadata: submittedRefs.map(describe),
        catalogRevision: catalog.revision, catalogEntries: eligible.slice(0, 12).map(describe),
        omittedCatalogEntries: Math.max(0, eligible.length - 12),
        semanticAssessment: "not_certified",
        repairRequirement: "Independently choose references supported by actual retained observations and this registered metadata. The bounded directory lists possible references, not replacements or certified evidence. Additional catalog navigation is subject to phase resource limits and may be unavailable; do not retry denied reads. If shown metadata and retained observations cannot establish a source, keep that uncertainty and qualify the decision instead of inventing evidence. Do not change side, criterion or question identity merely to bypass ownership. Resubmit the complete snapshot preserving question history; rejected submissions do not change accepted state.",
      })}`;
    };
    for (const [finalIndex, final] of submission.finals.entries()) {
      if (!validRefs(final.sourceRefs, final.side)) return refRejection("final_source_mismatch", `finals[${finalIndex}].sourceRefs`, final.sourceRefs, { side: final.side });
      if (final.status === "located" && !final.sourceRefs.length) return refRejection("final_source_missing", `finals[${finalIndex}].sourceRefs`, final.sourceRefs, { side: final.side });
    }
    for (const [findingIndex, finding] of submission.findings.entries()) {
      if (!submission.criteria.includes(finding.criterion)) return `${rejection("criterion_unresolved")}\nfindingId=${finding.id}\ncriterion=${JSON.stringify(finding.criterion)}\nallowedCriteria=${JSON.stringify(submission.criteria)}\nCopy one allowedCriteria string exactly into finding.criterion, then resubmit.`;
      if (new Set(finding.observations.map((item) => item.side)).size !== 2) return `${rejection("observation_sides")}\nrepair=${JSON.stringify({
        findingId: finding.id, actualSideCounts: { baseline: finding.observations.filter(item => item.side === 'baseline').length, candidate: finding.observations.filter(item => item.side === 'candidate').length },
        requiredSides: ['baseline', 'candidate'], expectedCount: 2,
        repairRequirement: 'Resubmit the complete snapshot with exactly one baseline and one candidate observation per finding, preserving all question history. Combine same-side measurements in its single result and scope. Use method=unavailable with explicit uncertainty for an unverified side; do not invent evidence or change a side label without supporting ownership. This shape feedback certifies no observation or conclusion.',
      })}`;
      if (!validRefs(finding.counterEvidenceRefs)) return refRejection("evidence_unresolved", `findings[${findingIndex}].counterEvidenceRefs`, finding.counterEvidenceRefs, { findingId: finding.id });
      for (const [observationIndex, observation] of finding.observations.entries()) {
        const location = `findings[${findingIndex}].observations[${observationIndex}].evidenceRefs`;
        const identity = { findingId: finding.id, side: observation.side, allowNeutral: true };
        if (observation.supportBoundary?.supportStage === "delivered_output"
          && (observation.method === "unavailable" || observation.method === "self_report")) return rejection("support_method_mismatch");
        if (!validRefs(observation.evidenceRefs)) return refRejection("evidence_unresolved", location, observation.evidenceRefs, identity);
        if (observation.method !== "unavailable" && !observation.evidenceRefs.length) return refRejection("observation_evidence_missing", location, observation.evidenceRefs, identity);
        if (observation.evidenceRefs.some((ref) => {
          const side = lookup.get(ref)!.side;
          return side === "baseline" || side === "candidate" ? side !== observation.side : false;
        })) return refRejection("observation_source_mismatch", location, observation.evidenceRefs, identity);
      }
    }
    for (const [questionIndex, question] of submission.decisionQuestions.entries()) {
      const questionRejection = (code: string, repairRequirement: string, details: Record<string, unknown> = {}) => `${rejection(code)}\nrepair=${JSON.stringify({ questionId: question.id, repairRequirement, ...details })}`;
      if (!validRefs(question.evidenceRefs)) return refRejection("evidence_unresolved", `decisionQuestions[${questionIndex}].evidenceRefs`, question.evidenceRefs, { questionId: question.id });
      if (question.status === "pending" && !question.nextCheck) return questionRejection("next_check_missing", "Supply a nonempty nextCheck for this pending question and resubmit the complete snapshot; do not change status merely to bypass the requirement.");
      if (question.status !== "pending" && !question.resolution) return questionRejection("resolution_missing", "Supply a nonempty evidence-grounded resolution for this resolved/unavailable question and resubmit the complete snapshot; registration does not certify the resolution.");
      const previous = this.#accepted?.submission.decisionQuestions.find((item) => item.id === question.id);
      if (previous && (previous.question !== question.question || previous.decisionImpact !== question.decisionImpact)) return questionRejection("question_identity_changed", "Restore the exact previous question and decisionImpact for this ID. Add a distinct question under a new ID if needed, preserving all prior questions within the 16-question limit.", { previousIdentity: { id: previous.id, question: previous.question, decisionImpact: previous.decisionImpact }, semanticAssessment: "not_certified" });
      if (previous && previous.status !== "pending" && question.status === "pending" && !question.reopenReason) return questionRejection("reopen_reason_missing", "Supply a nonempty reopenReason explaining new grounds for reopening this settled question, plus nextCheck; do not erase its history or automatically resolve it.", { previousStatus: previous.status });
    }
    const data = structuredClone(submission);
    const digest = sha256(JSON.stringify(data));
    if (this.#accepted?.digest === digest && this.#accepted.catalogRevision === catalog.revision) return this.#receipt(this.#accepted);
    const record: ComparisonDiscoveryRecord = {
      schemaVersion: 1, attemptId: this.#attemptId, revision: (this.#accepted?.revision ?? 0) + 1,
      catalogRevision: catalog.revision, digest, submission: data,
    };
    if (!Value.Check(ComparisonDiscoveryRecordSchema, record)) throw new Error("Invalid comparison discovery persistence record.");
    if (currentBinding && !currentBinding()) return 'status=rejected\ncode=delta_binding_stale';
    await this.#persist(structuredClone(record));
    if (currentBinding) { signal?.throwIfAborted(); if (!currentBinding()) throw new Error('Delta findings binding changed during persistence; acceptance is forbidden.'); }
    this.#accepted = record;
    return this.#receipt(record);
  }

  closeAtInvestigationDeadline(signal: AbortSignal): Promise<ComparisonInvestigationClosure> {
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      const previous = this.snapshot();
      if (!previous) throw new Error('Investigation deadline closure requires an actually accepted findings snapshot.');
      const submission = structuredClone(previous.submission);
      const questionIds = submission.decisionQuestions.filter(question => question.status === 'pending').map(question => question.id);
      for (const question of submission.decisionQuestions) if (question.status === 'pending') {
        question.status = 'unavailable';
        question.resolution = 'Host process boundary: the actual investigation deadline ended before this pending question was checked. This is not a semantic answer, does not establish that evidence is absent, and leaves the original decisionImpact unverified.';
      }
      const receipt = await this.#update(submission, signal);
      if (!receipt.startsWith('status=accepted\n') || !this.readyToCompose()) throw new Error('Investigation deadline closure failed the current findings/catalog validation.');
      const current = this.snapshot()!;
      const binding = (record: ComparisonDiscoveryRecord) => ({ revision: record.revision, catalogRevision: record.catalogRevision, digest: record.digest });
      return { previous: binding(previous), current: binding(current), questionIds };
    });
  }

  #receipt(record: ComparisonDiscoveryRecord): string {
    const receipt = { revision: record.revision, catalogRevision: record.catalogRevision, digest: record.digest, readyToCompose: this.readyToCompose(),
      binding: { revision: record.revision, catalogRevision: this.#catalog.snapshot().revision, digest: record.digest },
      findingIds: record.submission.findings.map(item => item.id), questionIds: record.submission.decisionQuestions.map(item => item.id),
      pendingQuestions: record.submission.decisionQuestions.filter(question => question.status === 'pending').map(question => question.id),
      importantLimitationCount: record.submission.importantLimitations.length };
    return `status=accepted\n${JSON.stringify(receipt)}\nKeep decision-changing limitations visible next to the conclusion. Omit routine provenance, missing metrics and edit-history inventories already covered by the Host; details are optional and only needed for a substantive reproducible argument or method boundary. Registration validates references and scope fields, not the truth of natural-language claims.`;
  }

  snapshot(): ComparisonDiscoveryRecord | undefined { return this.#accepted && structuredClone(this.#accepted); }
  readyToCompose(): boolean { return !!this.#accepted && this.#accepted.catalogRevision === this.#catalog.snapshot().revision && this.#accepted.submission.decisionQuestions.every((item) => item.status !== "pending"); }
  state(): string { return JSON.stringify({ revision: this.#accepted?.revision ?? 0, readyToCompose: this.readyToCompose(),
    binding: this.#accepted && { revision: this.#accepted.revision, digest: this.#accepted.digest, catalogRevision: this.#catalog.snapshot().revision },
    findingIds: this.#accepted?.submission.findings.map(item => item.id) ?? [], questionIds: this.#accepted?.submission.decisionQuestions.map(item => item.id) ?? [], record: this.#accepted }); }
}
