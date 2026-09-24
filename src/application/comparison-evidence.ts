import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import { isFsAbsolute, pathContainedBy } from "../core/paths.js";
import {
  ComparisonEvidenceCatalogSchema,
  ComparisonEvidenceRegisteredPayloadSchema,
  ComparisonLinksSchema,
  ComparisonMediaRecordSchema,
  type ComparisonEvidenceCatalogSnapshot,
  type ComparisonEvidenceOrigin,
  type ComparisonEvidenceRegisteredPayload,
  type ComparisonEvidenceRegistrationDerivation,
  type ComparisonLinkRecord,
  type ComparisonMediaDerivation,
  type ComparisonMediaRecord,
  type EventEnvelope,
} from "../core/schema.js";
import { isMissing } from "./experiment-helpers.js";
import { appendEvidenceShortRefs, appendMediaShortRefs } from "./comparison-short-refs.js";

export const MAX_REGISTERED_EVIDENCE_BYTES = 1_048_576;

export type ComparisonCatalogSnapshot = ComparisonEvidenceCatalogSnapshot;

export type RegisterEvidenceInput = {
  relativePath: string;
  sourceRefs: readonly string[];
  label: string;
  toolCallId?: string;
};

export type RegisterEvidenceResult =
  | {
      status: "registered";
      revision: number;
      shortRef: string;
      contentHash: string;
      inspectPath: string;
      origin: ComparisonEvidenceOrigin;
      deduplicated: boolean;
    }
  | {
      status: "rejected";
      code:
        | "path_invalid"
        | "path_escape"
        | "too_large"
        | "missing_source"
        | "tool_call_invalid"
        | "cancelled"
        | "io_failed";
      message: string;
    };

export type RegisterMediaInput = {
  record: Omit<ComparisonMediaRecord, "shortRef"> & { shortRef?: string };
  sourceRefs?: readonly string[];
  origin: ComparisonEvidenceOrigin;
  derivation?: ComparisonMediaDerivation;
};

type CatalogPersister = {
  attemptRoot: string;
  attemptId: string;
  emitRegistered?: (payload: ComparisonEvidenceRegisteredPayload) => Promise<void>;
  emitRegisteredBatch?: (payloads: readonly ComparisonEvidenceRegisteredPayload[]) => Promise<void>;
  lookupToolCall?: (toolCallId: string) => Promise<{ ok: boolean; message?: string }>;
};

type CommitAppendInput = {
  kind: "evidence" | "media";
  origin: ComparisonEvidenceOrigin;
  sourceRefs: readonly string[];
  artifactRefs: readonly string[];
  contentHash: string;
  inspectPath: string;
  shortRef: string;
  derivation?: ComparisonEvidenceRegisteredPayload["derivation"];
  apply: () => void;
  rollback: () => void;
};

export class ComparisonEvidenceCatalog {
  #revision = 0;
  #links: ComparisonLinkRecord[] = [];
  #media: ComparisonMediaRecord[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  readonly #pendingEmits = new Map<string, ComparisonEvidenceRegisteredPayload>();
  readonly #emittedShortRefs = new Set<string>();
  readonly #attemptRoot: string;
  readonly #attemptId: string;
  readonly #emitRegistered?: CatalogPersister["emitRegistered"];
  readonly #emitRegisteredBatch?: CatalogPersister["emitRegisteredBatch"];
  readonly #lookupToolCall?: CatalogPersister["lookupToolCall"];

  private constructor(input: CatalogPersister & {
    links: readonly ComparisonLinkRecord[];
    media: readonly ComparisonMediaRecord[];
    revision: number;
  }) {
    this.#attemptRoot = input.attemptRoot;
    this.#attemptId = input.attemptId;
    this.#links = [...input.links];
    this.#media = [...input.media];
    this.#revision = input.revision;
    this.#emitRegistered = input.emitRegistered;
    this.#emitRegisteredBatch = input.emitRegisteredBatch;
    this.#lookupToolCall = input.lookupToolCall;
  }

