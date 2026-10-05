import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "parse5";
import { RenderGeometryQueriesSchema, type RenderGeometryQuery, type RenderGeometrySample } from "../core/schema.js";
import type { ArtifactRenderer, RenderFailureKind, RenderViewport, RenderFrame, RenderResult } from "../infrastructure/artifact-render-types.js";
import { ARTIFACT_RENDERER_VERSION, DEFAULT_RENDER_VIEWPORT, RENDER_LIMITS } from "../infrastructure/artifact-render-types.js";
import { renderFrozenArtifact } from "../infrastructure/artifact-renderer.js";
import { sha256 } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import { attachComparisonImages } from './comparison-image-delivery.js';

/** Narrow port owned by B3 catalog; B4 tools only call these methods. */
export type ComparisonRenderCatalogPort = {
  revision(): number;
  resolveSource(sourceRef: string): Promise<ComparisonRenderSource | undefined>;
  /**
   * Register derived PNG bytes. `artifact_preview` must mint `media-*` evidence refs;
   * `report_review` must mint `review-*` (never `media-*`) so preview cannot enter the comparison allowlist.
   */
  registerDerivedMedia(input: RegisterDerivedMediaInput): Promise<RegisterDerivedMediaResult>;
  registerDerivedMediaBatch(inputs: readonly RegisterDerivedMediaInput[]): Promise<RegisterDerivedMediaBatchResult>;
};

export type RegisterDerivedMediaBatchResult =
  | { ok: true; items: readonly Extract<RegisterDerivedMediaResult, { ok: true }>[] }
  | { ok: false; code: string; message: string };

export type ComparisonRenderSource = {
  sourceRef: string;
  side: "baseline" | "candidate" | "host" | "derived";
  bundleRoot: string;
  entryRelativePath: string;
  contentHash: string;
  mediaType?: string;
  origin: "historical_artifact" | "reconstructed_from_history" | "candidate" | "derived" | "host";
};

export type RegisterDerivedMediaInput = {
  side: "baseline" | "candidate" | "host" | "derived";
  pngPath: string;
  label: string;
  sourceRef: string;
  contentHash: string;
  kind: "artifact_preview" | "report_review";
  derivation: {
    rendererVersion: string;
    viewport: RenderViewport;
    sampleTimeMs: number;
    actualTimeMs: number;
    capturedAt: string;
  };
};

export type RegisterDerivedMediaResult =
  | {
      ok: true;
      shortRef: string;
      mediaRef: string;
      revision: number;
      readPath?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

const ViewportSchema = Type.Object({
  width: Type.Integer({ minimum: RENDER_LIMITS.minWidth, maximum: RENDER_LIMITS.maxWidth }),
  height: Type.Integer({ minimum: RENDER_LIMITS.minHeight, maximum: RENDER_LIMITS.maxHeight }),
  scale: Type.Optional(Type.Number({ minimum: 1, maximum: RENDER_LIMITS.maxScale })),
});

const RenderArtifactParamsSchema = Type.Object({
  sourceRef: Type.String({ minLength: 1, maxLength: 128 }),
  viewport: Type.Optional(ViewportSchema),
  sampleTimesMs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: RENDER_LIMITS.maxSampleMs }), {
    minItems: 1,
    maxItems: RENDER_LIMITS.maxFrames,
  })),
  includeImages: Type.Optional(Type.Boolean()),
  geometryQueries: Type.Optional(RenderGeometryQueriesSchema),
});
export type RenderArtifactParams = Static<typeof RenderArtifactParamsSchema>;

const PreviewReportParamsSchema = Type.Object({
  viewport: Type.Optional(ViewportSchema),
  includeImages: Type.Optional(Type.Boolean()),
});
export type PreviewReportParams = Static<typeof PreviewReportParamsSchema>;

export type ComparisonRenderToolBaseDeps = {
  catalog: ComparisonRenderCatalogPort;
  attemptRoot: string;
  render?: ArtifactRenderer;
  now?: () => Date;
  allowImages?: boolean;
  onRenderedCheck?: (check: ComparisonRenderedCheck) => void | Promise<void>;
};

