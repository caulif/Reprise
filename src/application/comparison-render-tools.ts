import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ArtifactRenderer, RenderViewport } from "../infrastructure/artifact-render-types.js";
import { ARTIFACT_RENDERER_VERSION, DEFAULT_RENDER_VIEWPORT, RENDER_LIMITS } from "../infrastructure/artifact-render-types.js";
import { renderFrozenArtifact } from "../infrastructure/artifact-renderer.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

/** Narrow port owned by B3 catalog; B4 tools only call these methods. */
export type ComparisonRenderCatalogPort = {
  revision(): number;
  resolveSource(sourceRef: string): Promise<ComparisonRenderSource | undefined>;
  registerDerivedMedia(input: RegisterDerivedMediaInput): Promise<RegisterDerivedMediaResult>;
};

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

export type RegisterDerivedMediaResult = {
  shortRef: string;
  mediaRef: string;
  revision: number;
};

const ViewportSchema = Type.Object({
  width: Type.Integer({ minimum: RENDER_LIMITS.minWidth, maximum: RENDER_LIMITS.maxWidth }),
  height: Type.Integer({ minimum: RENDER_LIMITS.minHeight, maximum: RENDER_LIMITS.maxHeight }),
  scale: Type.Optional(Type.Number({ minimum: 1, maximum: RENDER_LIMITS.maxScale })),
});

export const RenderArtifactParamsSchema = Type.Object({
  sourceRef: Type.String({ minLength: 1, maxLength: 128 }),
  viewport: Type.Optional(ViewportSchema),
  sampleTimesMs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: RENDER_LIMITS.maxSampleMs }), {
    minItems: 1,
    maxItems: RENDER_LIMITS.maxFrames,
  })),
});
export type RenderArtifactParams = Static<typeof RenderArtifactParamsSchema>;

export const PreviewReportParamsSchema = Type.Object({
  viewport: Type.Optional(ViewportSchema),
});
export type PreviewReportParams = Static<typeof PreviewReportParamsSchema>;

export type ComparisonRenderToolDeps = {
  catalog: ComparisonRenderCatalogPort;
  attemptRoot: string;
  render?: ArtifactRenderer;
  /** Prepare draft HTML with current catalog revision (B3/B6 share this). */
  prepareReportHtml: () => Promise<PreparedReportPreview>;
  now?: () => Date;
};

export type PreparedReportPreview = {
  htmlPath: string;
  html: string;
  draftDigest: string;
  preparedDigest: string;
  catalogRevision: number;
  outputRoot: string;
};

