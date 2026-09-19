import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathContainedBy } from "../core/paths.js";
import { sha256, sha256File } from "../core/identity.js";
import { startBundleStaticServer } from "./artifact-bundle-server.js";
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
  let server: Awaited<ReturnType<typeof startBundleStaticServer>> | undefined;
  let cdp: Awaited<ReturnType<typeof openCdpBrowserSession>> | undefined;

  const watchdog = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(RENDER_LIMITS.sessionTimeoutMs),
  ]);

  try {
    if (watchdog.aborted) {
      return { ok: false, failure: { kind: "cancelled" }, diagnostics };
    }
    const rootReal = await realpath(request.bundleRoot);
    const entryAbsolute = join(rootReal, ...request.entryRelativePath.split("/"));
    if (!pathContainedBy(rootReal, entryAbsolute)) {
      return { ok: false, failure: { kind: "invalid_request", message: "entry escapes bundle root" }, diagnostics };
    }

    server = await startBundleStaticServer(rootReal);
    cdp = await openCdpBrowserSession(watchdog);
    if ("failure" in cdp) {
      return {
        ok: false,
        failure: cdp.failure === "no_browser"
          ? { kind: "no_browser" }
          : { kind: "capability_unavailable", message: cdp.message },
        diagnostics: [...diagnostics, ...cdp.diagnostics],
      };
    }

    const page = await createPageTarget(cdp);
    const guards = await configurePageSession(cdp, page.sessionId, request.viewport, server.origin);
    diagnostics.push({
      code: "timing_mode",
      message: "wall_clock_after_load",
      detail: "pre-navigation virtual-time pause prevents Page.load on current Chrome; samples wait on performance.now() after load",
    });

    const entryUrl = `${server.origin}/${request.entryRelativePath.split("\\").join("/")}`;
    let loadMs: number;
    try {
      loadMs = await navigateAndWait(cdp, page.sessionId, entryUrl, RENDER_LIMITS.loadTimeoutMs, watchdog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (watchdog.aborted || request.signal.aborted) {
        return { ok: false, failure: { kind: "cancelled" }, diagnostics: [...diagnostics, ...cdp.diagnostics] };
      }
      if (/timed out/i.test(message)) {
        return {
          ok: false,
          failure: { kind: "timeout", message },
          diagnostics: [
            ...diagnostics,
            ...cdp.diagnostics,
            ...guards.consoleErrors.map((text) => ({ code: "console_error", message: text })),
            ...guards.resourceFailures.map((text) => ({ code: "resource_failed", message: text })),
          ],
        };
      }
      return {
        ok: false,
        failure: { kind: "capture_failed", message },
        diagnostics: [...diagnostics, ...cdp.diagnostics],
      };
    }

    const originMs = await evaluateJson<number>(cdp, page.sessionId, "performance.now()");
    await mkdir(request.outputRoot, { recursive: true });
    const frames: RenderFrame[] = [];
    for (const [index, sampleTimeMs] of request.sampleTimesMs.entries()) {
      if (watchdog.aborted) {
        return { ok: false, failure: { kind: "cancelled" }, diagnostics: [...diagnostics, ...cdp.diagnostics] };
      }
      let actualTimeMs = 0;
      try {
        actualTimeMs = await waitForSampleTime(cdp, page.sessionId, originMs, sampleTimeMs, watchdog);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (watchdog.aborted || request.signal.aborted) {
          return { ok: false, failure: { kind: "cancelled" }, diagnostics: [...diagnostics, ...cdp.diagnostics] };
        }
        return {
          ok: false,
          failure: { kind: "timeout", message },
          diagnostics: [...diagnostics, ...cdp.diagnostics],
        };
      }
      const pngPath = join(request.outputRoot, `frame-${String(index).padStart(3, "0")}.png`);
      const data = await capturePngBase64(cdp, page.sessionId);
      const bytes = Buffer.from(data, "base64");
      if (bytes.byteLength <= 0) {
        return {
          ok: false,
          failure: { kind: "capture_failed", message: "empty png frame" },
          diagnostics: [...diagnostics, ...cdp.diagnostics],
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

    return {
      ok: true,
      frames,
      diagnostics: [...diagnostics, ...cdp.diagnostics],
      measured: { loadMs, viewport: request.viewport, origin: server.origin },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.signal.aborted || /cancelled/i.test(message)) {
      return { ok: false, failure: { kind: "cancelled" }, diagnostics };
    }
    return { ok: false, failure: { kind: "capture_failed", message }, diagnostics };
  } finally {
    if (cdp && !("failure" in cdp)) {
      await cdp.close();
    }
    if (server) {
      await server.close().catch((error: unknown) => {
        diagnostics.push({
          code: "server_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
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
