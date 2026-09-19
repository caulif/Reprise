export const ARTIFACT_RENDERER_VERSION = "reprise-artifact-renderer/1";

export type RenderViewport = {
  width: number;
  height: number;
  scale: number;
};

export type RenderRequest = {
  bundleRoot: string;
  entryRelativePath: string;
  viewport: RenderViewport;
  sampleTimesMs: readonly number[];
  outputRoot: string;
  signal: AbortSignal;
};

export type RenderFrame = {
  sampleTimeMs: number;
  actualTimeMs: number;
  pngPath: string;
  byteLength: number;
  contentHash: string;
};

export type RenderDiagnostic = {
  code: string;
  message: string;
  detail?: string;
};

export type RenderFailureKind =
  | { kind: "no_browser" }
  | { kind: "unsupported_format"; mediaType?: string }
  | { kind: "capability_unavailable"; message: string }
  | { kind: "cancelled" }
  | { kind: "capture_failed"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "invalid_request"; message: string };

export type RenderResult =
  | {
      ok: true;
      frames: RenderFrame[];
      diagnostics: RenderDiagnostic[];
      measured: { loadMs: number; viewport: RenderViewport; origin: string };
    }
  | {
      ok: false;
      failure: RenderFailureKind;
      diagnostics: RenderDiagnostic[];
    };

export type ArtifactRenderer = (request: RenderRequest) => Promise<RenderResult>;

export const DEFAULT_RENDER_VIEWPORT: RenderViewport = { width: 1280, height: 900, scale: 1 };

export const RENDER_LIMITS = {
  maxFrames: 8,
  maxSampleMs: 10_000,
  minWidth: 320,
  minHeight: 240,
  maxWidth: 1920,
  maxHeight: 1200,
  maxScale: 2,
  maxPixels: 1920 * 1200 * 4,
  loadTimeoutMs: 15_000,
  sessionTimeoutMs: 60_000,
} as const;

export const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
export const DOCUMENT_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg"]);