  static async create(input: {
    attemptRoot: string;
    attemptId: string;
    links: readonly ComparisonLinkRecord[];
    media: readonly ComparisonMediaRecord[];
    emitRegistered?: CatalogPersister["emitRegistered"];
    emitRegisteredBatch?: CatalogPersister["emitRegisteredBatch"];
    lookupToolCall?: CatalogPersister["lookupToolCall"];
  }): Promise<ComparisonEvidenceCatalog> {
    const links = appendEvidenceShortRefs([], input.links);
    const media = appendMediaShortRefs([], input.media);
    const catalog = new ComparisonEvidenceCatalog({
      attemptRoot: input.attemptRoot,
      attemptId: input.attemptId,
      links,
      media,
      revision: 0,
      ...(input.emitRegistered ? { emitRegistered: input.emitRegistered } : {}),
      ...(input.emitRegisteredBatch ? { emitRegisteredBatch: input.emitRegisteredBatch } : {}),
      ...(input.lookupToolCall ? { lookupToolCall: input.lookupToolCall } : {}),
    });
    await catalog.#persistRevision();
    return catalog;
  }

  snapshot(): ComparisonCatalogSnapshot {
    const snap = {
      schemaVersion: 1 as const,
      attemptId: this.#attemptId,
      revision: this.#revision,
      links: this.#links.map((link) => ({ ...link })),
      media: this.#media.map((item) => ({ ...item })),
    };
    if (!Value.Check(ComparisonEvidenceCatalogSchema, snap)) {
      throw new Error("Comparison evidence catalog snapshot does not satisfy schema.");
    }
    return snap;
  }

  getEvidenceCatalog(): ComparisonCatalogSnapshot {
    return this.snapshot();
  }

  evidenceShortRefs(): readonly string[] {
    return this.#links.flatMap((link) => (link.shortRef ? [link.shortRef] : []));
  }

  mediaShortRefs(): readonly string[] {
    return this.#media.flatMap((item) => (item.shortRef ? [item.shortRef] : []));
  }

  async registerEvidence(input: RegisterEvidenceInput, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    return this.#enqueue(() => this.#registerEvidenceLocked(input, signal));
  }

  async registerMedia(input: RegisterMediaInput, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    return this.#enqueue(() => this.#registerMediaLocked(input, signal));
  }

  async registerMediaBatch(inputs: readonly RegisterMediaInput[], signal?: AbortSignal): Promise<RegisterEvidenceResult[]> {
    return this.#enqueue(() => this.#registerMediaBatchLocked(inputs, signal));
  }