export type ComparisonRenderedCheck = {
  sourceRef: string;
  side: ComparisonRenderSource["side"];
  sourceHash: string;
  status: "ok" | "motion_not_proven" | RenderFailureKind["kind"];
  requestedSampleTimesMs: readonly number[];
  frames: readonly { sampleTimeMs: number; actualTimeMs: number; contentHash: string; geometrySample?: RenderGeometrySample; geometryUnavailable?: string }[];
  viewport: RenderViewport;
  geometryQueries?: readonly RenderGeometryQuery[];
  geometryScope?: string;
};

export type PreviewReportOutcome = { status: string; message?: string };

export type ComparisonPreviewReportToolDeps = ComparisonRenderToolBaseDeps & {
  /** Prepare draft HTML with current catalog revision (B3/B6 share this). */
  prepareReportHtml: () => Promise<PreparedReportPreview>;
  onPreviewSuccess?: (prepared: PreparedReportPreview) => void;
  /** Fires for every preview_report result after the draft is prepared, including timeout. */
  onPreviewFinished?: (prepared: PreparedReportPreview, outcome: PreviewReportOutcome) => void;
  preflightDraft?: () => Promise<{ digest: string; error?: string }>;
};

export type PreparedReportPreview = {
  htmlPath: string;
  html: string;
  draftDigest: string;
  preparedDigest: string;
  catalogRevision: number;
  dependencyDigest: string;
  outputRoot: string;
};

type PreviewCacheEntry = {
  payload: Record<string, unknown>;
  pngPath: string;
  contentHash: string;
  registration: RegisterDerivedMediaInput;
};

