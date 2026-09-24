import { copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, writeAtomic } from "../core/identity.js";
import { isFsAbsolute, pathContainedBy } from "../core/paths.js";
import type { ComparisonEvidenceOrigin, ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import type { ComparisonEvidenceCatalog, RegisterMediaInput } from "./comparison-evidence.js";
import type {
  ComparisonRenderCatalogPort,
  ComparisonRenderSource,
  RegisterDerivedMediaInput,
  RegisterDerivedMediaBatchResult,
  RegisterDerivedMediaResult,
} from "./comparison-render-tools.js";

export type ComparisonRenderMountRoots = {
  readonly finals: string;
  readonly candidate: string;
  readonly history: string;
  readonly evidence: string;
};

/**
 * Adapt the B3 evidence catalog to the B4 render tool port.
 * sourceRef resolution is Host-owned: model never supplies absolute paths or bundle roots.
 */
export function createComparisonRenderCatalogPort(input: {
  catalog: ComparisonEvidenceCatalog;
  attemptRoot: string;
  mounts: ComparisonRenderMountRoots;
}): ComparisonRenderCatalogPort {
  let nextReview = 1;
  const reviewByKey = new Map<string, Extract<RegisterDerivedMediaResult, { ok: true }>>();

  return {
    revision: () => input.catalog.snapshot().revision,
    resolveSource: (sourceRef) => resolveRenderSource(input, sourceRef),
    async registerDerivedMedia(entry) {
      if (entry.kind === "report_review") {
        return registerReviewMedia(
          input.attemptRoot,
          entry,
          reviewByKey,
          () => {
            const shortRef = formatReviewShortRef(nextReview);
            nextReview += 1;
            return shortRef;
          },
          () => input.catalog.snapshot().revision,
        );
      }
      return registerPreviewMedia(input.catalog, input.attemptRoot, entry);
    },
    async registerDerivedMediaBatch(entries): Promise<RegisterDerivedMediaBatchResult> {
      if (entries.some((entry) => entry.kind !== "artifact_preview")) {
        return { ok: false, code: "invalid_request", message: "Only artifact previews support atomic batch registration." };
      }
      return registerPreviewMediaBatch(input.catalog, input.attemptRoot, entries);
    },
  };
}

async function resolveRenderSource(
  input: {
    catalog: ComparisonEvidenceCatalog;
    attemptRoot: string;
    mounts: ComparisonRenderMountRoots;
  },
  sourceRef: string,
): Promise<ComparisonRenderSource | undefined> {
  if (!isSafeSourceRefToken(sourceRef)) return undefined;
  const snap = input.catalog.snapshot();
  const link = snap.links.find((item) =>
    item.shortRef === sourceRef
    || item.evidenceRef === sourceRef
    || item.inspectPath === sourceRef
  );
  if (link) return materializeLinkSource(input, link, sourceRef);

  const media = snap.media.find((item) =>
    item.shortRef === sourceRef
    || item.ref === sourceRef
    || item.inspectPath === sourceRef
  );
  if (media) return materializeMediaSource(input, media, sourceRef);
  return undefined;
}

async function materializeLinkSource(
  input: {
    attemptRoot: string;
    mounts: ComparisonRenderMountRoots;
  },
  link: ComparisonLinkRecord,
  sourceRef: string,
): Promise<ComparisonRenderSource | undefined> {
  const located = await locateRegisteredPath(input, link.inspectPath);
  if (!located) return undefined;
  const contentHash = sha256(await readFile(located.absoluteFile));
  if (link.contentHash && link.contentHash !== contentHash) return undefined;
  return {
    sourceRef,
    side: link.side,
    bundleRoot: located.bundleRoot,
    entryRelativePath: located.entryRelativePath,
    contentHash,
    ...(link.mediaType ? { mediaType: link.mediaType } : {}),
    origin: originFromLink(link),
  };
}

async function materializeMediaSource(
  input: {
    attemptRoot: string;
    mounts: ComparisonRenderMountRoots;
  },
  media: ComparisonMediaRecord,
  sourceRef: string,
): Promise<ComparisonRenderSource | undefined> {
  if (!media.available) return undefined;
  if (!media.contentHash || !/^[a-f0-9]{64}$/.test(media.contentHash)) return undefined;

  // Prefer mount-scoped originals (finals / candidate snapshot / history / evidence).
  if (isMountScopedInspectPath(media.inspectPath)) {
    const mountLocated = await locateRegisteredPath(input, media.inspectPath);
    if (mountLocated && await fileMatchesContentHash(mountLocated.absoluteFile, media.contentHash)) {
      return {
        sourceRef,
        side: media.side,
        bundleRoot: mountLocated.bundleRoot,
        entryRelativePath: mountLocated.entryRelativePath,
        contentHash: media.contentHash,
        mediaType: media.mediaType,
        origin: originFromMedia(media),
      };
    }
  }

  // Attempt media/review copies use subtree roots only — never the whole attempt tree.
  const attemptRelative = pickAttemptScopedHref(media);
  if (!attemptRelative) return undefined;
  const located = await locateRegisteredPath(input, attemptRelative);
  if (!located) return undefined;
  if (!(await fileMatchesContentHash(located.absoluteFile, media.contentHash))) return undefined;
  return {
    sourceRef,
    side: media.side,
    bundleRoot: located.bundleRoot,
    entryRelativePath: located.entryRelativePath,
    contentHash: media.contentHash,
    mediaType: media.mediaType,
    origin: originFromMedia(media),
  };
}

function pickAttemptScopedHref(media: ComparisonMediaRecord): string | undefined {
  for (const candidate of [media.reportHref, media.inspectPath]) {
    if (!candidate) continue;
    const normalized = normalizeRelativeInspectPath(candidate);
    if (!normalized) continue;
    if (normalized.startsWith("media/") || normalized.startsWith("review/")) return normalized;
  }
  return undefined;
}

function isMountScopedInspectPath(inspectPath: string): boolean {
  const normalized = normalizeRelativeInspectPath(inspectPath);
  if (!normalized) return false;
  return normalized.startsWith("finals/")
    || normalized.startsWith("candidate/")
    || normalized.startsWith("history/")
    || normalized.startsWith("evidence/");
}

async function locateRegisteredPath(
  input: {
    attemptRoot: string;
    mounts: ComparisonRenderMountRoots;
  },
  inspectPath: string,
): Promise<{ bundleRoot: string; entryRelativePath: string; absoluteFile: string } | undefined> {
  const normalized = normalizeRelativeInspectPath(inspectPath);
  if (!normalized) return undefined;

  if (normalized.startsWith("finals/")) {
    return locateUnderRoot(input.mounts.finals, normalized.slice("finals/".length));
  }
  if (normalized.startsWith("candidate/")) {
    // Always the sealed candidate snapshot mount — never the mutable workspace.
    return locateUnderRoot(input.mounts.candidate, normalized.slice("candidate/".length));
  }
  if (normalized.startsWith("history/")) {
    return locateUnderRoot(input.mounts.history, normalized.slice("history/".length));
  }
  if (normalized.startsWith("evidence/")) {
    return locateUnderRoot(input.mounts.evidence, normalized.slice("evidence/".length));
  }
  if (normalized.startsWith("media/")) {
    // bundleRoot is attemptRoot/media so document renders cannot fetch sibling attempt paths.
    return locateUnderRoot(join(input.attemptRoot, "media"), normalized.slice("media/".length));
  }
  if (normalized.startsWith("review/")) {
    return locateUnderRoot(join(input.attemptRoot, "review"), normalized.slice("review/".length));
  }
  // turns/run and other controller projections are not render bundle roots.
  return undefined;
}

async function locateUnderRoot(
  root: string,
  relativePath: string,
): Promise<{ bundleRoot: string; entryRelativePath: string; absoluteFile: string } | undefined> {
  const entryRelativePath = normalizeRelativeInspectPath(relativePath);
  if (!entryRelativePath) return undefined;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    // Missing mount root → unknown_source at the tool boundary.
    return undefined;
  }
  const absolute = join(rootReal, ...entryRelativePath.split("/"));
  if (!pathContainedBy(rootReal, absolute)) return undefined;
  try {
    const fileReal = await realpath(absolute);
    if (!pathContainedBy(rootReal, fileReal)) return undefined;
    const info = await stat(fileReal);
    if (!info.isFile()) return undefined;
    return { bundleRoot: rootReal, entryRelativePath, absoluteFile: fileReal };
  } catch {
    // Missing file, broken symlink, or non-resolvable intermediate → unknown_source.
    return undefined;
  }
}