  async #registerEvidenceLocked(input: RegisterEvidenceInput, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    if (signal?.aborted) return { status: "rejected", code: "cancelled", message: "Registration cancelled." };
    const resolved = await resolveScratchFile(this.#attemptRoot, input.relativePath);
    if (resolved.status === "rejected") return resolved;
    if (signal?.aborted) return { status: "rejected", code: "cancelled", message: "Registration cancelled." };

    const precondition = await this.#validateRegisterPreconditions(input);
    if (precondition) return precondition;

    const loaded = await readScratchEvidenceBytes(resolved.absolute);
    if (loaded.status === "rejected") return loaded;
    const { bytes } = loaded;
    const contentHash = sha256(bytes);
    const sourceRefs = [...input.sourceRefs];
    const dedupeKey = evidenceDedupeKey({ contentHash, sourceRefs, origin: "derived_analysis" });
    const existing = this.#links.find((link) => link.contentHash === contentHash
      && link.origin === "derived_analysis"
      && sameStringSet(link.sourceRefs ?? [], sourceRefs));
    if (existing?.shortRef) {
      return this.#finishExistingRegistration({
        kind: "evidence",
        shortRef: existing.shortRef,
        contentHash,
        inspectPath: existing.inspectPath,
        origin: "derived_analysis",
        sourceRefs,
        artifactRefs: [existing.inspectPath],
        derivation: registrationDerivation(input, dedupeKey),
      });
    }

    const inspectPath = `evidence/derived/${contentHash.slice(0, 16)}`;
    const absoluteOut = join(this.#attemptRoot, ...inspectPath.split("/"));
    try {
      await mkdir(dirname(absoluteOut), { recursive: true });
      await writeAtomic(absoluteOut, bytes);
    } catch (error) {
      return { status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) };
    }

    const draft: ComparisonLinkRecord = {
      side: "derived",
      inspectPath,
      reportHref: inspectPath,
      mediaType: guessMediaType(input.relativePath, bytes),
      byteLength: bytes.byteLength,
      label: input.label.trim() || "derived analysis",
      origin: "derived_analysis",
      contentHash,
      sourceRefs,
    };
    if (!Value.Check(ComparisonLinksSchema, [draft])) {
      return { status: "rejected", code: "io_failed", message: "Derived evidence link failed schema validation." };
    }
    const assigned = appendEvidenceShortRefs(this.#links, [draft])[0];
    if (!assigned?.shortRef) {
      return { status: "rejected", code: "io_failed", message: "Failed to allocate evidence shortRef." };
    }
    const previous = this.#links;
    return this.#commitAppend({
      kind: "evidence",
      origin: "derived_analysis",
      sourceRefs,
      artifactRefs: [inspectPath],
      contentHash,
      inspectPath,
      shortRef: assigned.shortRef,
      derivation: registrationDerivation(input, dedupeKey),
      apply: () => {
        this.#links = [...previous, assigned];
      },
      rollback: () => {
        this.#links = previous;
      },
    });
  }

  async #registerMediaLocked(input: {
    record: Omit<ComparisonMediaRecord, "shortRef"> & { shortRef?: string };
    sourceRefs?: readonly string[];
    origin: ComparisonEvidenceOrigin;
    derivation?: ComparisonMediaDerivation;
  }, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    if (signal?.aborted) return { status: "rejected", code: "cancelled", message: "Registration cancelled." };
    const sourceRefs = [...(input.sourceRefs ?? [])];
    for (const ref of sourceRefs) {
      if (!this.#hasSourceRef(ref)) {
        return { status: "rejected", code: "missing_source", message: `Unknown sourceRef: ${ref}` };
      }
    }
    const contentHash = input.record.contentHash;
    if (!contentHash) {
      return { status: "rejected", code: "io_failed", message: "Media registration requires contentHash." };
    }
    const derivation = input.derivation ?? input.record.derivation;
    const existing = this.#media.find((item) =>
      item.contentHash === contentHash
      && item.side === input.record.side
      && mediaDerivationKey(item.derivation) === mediaDerivationKey(derivation));
    if (existing?.shortRef) {
      return this.#finishExistingRegistration({
        kind: "media",
        shortRef: existing.shortRef,
        contentHash,
        inspectPath: existing.inspectPath,
        origin: input.origin,
        sourceRefs,
        artifactRefs: [existing.reportHref],
        ...(derivation ? { derivation } : {}),
      });
    }

    const draft: ComparisonMediaRecord = {
      ...input.record,
      contentHash,
      ...(derivation ? { derivation } : {}),
    };
    if (!Value.Check(ComparisonMediaRecordSchema, draft)) {
      return { status: "rejected", code: "io_failed", message: "Media record failed schema validation." };
    }
    const assigned = appendMediaShortRefs(this.#media, [draft])[0];
    if (!assigned?.shortRef) {
      return { status: "rejected", code: "io_failed", message: "Failed to allocate media shortRef." };
    }
    const previous = this.#media;
    return this.#commitAppend({
      kind: "media",
      origin: input.origin,
      sourceRefs,
      artifactRefs: [assigned.reportHref],
      contentHash,
      inspectPath: assigned.inspectPath,
      shortRef: assigned.shortRef,
      ...(derivation ? { derivation } : {}),
      apply: () => {
        this.#media = [...previous, assigned];
      },
      rollback: () => {
        this.#media = previous;
      },
    });
  }

  async #registerMediaBatchLocked(inputs: readonly RegisterMediaInput[], signal?: AbortSignal): Promise<RegisterEvidenceResult[]> {
    if (inputs.length === 0) return [];
    if (signal?.aborted) return inputs.map(() => ({ status: "rejected", code: "cancelled", message: "Registration cancelled." }));
    const previous = this.#media;
    const previousSnapshot = this.snapshot();
    const drafts: ComparisonMediaRecord[] = [];
    const results: RegisterEvidenceResult[] = [];
    results.length = inputs.length;
    const draftIndexByInput: number[] = [];
    const draftInputIndexes: number[] = [];
    const draftIndexByKey = new Map<string, number>();
    for (const [index, input] of inputs.entries()) {
      const sourceRefs = [...(input.sourceRefs ?? [])];
      if (sourceRefs.some((ref) => !this.#hasSourceRef(ref))) {
        return inputs.map(() => ({ status: "rejected", code: "missing_source", message: "Unknown sourceRef for media batch." }));
      }
      const contentHash = input.record.contentHash;
      if (!contentHash) return inputs.map(() => ({ status: "rejected", code: "io_failed", message: "Media registration requires contentHash." }));
      const derivation = input.derivation ?? input.record.derivation;
      const existing = this.#media.find((item) => item.contentHash === contentHash
        && item.side === input.record.side
        && mediaDerivationKey(item.derivation) === mediaDerivationKey(derivation));
      if (existing?.shortRef) {
        try {
          results[index] = await this.#finishExistingRegistration({
            kind: "media",
            shortRef: existing.shortRef,
            contentHash,
            inspectPath: existing.inspectPath,
            origin: input.origin,
            sourceRefs,
            artifactRefs: [existing.reportHref],
            ...(derivation ? { derivation } : {}),
          });
        } catch (error) {
          return inputs.map(() => ({ status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) }));
        }
        continue;
      }
      const draft: ComparisonMediaRecord = { ...input.record, contentHash, ...(derivation ? { derivation } : {}) };
      if (!Value.Check(ComparisonMediaRecordSchema, draft)) {
        return inputs.map(() => ({ status: "rejected", code: "io_failed", message: "Media record failed schema validation." }));
      }
      const key = mediaRegistrationKey(contentHash, draft.side, derivation);
      const existingDraftIndex = draftIndexByKey.get(key);
      if (existingDraftIndex !== undefined) {
        draftIndexByInput[index] = existingDraftIndex;
      } else {
        draftIndexByKey.set(key, drafts.length);
        draftIndexByInput[index] = drafts.length;
        draftInputIndexes.push(index);
        drafts.push(draft);
      }
    }
    const assigned = appendMediaShortRefs(this.#media, drafts);
    if (assigned.length !== drafts.length) return inputs.map(() => ({ status: "rejected", code: "io_failed", message: "Failed to allocate media shortRef." }));
    this.#media = [...this.#media, ...assigned];
    try {
      await this.#persistRevision();
    } catch (error) {
      this.#media = previous;
      return inputs.map(() => ({ status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) }));
    }
    const batchPayloads = this.#mediaBatchPayloads(inputs, assigned, draftInputIndexes);
    try {
      await this.#emitBatch(batchPayloads);
    } catch (error) {
      // Batch sinks provide an atomic append contract and can be rolled back
      // when their write fails. The legacy single-payload sink persists first;
      // keep that media and its pending payloads so a later registration can
      // retry the missing event without duplicating the record.
      if (this.#emitRegisteredBatch) {
        this.#media = previous;
        this.#revision = previousSnapshot.revision;
        for (const pendingRef of assigned.map((entry) => entry.shortRef).filter((ref): ref is string => Boolean(ref))) {
          this.#pendingEmits.delete(pendingRef);
          this.#emittedShortRefs.delete(pendingRef);
        }
        await this.#restorePersistedSnapshot(previousSnapshot).catch(() => undefined);
      }
      return inputs.map(() => ({ status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) }));
    }
    this.#fillMediaBatchResults(results, inputs, assigned, draftInputIndexes, draftIndexByInput);
    for (const payload of batchPayloads) {
      this.#pendingEmits.delete(payload.shortRef);
      this.#emittedShortRefs.add(payload.shortRef);
    }
    return results;
  }

  #mediaBatchPayloads(
    inputs: readonly RegisterMediaInput[],
    assigned: readonly ComparisonMediaRecord[],
    draftInputIndexes: readonly number[],
  ): ComparisonEvidenceRegisteredPayload[] {
    const payloads: ComparisonEvidenceRegisteredPayload[] = [];
    for (const [draftIndex, inputIndex] of draftInputIndexes.entries()) {
      const input = inputs[inputIndex]!;
      const item = assigned[draftIndex];
      if (!item) continue;
      const derivation = input.derivation ?? input.record.derivation;
      const payload: ComparisonEvidenceRegisteredPayload = {
        schemaVersion: 1, attemptId: this.#attemptId, revision: this.#revision, shortRef: item.shortRef!, kind: "media",
        origin: input.origin, contentHash: item.contentHash!, sourceRefs: [...(input.sourceRefs ?? [])], artifactRefs: [item.reportHref],
        ...(derivation ? { derivation } : {}),
      };
      this.#pendingEmits.set(item.shortRef!, payload);
      payloads.push(payload);
    }
    return payloads;
  }

  #fillMediaBatchResults(
    results: RegisterEvidenceResult[],
    inputs: readonly RegisterMediaInput[],
    assigned: readonly ComparisonMediaRecord[],
    draftInputIndexes: readonly number[],
    draftIndexByInput: readonly number[],
  ): void {
    for (const [draftIndex, inputIndex] of draftInputIndexes.entries()) {
      const item = assigned[draftIndex];
      if (!item) continue;
      for (const [index, duplicateDraftIndex] of draftIndexByInput.entries()) {
        if (duplicateDraftIndex !== draftIndex) continue;
        results[index] = {
          status: "registered", revision: this.#revision, shortRef: item.shortRef!, contentHash: item.contentHash!,
          inspectPath: item.inspectPath, origin: inputs[index]!.origin, deduplicated: index !== inputIndex,
        };
      }
    }
  }

  async #finishExistingRegistration(input: {
    kind: "evidence" | "media";
    shortRef: string;
    contentHash: string;
    inspectPath: string;
    origin: ComparisonEvidenceOrigin;
    sourceRefs: readonly string[];
    artifactRefs: readonly string[];
    derivation?: ComparisonEvidenceRegisteredPayload["derivation"];
  }): Promise<RegisterEvidenceResult> {
    if (!this.#emittedShortRefs.has(input.shortRef)) {
      const pending = this.#pendingEmits.get(input.shortRef) ?? {
        schemaVersion: 1 as const,
        attemptId: this.#attemptId,
        revision: this.#revision,
        shortRef: input.shortRef,
        kind: input.kind,
        origin: input.origin,
        contentHash: input.contentHash,
        sourceRefs: [...input.sourceRefs],
        artifactRefs: [...input.artifactRefs],
        ...(input.derivation ? { derivation: input.derivation } : {}),
      };
      this.#pendingEmits.set(input.shortRef, pending);
      await this.#emit(pending);
      this.#pendingEmits.delete(input.shortRef);
      this.#emittedShortRefs.add(input.shortRef);
      return {
        status: "registered",
        revision: pending.revision,
        shortRef: input.shortRef,
        contentHash: input.contentHash,
        inspectPath: input.inspectPath,
        origin: input.origin,
        deduplicated: true,
      };
    }
    return {
      status: "registered",
      revision: this.#revision,
      shortRef: input.shortRef,
      contentHash: input.contentHash,
      inspectPath: input.inspectPath,
      origin: input.origin,
      deduplicated: true,
    };
  }

  async #commitAppend(input: CommitAppendInput): Promise<RegisterEvidenceResult> {
    input.apply();
    try {
      await this.#persistRevision();
    } catch (error) {
      input.rollback();
      return { status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) };
    }
    const payload: ComparisonEvidenceRegisteredPayload = {
      schemaVersion: 1,
      attemptId: this.#attemptId,
      revision: this.#revision,
      shortRef: input.shortRef,
      kind: input.kind,
      origin: input.origin,
      contentHash: input.contentHash,
      sourceRefs: [...input.sourceRefs],
      artifactRefs: [...input.artifactRefs],
      ...(input.derivation ? { derivation: input.derivation } : {}),
    };
    this.#pendingEmits.set(input.shortRef, payload);
    try {
      await this.#emit(payload);
    } catch (error) {
      return { status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.#pendingEmits.delete(input.shortRef);
    this.#emittedShortRefs.add(input.shortRef);
    return {
      status: "registered",
      revision: this.#revision,
      shortRef: input.shortRef,
      contentHash: input.contentHash,
      inspectPath: input.inspectPath,
      origin: input.origin,
      deduplicated: false,
    };
  }

  async #validateRegisterPreconditions(input: RegisterEvidenceInput): Promise<RegisterEvidenceResult | undefined> {
    for (const ref of input.sourceRefs) {
      if (!this.#hasSourceRef(ref)) {
        return { status: "rejected", code: "missing_source", message: `Unknown sourceRef: ${ref}` };
      }
    }
    if (!input.toolCallId) return undefined;
    if (!this.#lookupToolCall) {
      return { status: "rejected", code: "tool_call_invalid", message: "toolCallId binding is unavailable for this attempt." };
    }
    const checked = await this.#lookupToolCall(input.toolCallId);
    if (checked.ok) return undefined;
    return {
      status: "rejected",
      code: "tool_call_invalid",
      message: checked.message ?? "toolCallId is not a completed tool call for this attempt.",
    };
  }

  #hasSourceRef(ref: string): boolean {
    if (this.#links.some((link) => link.shortRef === ref || link.evidenceRef === ref || link.inspectPath === ref)) return true;
    if (this.#media.some((item) => item.shortRef === ref || item.ref === ref || item.inspectPath === ref)) return true;
    return false;
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #persistRevision(): Promise<void> {
    this.#revision += 1;
    const snap = this.snapshot();
    const catalogRoot = join(this.#attemptRoot, "facts", "evidence-catalog");
    await mkdir(catalogRoot, { recursive: true });
    const revName = `rev-${this.#revision}.json`;
    const body = `${JSON.stringify(snap, null, 2)}\n`;
    await writeAtomic(join(catalogRoot, revName), body);
    await this.#writeDerivedFacts(snap);
    await writeAtomic(join(catalogRoot, "CURRENT"), `${revName}\n`);
  }

  async #restorePersistedSnapshot(snapshot: ComparisonCatalogSnapshot): Promise<void> {
    const catalogRoot = join(this.#attemptRoot, "facts", "evidence-catalog");
    await mkdir(catalogRoot, { recursive: true });
    await writeAtomic(join(catalogRoot, "CURRENT"), `rev-${snapshot.revision}.json\n`);
    await this.#writeDerivedFacts(snapshot);
    await rm(join(catalogRoot, `rev-${snapshot.revision + 1}.json`), { force: true });
  }

  async #writeDerivedFacts(snap: ComparisonCatalogSnapshot): Promise<void> {
    const factsMedia = `${JSON.stringify(snap.media, null, 2)}\n`;
    const factsLinks = `${JSON.stringify(snap.links, null, 2)}\n`;
    const factsEvidence = `${JSON.stringify(snap.links.map((link) => ({
      shortRef: link.shortRef,
      label: link.label,
      side: link.side,
      inspectPath: link.inspectPath,
      ...(link.reportHref ? { reportHref: link.reportHref } : {}),
      ...(link.evidenceRef ? { canonicalRef: link.evidenceRef } : {}),
      ...(link.origin ? { origin: link.origin } : {}),
      ...(link.contentHash ? { contentHash: link.contentHash } : {}),
    })), null, 2)}\n`;
    const catalogMeta = `${JSON.stringify({ schemaVersion: 1, revision: snap.revision, attemptId: snap.attemptId }, null, 2)}\n`;
    const targets = [
      join(this.#attemptRoot, "facts"),
      join(this.#attemptRoot, "briefing", "facts"),
    ];
    for (const root of targets) {
      await mkdir(root, { recursive: true });
      await writeAtomic(join(root, "media.json"), factsMedia);
      await writeAtomic(join(root, "comparison-links.json"), factsLinks);
      await writeAtomic(join(root, "evidence-index.json"), factsEvidence);
      await writeAtomic(join(root, "evidence-catalog.json"), catalogMeta);
    }
  }

  async #emit(payload: ComparisonEvidenceRegisteredPayload): Promise<void> {
    if (!Value.Check(ComparisonEvidenceRegisteredPayloadSchema, payload)) {
      throw new Error("comparison.evidence_registered payload does not satisfy its schema.");
    }
    await this.#emitRegistered?.(payload);
  }

  async #emitBatch(payloads: readonly ComparisonEvidenceRegisteredPayload[]): Promise<void> {
    for (const payload of payloads) {
      if (!Value.Check(ComparisonEvidenceRegisteredPayloadSchema, payload)) throw new Error("comparison.evidence_registered payload does not satisfy its schema.");
    }
    if (this.#emitRegisteredBatch) return this.#emitRegisteredBatch(payloads);
    for (const payload of payloads) await this.#emit(payload);
  }
}

export function lookupCompletedToolCall(
  events: readonly EventEnvelope[],
  attemptId: string,
  toolCallId: string,
): { ok: boolean; message?: string } {
  const completed = events.some((event) => {
    if (event.type !== "agent.tool_completed") return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.toolCallId === toolCallId && payload.attemptId === attemptId;
  });
  if (!completed) {
    return { ok: false, message: "toolCallId was not found among completed tools for this attempt." };
  }
  return { ok: true };
}

function mediaDerivationKey(derivation: ComparisonMediaDerivation | undefined): string {
  if (!derivation) return "";
  const viewport = derivation.viewport
    ? `${derivation.viewport.width}x${derivation.viewport.height}@${derivation.viewport.scale}`
    : "";
  const samples = derivation.sampleTimesMs ? [...derivation.sampleTimesMs].join(",") : "";
  return [
    derivation.kind,
    derivation.rendererVersion ?? "",
    viewport,
    samples,
    derivation.sourceHash ?? "",
    derivation.finalUrl ?? "",
    derivation.urlStateOmitted ? "url-state-omitted" : "",
    JSON.stringify(derivation.actions?.map(({ action, selector }) => ({ action, selector })) ?? []),
  ].join("|");
}

function mediaRegistrationKey(
  contentHash: string,
  side: ComparisonMediaRecord["side"],
  derivation: ComparisonMediaDerivation | undefined,
): string {
  return `${contentHash}|${side}|${mediaDerivationKey(derivation)}`;
}

function registrationDerivation(
  input: RegisterEvidenceInput,
  dedupeKey: string,
): ComparisonEvidenceRegistrationDerivation {
  return {
    kind: "register_evidence",
    relativePath: input.relativePath,
    dedupeKey,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  };
}

async function readScratchEvidenceBytes(
  absolute: string,
): Promise<{ status: "ok"; bytes: Buffer } | RegisterEvidenceResult & { status: "rejected" }> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      return { status: "rejected", code: "path_invalid", message: "Evidence path is not a regular file." };
    }
    if (info.size > MAX_REGISTERED_EVIDENCE_BYTES) {
      return { status: "rejected", code: "too_large", message: `Evidence exceeds ${MAX_REGISTERED_EVIDENCE_BYTES} bytes.` };
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength > MAX_REGISTERED_EVIDENCE_BYTES) {
      return { status: "rejected", code: "too_large", message: `Evidence exceeds ${MAX_REGISTERED_EVIDENCE_BYTES} bytes.` };
    }
    return { status: "ok", bytes };
  } catch (error) {
    return { status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveScratchFile(
  attemptRoot: string,
  relativePath: string,
): Promise<{ status: "ok"; absolute: string } | RegisterEvidenceResult & { status: "rejected" }> {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || part === "")) {
    return { status: "rejected", code: "path_invalid", message: "relativePath must be a relative scratch path without .. segments." };
  }
  if (isFsAbsolute(normalized) || normalized.includes(":")) {
    return { status: "rejected", code: "path_invalid", message: "absolute or drive paths are not allowed." };
  }
  const underScratch = normalized.startsWith("scratch/") ? normalized.slice("scratch/".length) : normalized;
  const scratchRoot = resolve(attemptRoot, "scratch");
  const candidate = resolve(scratchRoot, underScratch);
  if (!pathContainedBy(scratchRoot, candidate)) {
    return { status: "rejected", code: "path_escape", message: "relativePath escapes scratch/." };
  }
  let realScratch: string;
  try {
    realScratch = await realpath(scratchRoot);
  } catch (error) {
    // Scratch may not exist yet on a fresh attempt; create it then resolve.
    // Any other failure (EACCES, symlink loop) is still a hard reject below.
    if (!isMissing(error)) {
      return { status: "rejected", code: "path_invalid", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      await mkdir(scratchRoot, { recursive: true });
      realScratch = await realpath(scratchRoot);
    } catch (createError) {
      return {
        status: "rejected",
        code: "path_invalid",
        message: createError instanceof Error ? createError.message : String(createError),
      };
    }
  }
  try {
    const realFile = await realpath(candidate);
    if (!pathContainedBy(realScratch, realFile)) {
      return { status: "rejected", code: "path_escape", message: "resolved path escapes scratch/ (symlink)." };
    }
    return { status: "ok", absolute: realFile };
  } catch (error) {
    // realpath fails when the file is missing, or when an intermediate symlink is broken.
    // Callers treat both as an invalid scratch evidence path; we never invent bytes.
    if (isMissing(error)) {
      return { status: "rejected", code: "path_invalid", message: "Evidence file was not found under scratch/." };
    }
    return { status: "rejected", code: "path_invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function evidenceDedupeKey(input: {
  contentHash: string;
  sourceRefs: readonly string[];
  origin: ComparisonEvidenceOrigin;
}): string {
  return `${input.origin}:${input.contentHash}:${[...input.sourceRefs].sort().join(",")}`;
}

function guessMediaType(path: string, bytes: Buffer): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (bytes.includes(0)) return "application/octet-stream";
  return "text/plain";
}