export function createRenderArtifactTool(deps: ComparisonRenderToolBaseDeps): AgentToolDefinition {
  const render = deps.render ?? renderFrozenArtifact;
  return {
    name: "render_artifact",
    description:
      "Derive preview frames from a registered sourceRef (HTML/SVG/raster). Optional geometryQueries measure uniquely selected elements in viewport CSS pixels, without requiring image sight. Returns media refs, load diagnostics and bounded Comparison-stage measurements; no arbitrary JavaScript or URLs.",
    parameters: RenderArtifactParamsSchema,
    async execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult> {
      if (!Value.Check(RenderArtifactParamsSchema, params)) {
        return textResult({ status: "invalid_request", message: "parameters failed schema check" });
      }
      if (params.geometryQueries && new Set(params.geometryQueries.map(query => query.name)).size !== params.geometryQueries.length) {
        return textResult({ status: "invalid_request", message: "geometry query names must be unique" });
      }
      const source = await deps.catalog.resolveSource(params.sourceRef);
      if (!source) {
        return textResult({ status: "unknown_source", sourceRef: params.sourceRef, revision: deps.catalog.revision() });
      }
      const viewport = resolveViewport(params.viewport);
      const sampleTimesMs = params.sampleTimesMs ?? [0];
      const outputRoot = join(deps.attemptRoot, "scratch", "render", safeId(params.sourceRef));
      if (signal.aborted) return textResult({ status: "cancelled", sourceRef: params.sourceRef });
      const rendered = await render({
        bundleRoot: source.bundleRoot,
        entryRelativePath: source.entryRelativePath,
        viewport,
        sampleTimesMs,
        outputRoot,
        signal,
        ...(params.geometryQueries ? { geometryQueries: params.geometryQueries } : {}),
      });
      const finish = async (status: ComparisonRenderedCheck["status"], payload: Record<string, unknown>): Promise<AgentToolResult> => {
        const renderedCheck = artifactRenderedCheck(source, rendered, status, sampleTimesMs, viewport, params.geometryQueries);
        await deps.onRenderedCheck?.(structuredClone(renderedCheck));
        return textResult({ ...payload, renderedCheck });
      };
      if (!rendered.ok) {
        return finish(rendered.failure.kind, {
          status: rendered.failure.kind,
          sourceRef: params.sourceRef,
          revision: deps.catalog.revision(),
          failure: rendered.failure,
          diagnostics: rendered.diagnostics,
        });
      }
      if (signal.aborted) return finish("cancelled", { status: "cancelled", sourceRef: source.sourceRef, revision: deps.catalog.revision() });
      if (!rendered.frames.length) return finish("capture_failed", {
        status: "capture_failed", sourceRef: source.sourceRef, revision: deps.catalog.revision(), message: "Renderer returned no frames.",
      });
      if (sampleTimesMs.length > 1 && new Set(rendered.frames.map((frame) => frame.contentHash)).size < 2) {
        return finish("motion_not_proven", {
          status: "motion_not_proven",
          sourceRef: params.sourceRef,
          revision: deps.catalog.revision(),
          message: "Multiple sample times produced identical PNG content; motion evidence was not registered.",
          sampleTimesMs,
          diagnostics: rendered.diagnostics,
        });
      }
      const capturedAt = (deps.now ?? (() => new Date()))().toISOString();
      const registrations = await deps.catalog.registerDerivedMediaBatch(
        artifactFrameRegistrations(source, rendered.frames, rendered.measured.viewport, capturedAt));
      if (!registrations.ok) return finish("capture_failed", {
        status: "capture_failed",
        sourceRef: params.sourceRef,
        revision: deps.catalog.revision(),
        code: registrations.code,
        message: registrations.message,
      });
      const mediaRefs = artifactMediaRefs(registrations.items, rendered.frames);
      const result = await finish("ok", {
        status: "ok",
        sourceRef: params.sourceRef,
        sourceOrigin: source.origin,
        sourceHash: source.contentHash,
        revision: deps.catalog.revision(),
        media: mediaRefs,
        sampleTimesMs,
        viewport: rendered.measured.viewport,
        loadMs: rendered.measured.loadMs,
        diagnostics: rendered.diagnostics,
        limitations: summarizeLimitations(rendered.diagnostics),
      });
      const images = registrations.items.flatMap((registered, index) => registered.readPath && rendered.frames[index]
        ? [{ path: registered.readPath, contentHash: rendered.frames[index].contentHash, shortRef: registered.shortRef }] : []);
      return attachComparisonImages({ result, requested: params.includeImages === true, authorized: deps.allowImages === true, attemptRoot: deps.attemptRoot, signal, images: images.length === rendered.frames.length ? images : [] });
    },
  };
}

function artifactMediaRefs(registrations: Extract<RegisterDerivedMediaBatchResult, { ok: true }>["items"], frames: readonly RenderFrame[]) {
  return registrations.flatMap((registered, index) => {
    const frame = frames[index];
    if (!frame) return [];
    assertEvidenceShortRef(registered.shortRef, "artifact_preview");
    return [{
      shortRef: registered.shortRef,
      mediaRef: registered.mediaRef,
      ...(registered.readPath ? { read: { path: registered.readPath, format: "image" as const, mimeType: "image/png" as const } } : {}),
      sampleTimeMs: frame.sampleTimeMs,
      actualTimeMs: frame.actualTimeMs,
    }];
  });
}

function artifactRenderedCheck(source: ComparisonRenderSource, rendered: RenderResult, status: ComparisonRenderedCheck["status"], sampleTimesMs: readonly number[], viewport: RenderViewport, geometryQueries?: readonly RenderGeometryQuery[]): ComparisonRenderedCheck {
  return {
    sourceRef: source.sourceRef, side: source.side, sourceHash: source.contentHash, status,
    requestedSampleTimesMs: [...sampleTimesMs],
    frames: rendered.ok ? rendered.frames.map(frame => ({ sampleTimeMs: frame.sampleTimeMs, actualTimeMs: frame.actualTimeMs, contentHash: frame.contentHash,
      ...(geometryQueries ? bindGeometrySample(frame, geometryQueries) : {}),
    })) : [],
    viewport: { ...(rendered.ok ? rendered.measured.viewport : viewport) },
    ...(geometryQueries ? { geometryQueries: geometryQueries.map(query => ({ ...query })), geometryScope: "Comparison-stage observation of the sourceHash at the listed viewport. Coordinates share viewport CSS pixels. Collection windows are relative to load origin and precede PNG capture, not an exact screenshot instant. Measurements do not certify visual quality, task success or a complete animation cycle." } : {}),
  };
}

