import { Value } from "@sinclair/typebox/value";
import {
  ComparisonDiscoveryRecordSchema, ComparisonFindingsToolSubmissionSchema,
  type ComparisonDiscoveryRecord, type ComparisonFindingsSubmission,
} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import type { AgentToolDefinition } from "../infrastructure/agent/host.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";

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
      description: "Replace the complete findings snapshot: concise task criteria, final-source locations, scoped observations and decision questions. Each finding has exactly two observations: one baseline and one candidate. Combine same-side measurements in its single result and scope; use method=unavailable for an unverified side, never invent its evidence. Include every previously accepted decision question ID with its unchanged question and decisionImpact; history cannot be erased, even after catalog changes. Rejection repair materials are prior model-authored claims, not certified semantics. Every finding.criterion must exactly copy one criteria string. References must be registered. Resolve questions or explain unavailable evidence before composing; reopening a settled question requires new grounds. Every observation must include supportBoundary: name the same compared relationship on both sides, the domain, coveredInstances and uncheckedInstances. Trace any downstream transformation, write, or returned value to the actual delivered output before declaring supportStage=delivered_output; intermediate targets or self-reports are intermediate_only, never output observation. delivered_output requires at least one covered instance; unavailable has no covered instances. A sample covers only the declared instances, not all outputs. Source inspection can trace delivered output; method does not determine supportStage. If an instance or side cannot be checked, mark it unchecked/unavailable with a decision-changing limitation and finish conditionally instead of exploring indefinitely. These scope declarations are model-authored and not Host semantic certification. Saved findings do not prove semantic correctness.",
      parameters: ComparisonFindingsToolSubmissionSchema,
      execute: async (params, signal) => {
        signal.throwIfAborted();
        if (!Value.Check(ComparisonFindingsToolSubmissionSchema, params)) {
          const errors = [...Value.Errors(ComparisonFindingsToolSubmissionSchema, params)].slice(0, 3).map(error => ({ path: error.path, message: error.message }));
          return { content: `status=rejected\ncode=invalid_findings\nerrors=${JSON.stringify(errors)}\nCorrect these fields and resubmit the complete findings record.` };
        }
        const operation = this.#queue.then(() => this.update(params, signal));
        this.#queue = operation.catch(() => undefined);
        return { content: await operation };
      },
    };
  }

  async update(submission: ComparisonFindingsSubmission, signal?: AbortSignal): Promise<string> {
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
    for (const final of submission.finals) {
      if (!validRefs(final.sourceRefs, final.side)) return rejection("final_source_mismatch");
      if (final.status === "located" && !final.sourceRefs.length) return rejection("final_source_missing");
    }
    for (const finding of submission.findings) {
      if (!submission.criteria.includes(finding.criterion)) return `${rejection("criterion_unresolved")}\nfindingId=${finding.id}\ncriterion=${JSON.stringify(finding.criterion)}\nallowedCriteria=${JSON.stringify(submission.criteria)}\nCopy one allowedCriteria string exactly into finding.criterion, then resubmit.`;
      if (new Set(finding.observations.map((item) => item.side)).size !== 2) return `${rejection("observation_sides")}\nrepair=${JSON.stringify({
        findingId: finding.id, actualSideCounts: { baseline: finding.observations.filter(item => item.side === 'baseline').length, candidate: finding.observations.filter(item => item.side === 'candidate').length },
        requiredSides: ['baseline', 'candidate'], expectedCount: 2,
        repairRequirement: 'Resubmit the complete snapshot with exactly one baseline and one candidate observation per finding, preserving all question history. Combine same-side measurements in its single result and scope. Use method=unavailable with explicit uncertainty for an unverified side; do not invent evidence or change a side label without supporting ownership. This shape feedback certifies no observation or conclusion.',
      })}`;
      if (!validRefs(finding.counterEvidenceRefs)) return rejection("evidence_unresolved");
      for (const observation of finding.observations) {
        if (observation.supportBoundary?.supportStage === "delivered_output"
          && (observation.method === "unavailable" || observation.method === "self_report")) return rejection("support_method_mismatch");
        if (!validRefs(observation.evidenceRefs)) return rejection("evidence_unresolved");
        if (observation.method !== "unavailable" && !observation.evidenceRefs.length) return rejection("observation_evidence_missing");
        if (observation.evidenceRefs.some((ref) => {
          const side = lookup.get(ref)!.side;
          return side === "baseline" || side === "candidate" ? side !== observation.side : false;
        })) return rejection("observation_source_mismatch");
      }
    }
    for (const question of submission.decisionQuestions) {
      const questionRejection = (code: string, repairRequirement: string, details: Record<string, unknown> = {}) => `${rejection(code)}\nrepair=${JSON.stringify({ questionId: question.id, repairRequirement, ...details })}`;
      if (!validRefs(question.evidenceRefs)) return rejection("evidence_unresolved");
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
    await this.#persist(structuredClone(record));
    this.#accepted = record;
    return this.#receipt(record);
  }

  #receipt(record: ComparisonDiscoveryRecord): string {
    const receipt = { revision: record.revision, catalogRevision: record.catalogRevision, digest: record.digest, readyToCompose: this.readyToCompose(),
      pendingQuestions: record.submission.decisionQuestions.filter(question => question.status === 'pending').map(question => question.id),
      importantLimitationCount: record.submission.importantLimitations.length };
    return `status=accepted\n${JSON.stringify(receipt)}\nKeep decision-changing limitations visible next to the conclusion. Omit routine provenance, missing metrics and edit-history inventories already covered by the Host; details are optional and only needed for a substantive reproducible argument or method boundary. Registration validates references and scope fields, not the truth of natural-language claims.`;
  }

  snapshot(): ComparisonDiscoveryRecord | undefined { return this.#accepted && structuredClone(this.#accepted); }
  readyToCompose(): boolean { return !!this.#accepted && this.#accepted.catalogRevision === this.#catalog.snapshot().revision && this.#accepted.submission.decisionQuestions.every((item) => item.status !== "pending"); }
  state(): string { return JSON.stringify({ revision: this.#accepted?.revision ?? 0, readyToCompose: this.readyToCompose(), record: this.#accepted }); }
}
