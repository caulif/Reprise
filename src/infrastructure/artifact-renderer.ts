import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathContainedBy } from "../core/paths.js";
import { sha256, sha256File } from "../core/identity.js";
import { startBundleStaticServer, type BundleStaticServer } from "./artifact-bundle-server.js";
import {
  capturePngBase64,
  configurePageSession,
  createPageTarget,
  evaluateJson,
  navigateAndWait,
  openCdpBrowserSession,
  type CdpSession,
} from "./artifact-cdp.js";
import {
  DEFAULT_RENDER_VIEWPORT,
  DOCUMENT_EXTENSIONS,
  RASTER_EXTENSIONS,
  RENDER_LIMITS,
  type ArtifactRenderer,
  type RenderDiagnostic,
  type RenderFrame,
  type RenderRequest,
  type RenderResult,
} from "./artifact-render-types.js";

export {
  ARTIFACT_RENDERER_VERSION,
  DEFAULT_RENDER_VIEWPORT,
  RENDER_LIMITS,
  type ArtifactRenderer,
  type RenderDiagnostic,
  type RenderFrame,
  type RenderRequest,
  type RenderResult,
  type RenderViewport,
} from "./artifact-render-types.js";

export async function renderFrozenArtifact(request: RenderRequest): Promise<RenderResult> {
  const validated = validateRenderRequest(request);
  if (!validated.ok) return validated;

  if (request.signal.aborted) {
    return { ok: false, failure: { kind: "cancelled" }, diagnostics: [] };
  }

  const entryExt = extname(request.entryRelativePath).toLowerCase();
  if (RASTER_EXTENSIONS.has(entryExt)) {
    return renderRasterFrame(request);
  }
  if (!DOCUMENT_EXTENSIONS.has(entryExt)) {
    return {
      ok: false,
      failure: entryExt
        ? { kind: "unsupported_format", mediaType: entryExt.slice(1) }
        : { kind: "unsupported_format" },
      diagnostics: [{ code: "unsupported_format", message: `unsupported entry extension ${entryExt || "(none)"}` }],
    };
  }

  return renderDocumentBundle(request);
}

export function createFakeArtifactRenderer(handler: ArtifactRenderer): ArtifactRenderer {
  return handler;
}

export async function captureHeadlessScreenshotViaRenderer(
  sourcePath: string,
  destPng: string,
  render: ArtifactRenderer = renderFrozenArtifact,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true } | { ok: false; failure: { kind: "no_browser" } | { kind: "capture_failed"; message: string } }> {
  const outputRoot = dirname(destPng);
  await mkdir(outputRoot, { recursive: true });
  const result = await render({
    bundleRoot: dirname(sourcePath),
    entryRelativePath: basename(sourcePath),
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot,
    signal,
  });
  if (!result.ok) {
    if (result.failure.kind === "no_browser") return { ok: false, failure: { kind: "no_browser" } };
    if (result.failure.kind === "cancelled") {
      return { ok: false, failure: { kind: "capture_failed", message: "cancelled" } };
    }
    const message = "message" in result.failure ? result.failure.message : result.failure.kind;
    return { ok: false, failure: { kind: "capture_failed", message } };
  }
  const frame = result.frames[0];
  if (!frame) return { ok: false, failure: { kind: "capture_failed", message: "no frames captured" } };
  if (frame.pngPath !== destPng) await copyFile(frame.pngPath, destPng);
  return { ok: true };
}

function validateRenderRequest(request: RenderRequest): { ok: true } | RenderResult {
  const diagnostics: RenderDiagnostic[] = [];
  const { viewport, sampleTimesMs } = request;
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || !Number.isFinite(viewport.scale)) {
    return invalid("viewport must use integer width/height and finite scale", diagnostics);
  }
  if (
    viewport.width < RENDER_LIMITS.minWidth
    || viewport.height < RENDER_LIMITS.minHeight
    || viewport.width > RENDER_LIMITS.maxWidth
    || viewport.height > RENDER_LIMITS.maxHeight
    || viewport.scale < 1
    || viewport.scale > RENDER_LIMITS.maxScale
  ) {
    return invalid("viewport outside allowed bounds", diagnostics);
  }
  const pixels = viewport.width * viewport.height * viewport.scale * viewport.scale;
  if (pixels > RENDER_LIMITS.maxPixels) return invalid("viewport pixel budget exceeded", diagnostics);
  if (sampleTimesMs.length === 0 || sampleTimesMs.length > RENDER_LIMITS.maxFrames) {
    return invalid(`sampleTimesMs length must be 1..${RENDER_LIMITS.maxFrames}`, diagnostics);
  }
  let previous = -1;
  for (const sample of sampleTimesMs) {
    if (!Number.isInteger(sample) || sample < 0 || sample > RENDER_LIMITS.maxSampleMs) {
      return invalid(`sample time ${sample} outside 0..${RENDER_LIMITS.maxSampleMs}`, diagnostics);
    }
    if (sample < previous) return invalid("sampleTimesMs must be non-decreasing", diagnostics);
    previous = sample;
  }
  const entry = request.entryRelativePath.replaceAll("\\", "/");
  if (!entry || entry.startsWith("/") || entry.includes("..") || entry.includes("\0")) {
    return invalid("entryRelativePath must be a relative contained path", diagnostics);
  }
  return { ok: true };
}