function bindGeometrySample(frame: RenderFrame, queries: readonly RenderGeometryQuery[]): { geometrySample?: RenderGeometrySample; geometryUnavailable?: string } {
  const sample = frame.geometrySample;
  if (!sample) return { geometryUnavailable: "Renderer returned no geometry sample; no measurement is available." };
  if (sample.observations.length !== queries.length || sample.observations.some((observation, index) => {
    const query = queries[index]!;
    return observation.name !== query.name || observation.selector !== query.selector || observation.kind !== query.kind;
  })) return { geometryUnavailable: "Geometry observations do not match the requested queries; measurements were discarded." };
  if (!Number.isFinite(sample.startedAtMs) || !Number.isFinite(sample.finishedAtMs) || sample.startedAtMs < frame.actualTimeMs || sample.finishedAtMs < sample.startedAtMs) {
    return { geometryUnavailable: "Geometry collection window does not match the frame timing; measurements were discarded." };
  }
  return { geometrySample: structuredClone(sample) };
}

function artifactFrameRegistrations(source: ComparisonRenderSource, frames: readonly RenderFrame[], viewport: RenderViewport, capturedAt: string): RegisterDerivedMediaInput[] {
  return frames.map((frame) => ({
    side: source.side === "derived" ? "host" : source.side,
    pngPath: frame.pngPath,
    label: `${source.entryRelativePath}@${frame.sampleTimeMs}ms`,
    sourceRef: source.sourceRef,
    contentHash: frame.contentHash,
    kind: "artifact_preview",
    derivation: {
      rendererVersion: ARTIFACT_RENDERER_VERSION,
      viewport,
      sampleTimeMs: frame.sampleTimeMs,
      actualTimeMs: frame.actualTimeMs,
      capturedAt,
    },
  }));
}

export function createPreviewReportTool(deps: ComparisonPreviewReportToolDeps): AgentToolDefinition {
  const render = deps.render ?? renderFrozenArtifact;
  const cache = new Map<string, PreviewCacheEntry>();
  return {
    name: "preview_report",
    description:
      "Mechanically preview the current attempt report.html with the current catalog revision. Review screenshots use review-* refs under review/ and are not comparison evidence.",
    parameters: PreviewReportParamsSchema,
    async execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult> {
      if (!Value.Check(PreviewReportParamsSchema, params)) {
        return textResult({ status: "invalid_request", message: "parameters failed schema check" });
      }
      const preflight = await deps.preflightDraft?.();
      if (preflight?.error) {
        return textResult({ status: "invalid_report", publicationStructure: "invalid", draftDigest: preflight.digest, message: preflight.error });
      }
      const prepared = await deps.prepareReportHtml();
      const viewport = resolveViewport(params.viewport);
      signal.throwIfAborted();
      const cacheKey = sha256(JSON.stringify({
        dependencyDigest: prepared.dependencyDigest,
        viewport,
        rendererVersion: ARTIFACT_RENDERER_VERSION,
        sampleTimeMs: 0,
      }));
      const cached = await cachedReportPreview(cache, cacheKey, deps.catalog);
      if (cached) {
        const delivered = await previewImages(textResult(cached), deps, params.includeImages === true, signal);
        signal.throwIfAborted();
        notePreview(deps, prepared, delivered);
        return delivered;
      }
      const result = await renderReportPreview({ deps, render, cache, cacheKey, prepared, viewport, signal, preflight: Boolean(preflight) });
      const delivered = await previewImages(result, deps, params.includeImages === true, signal);
      signal.throwIfAborted();
      notePreview(deps, prepared, delivered);
      return delivered;
    },
  };
}

