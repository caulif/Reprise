import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "parse5";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonPreviewReceiptSchema, type ComparisonPreviewReceipt } from "../core/schema.js";
import type { ArtifactRenderer, RenderViewport } from "../infrastructure/artifact-render-types.js";
import { ARTIFACT_RENDERER_VERSION, DEFAULT_RENDER_VIEWPORT, RENDER_LIMITS } from "../infrastructure/artifact-render-types.js";
import { renderFrozenArtifact } from "../infrastructure/artifact-renderer.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

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
    sourceHash?: string;
    finalUrl?: string;
    urlStateOmitted?: boolean;
    errorsOmitted?: number;
    actions?: readonly { action: "click" | "fill"; selector: string; elapsedMs: number }[];
  };
};

export type RegisterDerivedMediaResult =
  | {
      ok: true;
      shortRef: string;
      mediaRef: string;
      revision: number;
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
});
export type RenderArtifactParams = Static<typeof RenderArtifactParamsSchema>;

const PreviewReportParamsSchema = Type.Object({
  viewport: Type.Optional(ViewportSchema),
});
export type PreviewReportParams = Static<typeof PreviewReportParamsSchema>;

export type ComparisonRenderToolBaseDeps = {
  catalog: ComparisonRenderCatalogPort;
  attemptRoot: string;
  allowBinary?: boolean;
  render?: ArtifactRenderer;
  now?: () => Date;
};

export type ComparisonPreviewReportToolDeps = ComparisonRenderToolBaseDeps & {
  /** Prepare draft HTML with current catalog revision (B3/B6 share this). */
  prepareReportHtml: () => Promise<PreparedReportPreview>;
  onReceipt?: (receipt: ComparisonPreviewReceipt) => void;
};

export type PreparedReportPreview = {
  htmlPath: string;
  html: string;
  draftDigest: string;
  preparedDigest: string;
  catalogRevision: number;
  outputRoot: string;
  validationDigest?: string;
};

export function createRenderArtifactTool(deps: ComparisonRenderToolBaseDeps): AgentToolDefinition {
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
      const viewport = resolveViewport(params.viewport);
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
      if (sampleTimesMs.length > 1 && new Set(rendered.frames.map((frame) => frame.contentHash)).size < 2) {
        return textResult({
          status: "motion_not_proven",
          sourceRef: params.sourceRef,
          revision: deps.catalog.revision(),
          message: "Multiple sample times produced identical PNG content; motion evidence was not registered.",
          sampleTimesMs,
          diagnostics: rendered.diagnostics,
        });
      }
      const capturedAt = (deps.now ?? (() => new Date()))().toISOString();
      const registrations = await deps.catalog.registerDerivedMediaBatch(rendered.frames.map((frame) => ({
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
        })));
      if (!registrations.ok) return textResult({
        status: "capture_failed",
        sourceRef: params.sourceRef,
        revision: deps.catalog.revision(),
        code: registrations.code,
        message: registrations.message,
      });
      const mediaRefs: { shortRef: string; mediaRef: string; sampleTimeMs: number; actualTimeMs: number }[] = [];
      for (const [index, registered] of registrations.items.entries()) {
        const frame = rendered.frames[index];
        if (!frame) continue;
        assertEvidenceShortRef(registered.shortRef, "artifact_preview");
        mediaRefs.push({
          shortRef: registered.shortRef,
          mediaRef: registered.mediaRef,
          sampleTimeMs: frame.sampleTimeMs,
          actualTimeMs: frame.actualTimeMs,
        });
      }
      return imageResult({
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
      }, deps.allowBinary === false ? [] : rendered.frames);
    },
  };
}

export function createPreviewReportTool(deps: ComparisonPreviewReportToolDeps): AgentToolDefinition {
  const render = deps.render ?? renderFrozenArtifact;
  let receipt: ComparisonPreviewReceipt | undefined;
  return {
    name: "preview_report",
    description:
      "Validate and preview current work/report content against Host facts and the current catalog. Review screenshots use review-* refs and are not comparison evidence.",
    parameters: PreviewReportParamsSchema,
    async onCompleted(visible) {
      if (!receipt) return;
      const delivered = visible.contentBlocks?.some((block) => block.type === "image") ?? false;
      const mode = delivered && receipt.reviewRefs.length ? "visual" : "mechanical";
      const details = visible.details as Record<string, unknown> | undefined;
      if (details) details.reviewMode = mode;
      visible.content = visible.content.replace('"reviewMode": "pending"', `"reviewMode": "${mode}"`);
      if (visible.contentBlocks) visible.contentBlocks = visible.contentBlocks.map((block) => block.type === "text"
        ? { ...block, text: block.text.replace('"reviewMode": "pending"', `"reviewMode": "${mode}"`) }
        : block);
      const completed = {
        ...receipt,
        reviewMode: mode,
      } as ComparisonPreviewReceipt;
      if (!Value.Check(ComparisonPreviewReceiptSchema, completed)) throw new Error("Comparison preview receipt failed schema validation.");
      await writeAtomic(join(deps.attemptRoot, "review", "receipt.json"), `${JSON.stringify(completed)}\n`);
      deps.onReceipt?.(completed);
    },
    async execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult> {
      receipt = undefined;
      if (!Value.Check(PreviewReportParamsSchema, params)) {
        return textResult({ status: "invalid_request", message: "parameters failed schema check" });
      }
      let prepared: PreparedReportPreview;
      try {
        prepared = await deps.prepareReportHtml();
      } catch (error) {
        return textResult({ status: "invalid_content", rendered: false, contractValid: false,
          publishable: false, diagnostics: [error instanceof Error ? error.message : String(error)] });
      }
      if (prepared.validationDigest) receipt = {
        schemaVersion: 1, contentDigest: prepared.draftDigest,
        validationDigest: prepared.validationDigest, preparedDigest: prepared.preparedDigest,
        evidenceRevision: prepared.catalogRevision, contractValid: true, publishable: true,
        reviewMode: "mechanical", reviewRefs: [],
      };
      const preview = await renderPreparedPreview(deps, render, prepared, params, signal);
      if (receipt && preview.reviewRef) receipt = { ...receipt, reviewRefs: [preview.reviewRef] };
      return preview.result;
    },
  };
}

