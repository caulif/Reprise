import { Value } from "@sinclair/typebox/value";
import {
  ComparisonDiscoveryRecordSchema, ComparisonFindingsSubmissionSchema,
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
      description: "Save concise task criteria, final-source locations, scoped observations and decision questions. Every finding.criterion must exactly copy one criteria string. References must be registered. Saved findings do not prove semantic correctness. Resolve questions or explain unavailable evidence before composing; reopening a settled question requires new grounds.",
      parameters: ComparisonFindingsSubmissionSchema,
      execute: async (params, signal) => {
        signal.throwIfAborted();
        if (!Value.Check(ComparisonFindingsSubmissionSchema, params)) {
          const errors = [...Value.Errors(ComparisonFindingsSubmissionSchema, params)].slice(0, 3).map(error => ({ path: error.path, message: error.message }));
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
    if (this.#accepted?.submission.decisionQuestions.some((previous) => !submission.decisionQuestions.some((question) => question.id === previous.id))) return rejection("question_history_missing");
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
      if (new Set(finding.observations.map((item) => item.side)).size !== 2) return rejection("observation_sides");
      if (!validRefs(finding.counterEvidenceRefs)) return rejection("evidence_unresolved");
      for (const observation of finding.observations) {
        if (!validRefs(observation.evidenceRefs)) return rejection("evidence_unresolved");
        if (observation.method !== "unavailable" && !observation.evidenceRefs.length) return rejection("observation_evidence_missing");
        if (observation.evidenceRefs.some((ref) => {
          const side = lookup.get(ref)!.side;
          return side === "baseline" || side === "candidate" ? side !== observation.side : false;
        })) return rejection("observation_source_mismatch");
      }
    }
    for (const question of submission.decisionQuestions) {
      if (!validRefs(question.evidenceRefs)) return rejection("evidence_unresolved");
      if (question.status === "pending" && !question.nextCheck) return rejection("next_check_missing");
      if (question.status !== "pending" && !question.resolution) return rejection("resolution_missing");
      const previous = this.#accepted?.submission.decisionQuestions.find((item) => item.id === question.id);
      if (previous && (previous.question !== question.question || previous.decisionImpact !== question.decisionImpact)) return rejection("question_identity_changed");
      if (previous && previous.status !== "pending" && question.status === "pending" && !question.reopenReason) return rejection("reopen_reason_missing");
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