function notePreview(deps: ComparisonPreviewReportToolDeps, prepared: PreparedReportPreview, result: AgentToolResult): void {
  const outcome = previewOutcome(result);
  deps.onPreviewFinished?.(prepared, outcome);
  if (outcome.status === "ok") deps.onPreviewSuccess?.(prepared);
}

function previewOutcome(result: AgentToolResult): PreviewReportOutcome {
  try {
    const payload = JSON.parse(result.content) as { status?: string; message?: string; failure?: { message?: string } };
    const message = payload.failure?.message ?? payload.message;
    return { status: payload.status ?? "unknown", ...(message ? { message } : {}) };
  } catch {
    return { status: "unknown" };
  }
}

async function previewImages(result: AgentToolResult, deps: ComparisonPreviewReportToolDeps, requested: boolean, signal: AbortSignal): Promise<AgentToolResult> {
  const payload = JSON.parse(result.content) as { status?: string; previewDigest?: string; previewMedia?: { shortRef: string; read?: { path: string } } };
  if (payload.status !== 'ok') return result;
  return attachComparisonImages({ result, requested, authorized: deps.allowImages === true, attemptRoot: deps.attemptRoot, signal,
    images: payload.previewMedia?.read && payload.previewDigest
      ? [{ path: payload.previewMedia.read.path, contentHash: payload.previewDigest, shortRef: payload.previewMedia.shortRef }] : [],
  });
}

async function cachedReportPreview(
  cache: Map<string, PreviewCacheEntry>,
  key: string,
  catalog: ComparisonRenderCatalogPort,
): Promise<Record<string, unknown> | undefined> {
  const cached = cache.get(key);
  if (!cached) return undefined;
  const bytes = await readFile(cached.pngPath).catch(() => undefined);
  if (bytes && sha256(bytes) === cached.contentHash) {
    const registered = await catalog.registerDerivedMedia(cached.registration);
    if (registered.ok) {
      return {
        ...cached.payload,
        previewMedia: { shortRef: registered.shortRef, mediaRef: registered.mediaRef, kind: "report_review",
          ...(registered.readPath ? { read: { path: registered.readPath, format: "image", mimeType: "image/png" } } : {}) },
      };
    }
  }
  cache.delete(key);
  return undefined;
}