async function fileMatchesContentHash(absoluteFile: string, expectedHash: string): Promise<boolean> {
  try {
    return sha256(await readFile(absoluteFile)) === expectedHash;
  } catch {
    // Unreadable source cannot be verified; treat as unavailable for render.
    return false;
  }
}

function normalizeRelativeInspectPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return undefined;
  if (isFsAbsolute(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return undefined;
  return normalized;
}

function isSafeSourceRefToken(sourceRef: string): boolean {
  if (!sourceRef || sourceRef.length > 128 || sourceRef.includes("\0")) return false;
  if (sourceRef.includes("..") || sourceRef.includes("/") || sourceRef.includes("\\")) return false;
  if (isFsAbsolute(sourceRef) || /^[a-z][a-z0-9+.-]*:/i.test(sourceRef)) return false;
  return true;
}

function originFromLink(link: ComparisonLinkRecord): ComparisonRenderSource["origin"] {
  if (link.origin === "historical_artifact") return "historical_artifact";
  if (link.origin === "reconstructed_from_history") return "reconstructed_from_history";
  if (link.origin === "candidate_delivery") return "candidate";
  if (link.origin === "derived_analysis") return "derived";
  if (link.origin === "host_review") return "host";
  if (link.side === "baseline") return "historical_artifact";
  if (link.side === "candidate") return "candidate";
  if (link.side === "derived") return "derived";
  return "host";
}

function originFromMedia(media: ComparisonMediaRecord): ComparisonRenderSource["origin"] {
  if (media.side === "baseline") return "historical_artifact";
  if (media.side === "candidate") return "candidate";
  if (media.side === "derived") return "derived";
  return "host";
}

function evidenceOriginForSide(side: RegisterDerivedMediaInput["side"]): ComparisonEvidenceOrigin {
  if (side === "baseline") return "historical_artifact";
  if (side === "candidate") return "candidate_delivery";
  if (side === "derived") return "derived_analysis";
  return "host_review";
}

async function registerPreviewMedia(
  catalog: ComparisonEvidenceCatalog,
  attemptRoot: string,
  entry: RegisterDerivedMediaInput,
): Promise<RegisterDerivedMediaResult> {
  // Always call catalog.registerMedia so emit-failure retry can re-emit via #finishExistingRegistration.
  const provenanceSuffix = entry.derivation.sourceHash
    ? `-${sha256(JSON.stringify({ sourceRef: entry.sourceRef, sourceHash: entry.derivation.sourceHash,
      finalUrl: entry.derivation.finalUrl, actions: entry.derivation.actions?.map(({ action, selector }) => ({ action, selector })) })).slice(0, 12)}`
    : "";
  const stem = `render-${entry.contentHash.slice(0, 16)}-${entry.derivation.sampleTimeMs}${provenanceSuffix}`;
  const fileName = `${stem}.png`;
  const inspectPath = `media/${fileName}`;
  const absoluteOut = join(attemptRoot, ...inspectPath.split("/"));
  await mkdir(dirname(absoluteOut), { recursive: true });
  await copyFile(entry.pngPath, absoluteOut);
  const derivation = {
    kind: "render_preview" as const,
    rendererVersion: entry.derivation.rendererVersion,
    viewport: entry.derivation.viewport,
    sampleTimesMs: [entry.derivation.sampleTimeMs],
    ...(entry.derivation.sourceHash ? { capturedAt: entry.derivation.capturedAt,
      elapsedMs: entry.derivation.actualTimeMs } : {}),
    ...(entry.derivation.sourceHash ? { sourceHash: entry.derivation.sourceHash } : {}),
    ...(entry.derivation.finalUrl ? { finalUrl: entry.derivation.finalUrl } : {}),
    ...(entry.derivation.urlStateOmitted ? { urlStateOmitted: true } : {}),
    ...(entry.derivation.errorsOmitted !== undefined ? { errorsOmitted: entry.derivation.errorsOmitted } : {}),
    ...(entry.derivation.actions ? { actions: [...entry.derivation.actions] } : {}),
  };
  const registered = await catalog.registerMedia({
    record: {
      ref: `media:${stem}`,
      side: entry.side,
      inspectPath,
      reportHref: inspectPath,
      mediaType: "image/png",
      available: true,
      contentHash: entry.contentHash,
      sourceRef: entry.sourceRef,
      derivation,
    },
    sourceRefs: [entry.sourceRef],
    origin: evidenceOriginForSide(entry.side),
    derivation,
  });
  if (registered.status !== "registered") {
    // Best-effort cleanup of the copied PNG so a failed register does not leave an orphan.
    await rm(absoluteOut, { force: true }).catch(() => undefined);
    return {
      ok: false,
      code: registered.code,
      message: registered.message,
    };
  }
  const recorded = catalog.snapshot().media.find((item) => item.shortRef === registered.shortRef);
  return {
    ok: true,
    shortRef: registered.shortRef,
    mediaRef: recorded?.ref ?? `media:${stem}`,
    revision: registered.revision,
  };
}

async function registerPreviewMediaBatch(
  catalog: ComparisonEvidenceCatalog,
  attemptRoot: string,
  entries: readonly RegisterDerivedMediaInput[],
): Promise<RegisterDerivedMediaBatchResult> {
  const copied: string[] = [];
  try {
    const inputs: RegisterMediaInput[] = [];
    for (const entry of entries) {
      const fileName = `render-${entry.contentHash.slice(0, 16)}-${entry.derivation.sampleTimeMs}.png`;
      const inspectPath = `media/${fileName}`;
      const absoluteOut = join(attemptRoot, ...inspectPath.split("/"));
      await mkdir(dirname(absoluteOut), { recursive: true });
      await copyFile(entry.pngPath, absoluteOut);
      copied.push(absoluteOut);
      const derivation = {
        kind: "render_preview" as const,
        rendererVersion: entry.derivation.rendererVersion,
        viewport: entry.derivation.viewport,
        sampleTimesMs: [entry.derivation.sampleTimeMs],
      };
      inputs.push({
        record: {
          ref: `media:render-${entry.contentHash.slice(0, 16)}-${entry.derivation.sampleTimeMs}`,
          side: entry.side,
          inspectPath,
          reportHref: inspectPath,
          mediaType: "image/png",
          available: true,
          contentHash: entry.contentHash,
          sourceRef: entry.sourceRef,
          derivation,
        },
        sourceRefs: [entry.sourceRef],
        origin: evidenceOriginForSide(entry.side),
        derivation,
      });
    }
    const registered = await catalog.registerMediaBatch(inputs);
    const rejected = registered.find((item) => item.status !== "registered");
    if (rejected) {
      await Promise.all(copied.map((path) => rm(path, { force: true }).catch(() => undefined)));
      return { ok: false, code: rejected.code, message: rejected.message };
    }
    const successful = registered.filter((item): item is Extract<typeof item, { status: "registered" }> => item.status === "registered");
    return {
      ok: true,
      items: successful.map((item) => {
        const media = catalog.snapshot().media.find((candidate) => candidate.shortRef === item.shortRef);
        return { ok: true as const, shortRef: item.shortRef, mediaRef: media?.ref ?? `media:${item.shortRef}`, revision: item.revision };
      }),
    };
  } catch (error) {
    await Promise.all(copied.map((path) => rm(path, { force: true }).catch(() => undefined)));
    return { ok: false, code: "io_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function registerReviewMedia(
  attemptRoot: string,
  entry: RegisterDerivedMediaInput,
  reviewByKey: Map<string, Extract<RegisterDerivedMediaResult, { ok: true }>>,
  allocateShortRef: () => string,
  revision: () => number,
): Promise<RegisterDerivedMediaResult> {
  const key = [
    entry.contentHash,
    entry.derivation.viewport.width,
    entry.derivation.viewport.height,
    entry.derivation.viewport.scale,
    entry.derivation.sampleTimeMs,
  ].join("|");
  const existing = reviewByKey.get(key);
  if (existing) return existing;

  const shortRef = allocateShortRef();
  const mediaRef = `review:derived-${shortRef}`;
  const reviewRoot = join(attemptRoot, "review", "media");
  await mkdir(reviewRoot, { recursive: true });
  const dest = join(reviewRoot, `${shortRef}.png`);
  try {
    await copyFile(entry.pngPath, dest);
    // Review refs stay outside catalog.media so they cannot enter the comparison allowlist.
    await writeAtomic(join(reviewRoot, `${shortRef}.meta.json`), `${JSON.stringify({
      shortRef,
      mediaRef,
      kind: "report_review",
      sourceRef: entry.sourceRef,
      contentHash: entry.contentHash,
      derivation: entry.derivation,
    }, null, 2)}\n`);
  } catch (error) {
    await rm(dest, { force: true }).catch(() => undefined);
    return {
      ok: false,
      code: "io_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // Revision is not bumped: review screenshots are not comparison evidence.
  const registered = { ok: true as const, shortRef, mediaRef, revision: revision() };
  reviewByKey.set(key, registered);
  return registered;
}

function formatReviewShortRef(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 999_999) {
    throw new Error("Review short ref index out of range.");
  }
  return `review-${String(index).padStart(2, "0")}`;
}
