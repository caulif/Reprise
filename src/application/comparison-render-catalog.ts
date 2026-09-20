import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, writeAtomic } from "../core/identity.js";
import { isFsAbsolute, pathContainedBy } from "../core/paths.js";
import type { ComparisonEvidenceOrigin, ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import type { ComparisonEvidenceCatalog } from "./comparison-evidence.js";
import type {
  ComparisonRenderCatalogPort,
  ComparisonRenderSource,
  RegisterDerivedMediaInput,
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
  const reviewByKey = new Map<string, RegisterDerivedMediaResult>();

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
  const contentHash = link.contentHash && /^[a-f0-9]{64}$/.test(link.contentHash)
    ? link.contentHash
    : sha256(await readFile(located.absoluteFile));
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
  // Prefer attempt media bytes when present; fall back to original inspectPath under frozen roots.
  const reportLocated = media.reportHref
    ? await locateUnderRoot(input.attemptRoot, media.reportHref)
    : undefined;
  const located = reportLocated ?? await locateRegisteredPath(input, media.inspectPath);
  if (!located) return undefined;
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
  if (normalized.startsWith("media/") || normalized.startsWith("review/")) {
    return locateUnderRoot(input.attemptRoot, normalized);
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
    return undefined;
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
  const snap = catalog.snapshot();
  const existing = snap.media.find((item) =>
    item.contentHash === entry.contentHash
    && item.side === entry.side
    && item.sourceRef === entry.sourceRef
    && item.derivation?.kind === "render_preview"
    && item.derivation.rendererVersion === entry.derivation.rendererVersion
    && item.derivation.viewport?.width === entry.derivation.viewport.width
    && item.derivation.viewport?.height === entry.derivation.viewport.height
    && item.derivation.viewport?.scale === entry.derivation.viewport.scale
    && (item.derivation.sampleTimesMs ?? []).join(",") === String(entry.derivation.sampleTimeMs)
  );
  if (existing?.shortRef) {
    return {
      shortRef: existing.shortRef,
      mediaRef: existing.ref,
      revision: snap.revision,
    };
  }

  const fileName = `render-${entry.contentHash.slice(0, 16)}-${entry.derivation.sampleTimeMs}.png`;
  const inspectPath = `media/${fileName}`;
  const absoluteOut = join(attemptRoot, ...inspectPath.split("/"));
  await mkdir(dirname(absoluteOut), { recursive: true });
  await copyFile(entry.pngPath, absoluteOut);
  const derivation = {
    kind: "render_preview" as const,
    rendererVersion: entry.derivation.rendererVersion,
    viewport: entry.derivation.viewport,
    sampleTimesMs: [entry.derivation.sampleTimeMs],
    capturedAt: entry.derivation.capturedAt,
  };
  const registered = await catalog.registerMedia({
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
  if (registered.status !== "registered") {
    throw new Error(`registerDerivedMedia failed: ${registered.code} ${registered.message}`);
  }
  const recorded = catalog.snapshot().media.find((item) => item.shortRef === registered.shortRef);
  return {
    shortRef: registered.shortRef,
    mediaRef: recorded?.ref ?? `media:render-${entry.contentHash.slice(0, 16)}-${entry.derivation.sampleTimeMs}`,
    revision: registered.revision,
  };
}

async function registerReviewMedia(
  attemptRoot: string,
  entry: RegisterDerivedMediaInput,
  reviewByKey: Map<string, RegisterDerivedMediaResult>,
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
  // Revision is not bumped: review screenshots are not comparison evidence.
  const registered = { shortRef, mediaRef, revision: revision() };
  reviewByKey.set(key, registered);
  return registered;
}

function formatReviewShortRef(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 999_999) {
    throw new Error("Review short ref index out of range.");
  }
  return `review-${String(index).padStart(2, "0")}`;
}