async function renderReportPreview(input: {
  deps: ComparisonPreviewReportToolDeps;
  render: ArtifactRenderer;
  cache: Map<string, PreviewCacheEntry>;
  cacheKey: string;
  prepared: PreparedReportPreview;
  viewport: RenderViewport;
  signal: AbortSignal;
  preflight: boolean;
}): Promise<AgentToolResult> {
  const { deps, render, cache, cacheKey, prepared, viewport, signal, preflight } = input;
  const outputRoot = join(deps.attemptRoot, "review", "render", cacheKey);
  await mkdir(outputRoot, { recursive: true });
  if (!pathContainedBy(await realpath(deps.attemptRoot), await realpath(outputRoot))) {
    throw new Error("Comparison preview render output escapes attempt root.");
  }
  const rendered = await render({
    bundleRoot: prepared.outputRoot,
    entryRelativePath: "preview.html",
    viewport,
    sampleTimesMs: [0],
    outputRoot,
    signal,
    layoutSelectors: [
      { name: "headline", selector: '[data-agent-slot="headline"]' },
      { name: "comparison", selector: '[data-agent-zone="comparison"]' },
      { name: "firstImage", selector: '[data-agent-zone="comparison"] img' },
      { name: "metrics", selector: '[data-host-zone="metrics"]' },
    ],
  });
  if (!rendered.ok) return textResult({
    status: rendered.failure.kind, revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
    failure: rendered.failure, diagnostics: rendered.diagnostics,
  });
  const frame = rendered.frames[0];
  if (!frame) return textResult({
    status: "capture_failed", message: "no preview frame", revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
  });
  const registration: RegisterDerivedMediaInput = {
    side: "host", pngPath: frame.pngPath, label: "report-preview", sourceRef: "report.html",
    contentHash: frame.contentHash, kind: "report_review",
    derivation: {
      rendererVersion: ARTIFACT_RENDERER_VERSION, viewport: rendered.measured.viewport,
      sampleTimeMs: 0, actualTimeMs: frame.actualTimeMs,
      capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
  };
  const registered = await deps.catalog.registerDerivedMedia(registration);
  if (!registered.ok) return textResult({
    status: "capture_failed", revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
    code: registered.code, message: registered.message,
  });
  assertEvidenceShortRef(registered.shortRef, "report_review");
  const payload = {
    status: "ok", publicationStructure: preflight ? "valid" : "unchecked",
    revision: prepared.catalogRevision, draftDigest: prepared.draftDigest,
    preparedDigest: prepared.preparedDigest, previewDigest: frame.contentHash,
    previewMedia: { shortRef: registered.shortRef, mediaRef: registered.mediaRef, kind: "report_review",
      ...(registered.readPath ? { read: { path: registered.readPath, format: "image", mimeType: "image/png" } } : {}) },
    mechanics: inspectPreparedReportMechanics(prepared.html),
    ...(rendered.measured.layout ? { layout: rendered.measured.layout } : {}),
    diagnostics: rendered.diagnostics,
    note: "preview media uses review-* refs only; it is not baseline/candidate comparison evidence",
  };
  cache.set(cacheKey, { payload, pngPath: frame.pngPath, contentHash: frame.contentHash, registration });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return textResult(payload);
}

function summarizeLimitations(diagnostics: readonly { code: string; message: string }[]): string[] {
  const codes = new Set(diagnostics.map((item) => item.code));
  const out: string[] = [];
  if (codes.has("missing_local_dependency") || codes.has("resource_failed")) {
    out.push("one or more local dependencies failed to load");
  }
  if (codes.has("console_error")) out.push("page console errors were observed");
  if (codes.has("network_blocked")) out.push("non-bundle network requests were blocked");
  return out;
}

function resolveViewport(viewport: { width?: number; height?: number; scale?: number } | undefined): RenderViewport {
  return {
    width: viewport?.width ?? DEFAULT_RENDER_VIEWPORT.width,
    height: viewport?.height ?? DEFAULT_RENDER_VIEWPORT.height,
    scale: viewport?.scale ?? DEFAULT_RENDER_VIEWPORT.scale,
  };
}

function assertEvidenceShortRef(shortRef: string, kind: "artifact_preview" | "report_review"): void {
  if (kind === "artifact_preview" && !/^media-\d{2,6}$/.test(shortRef)) {
    throw new Error(`artifact_preview must mint media-* shortRef, got ${shortRef}`);
  }
  if (kind === "report_review" && !/^review-\d{2,6}$/.test(shortRef)) {
    throw new Error(`report_review must mint review-* shortRef, got ${shortRef}`);
  }
}

function inspectPreparedReportMechanics(html: string): Record<string, unknown> {
  type Node = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
  const active = { mediaRefCount: 0, imagesMissingSrc: 0, hostMetricsPresent: false, shareRegionPresent: false };
  const visit = (node: Node): void => {
    if (node.tagName === "template") return;
    const attrs = new Map((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
    if (attrs.has("data-media-ref")) active.mediaRefCount += 1;
    if (node.tagName === "img" && !attrs.get("src")) active.imagesMissingSrc += 1;
    if (attrs.get("data-host-zone") === "metrics") active.hostMetricsPresent = true;
    if (attrs.get("class")?.split(/\s+/).includes("share")) active.shareRegionPresent = true;
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as Node);
  const modelLabels = {
    hasHistorical: /历史会话|Historical/i.test(html),
    hasCurrent: /当前会话|Current/i.test(html),
  };
  return {
    ...active,
    modelLabels,
    htmlByteLength: Buffer.byteLength(html, "utf8"),
  };
}

function textResult(payload: Record<string, unknown>): AgentToolResult {
  return {
    content: JSON.stringify(payload, null, 2),
    details: payload,
  };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "source";
}