function invalid(message: string, diagnostics: RenderDiagnostic[]): RenderResult {
  diagnostics.push({ code: "invalid_request", message });
  return { ok: false, failure: { kind: "invalid_request", message }, diagnostics };
}

async function renderRasterFrame(request: RenderRequest): Promise<RenderResult> {
  const diagnostics: RenderDiagnostic[] = [];
  try {
    const rootReal = await realpath(request.bundleRoot);
    const absolute = join(rootReal, ...request.entryRelativePath.split("/"));
    if (!pathContainedBy(rootReal, absolute)) {
      return { ok: false, failure: { kind: "invalid_request", message: "entry escapes bundle root" }, diagnostics };
    }
    await mkdir(request.outputRoot, { recursive: true });
    const pngPath = join(request.outputRoot, "frame-000.png");
    await copyFile(absolute, pngPath);
    const byteLength = (await readFile(pngPath)).byteLength;
    const contentHash = await sha256File(pngPath);
    const frame: RenderFrame = {
      sampleTimeMs: request.sampleTimesMs[0] ?? 0,
      actualTimeMs: request.sampleTimesMs[0] ?? 0,
      pngPath,
      byteLength,
      contentHash,
    };
    return {
      ok: true,
      frames: [frame],
      diagnostics,
      measured: { loadMs: 0, viewport: request.viewport, origin: "raster-copy" },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { kind: "capture_failed", message }, diagnostics };
  }
}

async function renderDocumentBundle(request: RenderRequest): Promise<RenderResult> {
  const diagnostics: RenderDiagnostic[] = [];
  let server: BundleStaticServer | undefined;
  let cdp: Awaited<ReturnType<typeof openCdpBrowserSession>> | undefined;
  const watchdog = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(RENDER_LIMITS.sessionTimeoutMs),
  ]);

  try {
    if (watchdog.aborted) return { ok: false, failure: { kind: "cancelled" }, diagnostics };
    const opened = await openDocumentSession(request, watchdog, diagnostics);
    if (!opened.ok) return opened.result;
    server = opened.server;
    cdp = opened.cdp;
    const navigated = await navigateDocument(opened, request, watchdog, diagnostics);
    if (!navigated.ok) return navigated.result;
    const frames = await captureSampledFrames(opened.cdp, opened.pageSessionId, request, navigated.originMs, watchdog, diagnostics);
    if (!frames.ok) return frames.result;
    appendGuardDiagnostics(diagnostics, opened.guards);
    return {
      ok: true,
      frames: frames.frames,
      diagnostics: [...diagnostics, ...opened.cdp.diagnostics],
      measured: { loadMs: navigated.loadMs, viewport: request.viewport, origin: opened.server.origin },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.signal.aborted || /cancelled/i.test(message)) {
      return { ok: false, failure: { kind: "cancelled" }, diagnostics };
    }
    return { ok: false, failure: { kind: "capture_failed", message }, diagnostics };
  } finally {
    await cleanupDocumentSession(cdp, server, diagnostics);
  }
}

type OpenedDocumentSession = {
  ok: true;
  server: BundleStaticServer;
  cdp: CdpSession;
  pageSessionId: string;
  guards: Awaited<ReturnType<typeof configurePageSession>>;
};

async function openDocumentSession(
  request: RenderRequest,
  watchdog: AbortSignal,
  diagnostics: RenderDiagnostic[],
): Promise<OpenedDocumentSession | { ok: false; result: RenderResult }> {
  const rootReal = await realpath(request.bundleRoot);
  const entryAbsolute = join(rootReal, ...request.entryRelativePath.split("/"));
  if (!pathContainedBy(rootReal, entryAbsolute)) {
    return {
      ok: false,
      result: { ok: false, failure: { kind: "invalid_request", message: "entry escapes bundle root" }, diagnostics },
    };
  }
  const server = await startBundleStaticServer(rootReal);
  const cdp = await openCdpBrowserSession(watchdog);
  if ("failure" in cdp) {
    // Browser never opened; drop the temporary loopback server without treating close races as render failures.
    await server.close().catch(() => undefined);
    return {
      ok: false,
      result: {
        ok: false,
        failure: cdp.failure === "no_browser"
          ? { kind: "no_browser" }
          : { kind: "capability_unavailable", message: cdp.message },
        diagnostics: [...diagnostics, ...cdp.diagnostics],
      },
    };
  }
  const page = await createPageTarget(cdp);
  const guards = await configurePageSession(cdp, page.sessionId, request.viewport, server.origin);
  diagnostics.push({
    code: "timing_mode",
    message: "wall_clock_after_load",
    detail: "pre-navigation virtual-time pause prevents Page.load on current Chrome; samples wait on performance.now() after load",
  });
  return { ok: true, server, cdp, pageSessionId: page.sessionId, guards };
}