async function renderPreparedPreview(
  deps: ComparisonPreviewReportToolDeps,
  render: ArtifactRenderer,
  prepared: PreparedReportPreview,
  params: PreviewReportParams,
  signal: AbortSignal,
): Promise<{ result: AgentToolResult; reviewRef?: string }> {
  const rendered = await render({
    bundleRoot: prepared.outputRoot,
    entryRelativePath: "preview.html",
    viewport: resolveViewport(params.viewport),
    sampleTimesMs: [0],
    outputRoot: join(deps.attemptRoot, "review", "render"),
    signal,
  });
  if (!rendered.ok) return { result: textResult({
    status: rendered.failure.kind, rendered: false, contractValid: true, publishable: true,
    reviewMode: "mechanical", revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
    failure: rendered.failure, diagnostics: rendered.diagnostics,
  }) };
  const frame = rendered.frames[0];
  if (!frame) return { result: textResult({ status: "capture_failed", message: "no preview frame",
    revision: prepared.catalogRevision, draftDigest: prepared.draftDigest,
    preparedDigest: prepared.preparedDigest }) };
  const registered = await deps.catalog.registerDerivedMedia({
    side: "host", pngPath: frame.pngPath, label: "report-preview", sourceRef: "report.html",
    contentHash: frame.contentHash, kind: "report_review",
    derivation: { rendererVersion: ARTIFACT_RENDERER_VERSION, viewport: rendered.measured.viewport,
      sampleTimeMs: 0, actualTimeMs: frame.actualTimeMs,
      capturedAt: (deps.now ?? (() => new Date()))().toISOString() },
  });
  if (!registered.ok) return { result: textResult({ status: "capture_failed", revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
    code: registered.code, message: registered.message }) };
  assertEvidenceShortRef(registered.shortRef, "report_review");
  const mechanics = inspectPreparedReportMechanics(prepared.html);
  return { reviewRef: registered.shortRef, result: await imageResult({
    status: "ok", rendered: true, contractValid: true, publishable: true,
    reviewMode: "pending", revision: prepared.catalogRevision,
    draftDigest: prepared.draftDigest, preparedDigest: prepared.preparedDigest,
    previewDigest: frame.contentHash,
    previewMedia: { shortRef: registered.shortRef, mediaRef: registered.mediaRef, kind: "report_review" },
    mechanics, diagnostics: rendered.diagnostics,
    note: "preview media uses review-* refs only; it is not baseline/candidate comparison evidence",
  }, deps.allowBinary === false ? [] : [frame]) };
}

async function imageResult(payload: Record<string, unknown>, frames: readonly { pngPath: string; contentHash: string }[]): Promise<AgentToolResult> {
  const content = JSON.stringify(payload, null, 2);
  const images = await Promise.all(frames.map(async (frame) => {
    const bytes = await readFile(frame.pngPath);
    if (sha256(bytes) !== frame.contentHash) throw new Error(`Rendered image changed before model delivery: ${frame.pngPath}`);
    return { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
  }));
  return { content, details: payload, contentBlocks: [{ type: "text", text: content }, ...images] };
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
  const imgRefs: string[] = [];
  let missingSrc = 0;
  const visit = (node: Node): void => {
    if (node.tagName === "template" || node.tagName === "dialog") return;
    if (node.tagName === "img") {
      const attrs = new Map((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
      const ref = attrs.get("data-media-ref");
      if (ref) imgRefs.push(ref);
      if (!attrs.get("src")) missingSrc += 1;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as unknown as Node);
  const hostMetricsVisible = /data-host-zone=["']metrics["']/i.test(html);
  const modelLabels = {
    hasHistorical: /历史结果|Historical result/i.test(html),
    hasCurrent: /本次结果|This run/i.test(html),
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
