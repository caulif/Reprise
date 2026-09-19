import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import {
  ComparisonEvidenceCatalogSchema,
  ComparisonEvidenceRegisteredPayloadSchema,
  ComparisonLinksSchema,
  ComparisonMediaRecordSchema,
  type ComparisonEvidenceCatalogSnapshot,
  type ComparisonEvidenceOrigin,
  type ComparisonEvidenceRegisteredPayload,
  type ComparisonLinkRecord,
  type ComparisonMediaRecord,
  type EventEnvelope,
} from "../core/schema.js";
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

type CatalogPersister = {
  attemptRoot: string;
  attemptId: string;
  emitRegistered?: (payload: ComparisonEvidenceRegisteredPayload) => Promise<void>;
  lookupToolCall?: (toolCallId: string) => Promise<{ ok: boolean; message?: string }>;
};

export class ComparisonEvidenceCatalog {
  #revision = 0;
  #links: ComparisonLinkRecord[] = [];
  #media: ComparisonMediaRecord[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  readonly #attemptRoot: string;
  readonly #attemptId: string;
  readonly #emitRegistered?: CatalogPersister["emitRegistered"];
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
    this.#lookupToolCall = input.lookupToolCall;
  }

  static async create(input: {
    attemptRoot: string;
    attemptId: string;
    links: readonly ComparisonLinkRecord[];
    media: readonly ComparisonMediaRecord[];
    emitRegistered?: CatalogPersister["emitRegistered"];
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
      ...(input.lookupToolCall ? { lookupToolCall: input.lookupToolCall } : {}),
    });
    await catalog.#persistRevision("seed");
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

  async registerMedia(input: {
    record: Omit<ComparisonMediaRecord, "shortRef"> & { shortRef?: string };
    sourceRefs?: readonly string[];
    origin: ComparisonEvidenceOrigin;
    derivation?: ComparisonMediaRecord["derivation"];
  }, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    return this.#enqueue(() => this.#registerMediaLocked(input, signal));
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
    const dedupeKey = evidenceDedupeKey({
      contentHash,
      sourceRefs: input.sourceRefs,
      origin: "derived_analysis",
    });
    const existing = this.#links.find((link) => link.contentHash === contentHash
      && link.origin === "derived_analysis"
      && sameStringSet(link.sourceRefs ?? [], input.sourceRefs));
    if (existing?.shortRef) {
      return {
        status: "registered",
        revision: this.#revision,
        shortRef: existing.shortRef,
        contentHash,
        inspectPath: existing.inspectPath,
        origin: "derived_analysis",
        deduplicated: true,
      };
    }

    const inspectPath = `evidence/derived/${contentHash.slice(0, 16)}`;
    const absoluteOut = join(this.#attemptRoot, ...inspectPath.split("/"));
    try {
      await mkdir(dirname(absoluteOut), { recursive: true });
      await writeAtomic(absoluteOut, bytes);
    } catch (error) {
      return { status: "rejected", code: "io_failed", message: error instanceof Error ? error.message : String(error) };
    }

    return this.#appendDerivedEvidenceLink({
      input,
      bytes,
      contentHash,
      inspectPath,
      dedupeKey,
    });
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

  async #appendDerivedEvidenceLink(input: {
    input: RegisterEvidenceInput;
    bytes: Buffer;
    contentHash: string;
    inspectPath: string;
    dedupeKey: string;
  }): Promise<RegisterEvidenceResult> {
    const draft: ComparisonLinkRecord = {
      side: "derived",
      inspectPath: input.inspectPath,
      reportHref: input.inspectPath,
      mediaType: guessMediaType(input.input.relativePath, input.bytes),
      byteLength: input.bytes.byteLength,
      label: input.input.label.trim() || "derived analysis",
      origin: "derived_analysis",
      contentHash: input.contentHash,
      sourceRefs: [...input.input.sourceRefs],
    };
    if (!Value.Check(ComparisonLinksSchema, [draft])) {
      return { status: "rejected", code: "io_failed", message: "Derived evidence link failed schema validation." };
    }
    const assigned = appendEvidenceShortRefs(this.#links, [draft])[0];
    if (!assigned?.shortRef) {
      return { status: "rejected", code: "io_failed", message: "Failed to allocate evidence shortRef." };
    }
    this.#links = [...this.#links, assigned];
    await this.#persistRevision("register");
    const shortRef = assigned.shortRef;
    await this.#emit({
      schemaVersion: 1,
      attemptId: this.#attemptId,
      revision: this.#revision,
      shortRef,
      kind: "evidence",
      origin: "derived_analysis",
      contentHash: input.contentHash,
      sourceRefs: [...input.input.sourceRefs],
      artifactRefs: [input.inspectPath],
      derivation: {
        relativePath: input.input.relativePath,
        dedupeKey: input.dedupeKey,
        ...(input.input.toolCallId ? { toolCallId: input.input.toolCallId } : {}),
      },
    });
    return {
      status: "registered",
      revision: this.#revision,
      shortRef,
      contentHash: input.contentHash,
      inspectPath: input.inspectPath,
      origin: "derived_analysis",
      deduplicated: false,
    };
  }

  async #registerMediaLocked(input: {
    record: Omit<ComparisonMediaRecord, "shortRef"> & { shortRef?: string };
    sourceRefs?: readonly string[];
    origin: ComparisonEvidenceOrigin;
    derivation?: ComparisonMediaRecord["derivation"];
  }, signal?: AbortSignal): Promise<RegisterEvidenceResult> {
    if (signal?.aborted) return { status: "rejected", code: "cancelled", message: "Registration cancelled." };
    const sourceRefs = input.sourceRefs ?? [];
    for (const ref of sourceRefs) {
      if (!this.#hasSourceRef(ref)) {
        return { status: "rejected", code: "missing_source", message: `Unknown sourceRef: ${ref}` };
      }
    }
    const contentHash = input.record.contentHash;
    if (contentHash) {
      const existing = this.#media.find((item) =>
        item.contentHash === contentHash
        && item.side === input.record.side
        && JSON.stringify(item.derivation ?? null) === JSON.stringify(input.derivation ?? input.record.derivation ?? null));
      if (existing?.shortRef) {
        return {
          status: "registered",
          revision: this.#revision,
          shortRef: existing.shortRef,
          contentHash,
          inspectPath: existing.inspectPath,
          origin: input.origin,
          deduplicated: true,
        };
      }
    }
    const draft: ComparisonMediaRecord = {
      ...input.record,
      ...(input.derivation ? { derivation: input.derivation } : {}),
    };
    if (!Value.Check(ComparisonMediaRecordSchema, draft)) {
      return { status: "rejected", code: "io_failed", message: "Media record failed schema validation." };
    }
    const assigned = appendMediaShortRefs(this.#media, [draft])[0];
    if (!assigned?.shortRef) {
      return { status: "rejected", code: "io_failed", message: "Failed to allocate media shortRef." };
    }
    this.#media = [...this.#media, assigned];
    await this.#persistRevision("register-media");
    const shortRef = assigned.shortRef;
    await this.#emit({
      schemaVersion: 1,
      attemptId: this.#attemptId,
      revision: this.#revision,
      shortRef,
      kind: "media",
      origin: input.origin,
      contentHash: contentHash ?? sha256(Buffer.from(assigned.ref)),
      sourceRefs: [...sourceRefs],
      artifactRefs: [assigned.reportHref],
      ...(assigned.derivation ? { derivation: { ...assigned.derivation } } : {}),
    });
    return {
      status: "registered",
      revision: this.#revision,
      shortRef,
      contentHash: contentHash ?? "",
      inspectPath: assigned.inspectPath,
      origin: input.origin,
      deduplicated: false,
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

  async #persistRevision(_reason: string): Promise<void> {
    this.#revision += 1;
    const snap = this.snapshot();
    const catalogRoot = join(this.#attemptRoot, "facts", "evidence-catalog");
    await mkdir(catalogRoot, { recursive: true });
    const revName = `rev-${this.#revision}.json`;
    const body = `${JSON.stringify(snap, null, 2)}\n`;
    await writeAtomic(join(catalogRoot, revName), body);
    await writeAtomic(join(catalogRoot, "CURRENT"), `${revName}\n`);
    await this.#writeDerivedFacts(snap);
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
  if (normalized.startsWith("scratch/")) {
    // allow scratch/... or path relative to scratch/
  } else if (normalized.includes(":")) {
    return { status: "rejected", code: "path_invalid", message: "absolute or drive paths are not allowed." };
  }
  const scratchRoot = resolve(attemptRoot, "scratch");
  const candidate = resolve(scratchRoot, normalized.startsWith("scratch/") ? normalized.slice("scratch/".length) : normalized);
  if (!isInsideRoot(scratchRoot, candidate)) {
    return { status: "rejected", code: "path_escape", message: "relativePath escapes scratch/." };
  }
  try {
    const realScratch = await realpath(scratchRoot).catch(async () => {
      await mkdir(scratchRoot, { recursive: true });
      return realpath(scratchRoot);
    });
    const realFile = await realpath(candidate);
    if (!isInsideRoot(realScratch, realFile)) {
      return { status: "rejected", code: "path_escape", message: "resolved path escapes scratch/ (symlink)." };
    }
    return { status: "ok", absolute: realFile };
  } catch {
    return { status: "rejected", code: "path_invalid", message: "Evidence file was not found under scratch/." };
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("../"));
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