async function navigateDocument(
  opened: OpenedDocumentSession,
  request: RenderRequest,
  watchdog: AbortSignal,
  diagnostics: RenderDiagnostic[],
): Promise<{ ok: true; loadMs: number; originMs: number } | { ok: false; result: RenderResult }> {
  const entryUrl = `${opened.server.origin}/${request.entryRelativePath.split("\\").join("/")}`;
  try {
    const loadMs = await navigateAndWait(opened.cdp, opened.pageSessionId, entryUrl, RENDER_LIMITS.loadTimeoutMs, watchdog);
    const originMs = await evaluateJson<number>(opened.cdp, opened.pageSessionId, "performance.now()");
    return { ok: true, loadMs, originMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const merged = [
      ...diagnostics,
      ...opened.cdp.diagnostics,
      ...opened.guards.consoleErrors.map((text) => ({ code: "console_error", message: text })),
      ...opened.guards.resourceFailures.map((text) => ({ code: "resource_failed", message: text })),
    ];
    if (watchdog.aborted || request.signal.aborted) {
      return { ok: false, result: { ok: false, failure: { kind: "cancelled" }, diagnostics: merged } };
    }
    if (/timed out/i.test(message)) {
      return { ok: false, result: { ok: false, failure: { kind: "timeout", message }, diagnostics: merged } };
    }
    return { ok: false, result: { ok: false, failure: { kind: "capture_failed", message }, diagnostics: merged } };
  }
}

async function captureSampledFrames(
  session: CdpSession,
  pageSessionId: string,
  request: RenderRequest,
  originMs: number,
  watchdog: AbortSignal,
  diagnostics: RenderDiagnostic[],
): Promise<{ ok: true; frames: RenderFrame[] } | { ok: false; result: RenderResult }> {
  await mkdir(request.outputRoot, { recursive: true });
  const frames: RenderFrame[] = [];
  for (const [index, sampleTimeMs] of request.sampleTimesMs.entries()) {
    if (watchdog.aborted) {
      return {
        ok: false,
        result: { ok: false, failure: { kind: "cancelled" }, diagnostics: [...diagnostics, ...session.diagnostics] },
      };
    }
    let actualTimeMs: number;
    try {
      actualTimeMs = await waitForSampleTime(session, pageSessionId, originMs, sampleTimeMs, watchdog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = watchdog.aborted || request.signal.aborted ? "cancelled" as const : "timeout" as const;
      return {
        ok: false,
        result: {
          ok: false,
          failure: kind === "cancelled" ? { kind } : { kind, message },
          diagnostics: [...diagnostics, ...session.diagnostics],
        },
      };
    }
    const pngPath = join(request.outputRoot, `frame-${String(index).padStart(3, "0")}.png`);
    const data = await capturePngBase64(session, pageSessionId);
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength <= 0) {
      return {
        ok: false,
        result: {
          ok: false,
          failure: { kind: "capture_failed", message: "empty png frame" },
          diagnostics: [...diagnostics, ...session.diagnostics],
        },
      };
    }
    await writeFile(pngPath, bytes);
    frames.push({
      sampleTimeMs,
      actualTimeMs,
      pngPath,
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
    });
  }
  return { ok: true, frames };
}

function appendGuardDiagnostics(
  diagnostics: RenderDiagnostic[],
  guards: Awaited<ReturnType<typeof configurePageSession>>,
): void {
  for (const url of guards.blockedRequests) {
    diagnostics.push({ code: "network_blocked", message: "blocked non-bundle request", detail: redactUrl(url) });
  }
  for (const text of guards.consoleErrors) {
    diagnostics.push({ code: "console_error", message: text });
  }
  for (const text of guards.resourceFailures) {
    diagnostics.push({ code: "resource_failed", message: text });
  }
  if (guards.resourceFailures.length > 0) {
    diagnostics.push({
      code: "missing_local_dependency",
      message: "one or more local bundle resources failed to load",
    });
  }
}

async function cleanupDocumentSession(
  cdp: Awaited<ReturnType<typeof openCdpBrowserSession>> | undefined,
  server: BundleStaticServer | undefined,
  diagnostics: RenderDiagnostic[],
): Promise<void> {
  if (cdp && !("failure" in cdp)) await cdp.close();
  if (server) {
    await server.close().catch((error: unknown) => {
      diagnostics.push({
        code: "server_cleanup_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

async function waitForSampleTime(
  session: CdpSession,
  pageSessionId: string,
  originMs: number,
  sampleTimeMs: number,
  signal: AbortSignal,
): Promise<number> {
  const target = originMs + sampleTimeMs;
  const deadline = Date.now() + RENDER_LIMITS.sessionTimeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("cancelled during sample wait");
    const now = await evaluateJson<number>(session, pageSessionId, "performance.now()");
    if (now >= target) return Math.max(0, Math.round(now - originMs));
    await sleep(Math.min(40, Math.max(1, target - now)));
  }
  throw new Error(`timed out waiting for sample ${sampleTimeMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