export function createRenderArtifactTool(deps: ComparisonRenderToolDeps): AgentToolDefinition {
  const render = deps.render ?? renderFrozenArtifact;
  return {
    name: "render_artifact",
    description:
      "Derive preview frames from a registered sourceRef (HTML/SVG/raster). Returns media short refs and load diagnostics. Does not accept absolute paths or arbitrary URLs.",
    parameters: RenderArtifactParamsSchema,
    async execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult> {
      if (!Value.Check(RenderArtifactParamsSchema, params)) {
        return textResult({ status: "invalid_request", message: "parameters failed schema check" });
      }
      const source = await deps.catalog.resolveSource(params.sourceRef);
      if (!source) {
        return textResult({ status: "unknown_source", sourceRef: params.sourceRef, revision: deps.catalog.revision() });
      }
      const viewport: RenderViewport = {
        width: params.viewport?.width ?? DEFAULT_RENDER_VIEWPORT.width,
        height: params.viewport?.height ?? DEFAULT_RENDER_VIEWPORT.height,
        scale: params.viewport?.scale ?? DEFAULT_RENDER_VIEWPORT.scale,
      };
      const sampleTimesMs = params.sampleTimesMs ?? [0];
      const outputRoot = join(deps.attemptRoot, "scratch", "render", safeId(params.sourceRef));
      const rendered = await render({
        bundleRoot: source.bundleRoot,
        entryRelativePath: source.entryRelativePath,
        viewport,
        sampleTimesMs,
        outputRoot,
        signal,
      });
      if (!rendered.ok) {
        return textResult({
          status: rendered.failure.kind,
          sourceRef: params.sourceRef,
          revision: deps.catalog.revision(),
          failure: rendered.failure,
          diagnostics: rendered.diagnostics,
        });
      }
      const mediaRefs: { shortRef: string; mediaRef: string; sampleTimeMs: number; actualTimeMs: number }[] = [];
      const capturedAt = (deps.now ?? (() => new Date()))().toISOString();
      for (const frame of rendered.frames) {
        const registered = await deps.catalog.registerDerivedMedia({
          side: source.side === "derived" ? "host" : source.side,
          pngPath: frame.pngPath,
          label: `${source.entryRelativePath}@${frame.sampleTimeMs}ms`,
          sourceRef: source.sourceRef,
          contentHash: frame.contentHash,
          kind: "artifact_preview",
          derivation: {
            rendererVersion: ARTIFACT_RENDERER_VERSION,
            viewport: rendered.measured.viewport,
            sampleTimeMs: frame.sampleTimeMs,
            actualTimeMs: frame.actualTimeMs,
            capturedAt,
          },
        });
        mediaRefs.push({
          shortRef: registered.shortRef,
          mediaRef: registered.mediaRef,
          sampleTimeMs: frame.sampleTimeMs,
          actualTimeMs: frame.actualTimeMs,
        });
      }
      return textResult({
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
    },
  };
}

export function createPreviewReportTool(deps: ComparisonRenderToolDeps): AgentToolDefinition {
  const render = deps.render ?? renderFrozenArtifact;
  return {
    name: "preview_report",
    description:
      "Mechanically preview the current attempt report.html with the current catalog revision. Review screenshots go under review/ and are not comparison evidence.",
    parameters: PreviewReportParamsSchema,
    async execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult> {
      if (!Value.Check(PreviewReportParamsSchema, params)) {
        return textResult({ status: "invalid_request", message: "parameters failed schema check" });
      }
      const prepared = await deps.prepareReportHtml();
      const viewport: RenderViewport = {
        width: params.viewport?.width ?? DEFAULT_RENDER_VIEWPORT.width,
        height: params.viewport?.height ?? DEFAULT_RENDER_VIEWPORT.height,
        scale: params.viewport?.scale ?? DEFAULT_RENDER_VIEWPORT.scale,
      };
      const rendered = await render({
        bundleRoot: prepared.outputRoot,
        entryRelativePath: "preview.html",
        viewport,
        sampleTimesMs: [0],
        outputRoot: join(deps.attemptRoot, "review", "render"),
        signal,
      });
      if (!rendered.ok) {
        return textResult({
          status: rendered.failure.kind,
          revision: prepared.catalogRevision,
          draftDigest: prepared.draftDigest,
          preparedDigest: prepared.preparedDigest,
          failure: rendered.failure,
          diagnostics: rendered.diagnostics,
        });
      }
      const frame = rendered.frames[0];
      if (!frame) {
        return textResult({
          status: "capture_failed",
          message: "no preview frame",
          revision: prepared.catalogRevision,
          draftDigest: prepared.draftDigest,
          preparedDigest: prepared.preparedDigest,
        });
      }
      const registered = await deps.catalog.registerDerivedMedia({
        side: "host",
        pngPath: frame.pngPath,
        label: "report-preview",
        sourceRef: "report.html",
        contentHash: frame.contentHash,
        kind: "report_review",
        derivation: {
          rendererVersion: ARTIFACT_RENDERER_VERSION,
          viewport: rendered.measured.viewport,
          sampleTimeMs: 0,
          actualTimeMs: frame.actualTimeMs,
          capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
        },
      });
      const mechanics = inspectPreparedReportMechanics(prepared.html);
      return textResult({
        status: "ok",
        revision: prepared.catalogRevision,
        draftDigest: prepared.draftDigest,
        preparedDigest: prepared.preparedDigest,
        previewDigest: frame.contentHash,
        previewMedia: { shortRef: registered.shortRef, mediaRef: registered.mediaRef, kind: "report_review" },
        mechanics,
        diagnostics: rendered.diagnostics,
        note: "preview media is host review only; it is not baseline/candidate comparison evidence",
      });
    },
  };
}

export function summarizeLimitations(diagnostics: readonly { code: string; message: string }[]): string[] {
  const codes = new Set(diagnostics.map((item) => item.code));
  const out: string[] = [];
  if (codes.has("missing_local_dependency") || codes.has("resource_failed")) {
    out.push("one or more local dependencies failed to load");
  }
  if (codes.has("console_error")) out.push("page console errors were observed");
  if (codes.has("network_blocked")) out.push("non-bundle network requests were blocked");
  if (codes.has("virtual_time_unavailable")) out.push("controlled timing unavailable");
  return out;
}

function inspectPreparedReportMechanics(html: string): Record<string, unknown> {
  const imgRefs = [...html.matchAll(/\bdata-media-ref=["']([^"']+)["']/gi)].map((m) => m[1]);
  const imgsWithSrc = [...html.matchAll(/<img\b[^>]*>/gi)];
  const missingSrc = imgsWithSrc.filter((tag) => !/\bsrc=["'][^"']+["']/i.test(tag[0] ?? "")).length;
  const hostMetricsVisible = /data-host-zone=["']metrics["']/i.test(html);
  const modelLabels = {
    hasHistorical: /历史会话|Historical/i.test(html),
    hasCurrent: /当前会话|Current/i.test(html),
  };
  const share = html.match(/class=["'][^"']*\bshare\b[^"']*["']/i);
  return {
    mediaRefCount: imgRefs.length,
    imagesMissingSrc: missingSrc,
    hostMetricsVisible,
    modelLabels,
    shareRegionPresent: Boolean(share),
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
