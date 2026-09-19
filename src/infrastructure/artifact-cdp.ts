import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnRuntimeProcess } from "./process/spawn.js";
import { resolveHeadlessBrowser } from "./headless-screenshot.js";
import type { RenderDiagnostic, RenderViewport } from "./artifact-render-types.js";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
};

export type CdpSession = {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void;
  close(): Promise<void>;
  diagnostics: RenderDiagnostic[];
};

export async function openCdpBrowserSession(signal: AbortSignal): Promise<CdpSession | { failure: "no_browser" | "capability_unavailable"; message: string; diagnostics: RenderDiagnostic[] }> {
  const diagnostics: RenderDiagnostic[] = [];
  const browserPath = await resolveHeadlessBrowser();
  if (!browserPath) return { failure: "no_browser", message: "no headless browser", diagnostics };

  const profileDir = join(tmpdir(), `reprise-render-profile-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(profileDir, { recursive: true });
  const child = spawnRuntimeProcess(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-pings",
    "--disable-client-side-phishing-detection",
    "--disable-popup-blocking=false",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const abort = () => {
    void killBrowser(child, profileDir, diagnostics);
  };
  if (signal.aborted) {
    abort();
    return { failure: "capability_unavailable", message: "cancelled before browser start", diagnostics };
  }
  signal.addEventListener("abort", abort, { once: true });

  try {
    const endpoint = await waitForDevtoolsEndpoint(profileDir, child, signal, 15_000);
    const session = await connectCdp(endpoint, child, profileDir, diagnostics, signal);
    signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", () => {
      void session.close();
    }, { once: true });
    return session;
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await killBrowser(child, profileDir, diagnostics);
    const message = error instanceof Error ? error.message : String(error);
    return { failure: "capability_unavailable", message, diagnostics };
  }
}

async function waitForDevtoolsEndpoint(
  profileDir: string,
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const portFile = join(profileDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("cancelled while waiting for DevTools");
    if (child.exitCode !== null) throw new Error(`browser exited early with code ${child.exitCode}`);
    try {
      const raw = await readFile(portFile, "utf8");
      const [portLine, pathLine] = raw.split(/\r?\n/);
      const port = Number(portLine?.trim());
      const path = (pathLine ?? "").trim();
      if (Number.isInteger(port) && port > 0 && path.startsWith("/")) {
        return `ws://127.0.0.1:${port}${path}`;
      }
    } catch {
      // DevToolsActivePort appears after Chrome finishes binding the debug port.
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for DevToolsActivePort");
}

async function connectCdp(
  endpoint: string,
  child: ChildProcessWithoutNullStreams,
  profileDir: string,
  diagnostics: RenderDiagnostic[],
  signal: AbortSignal,
): Promise<CdpSession> {
  const ws = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled during CDP connect"));
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("CDP WebSocket connection failed"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    let message: CdpMessage & { sessionId?: string };
    try {
      message = JSON.parse(raw) as CdpMessage & { sessionId?: string };
    } catch {
      diagnostics.push({ code: "cdp_parse_error", message: "non-JSON CDP frame" });
      return;
    }
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? ""}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = listeners.get(message.method);
      if (!handlers) return;
      for (const handler of handlers) handler(message.params ?? {}, message.sessionId);
    }
  });

  const session: CdpSession = {
    diagnostics,
    async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("CDP socket closed");
      const id = nextId++;
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const result = new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
      ws.send(JSON.stringify(payload));
      return result;
    },
    on(method, handler) {
      const set = listeners.get(method) ?? new Set();
      set.add(handler);
      listeners.set(method, set);
      return () => set.delete(handler);
    },
    async close() {
      for (const waiter of pending.values()) waiter.reject(new Error("CDP session closed"));
      pending.clear();
      listeners.clear();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {
        // Closing an already-closed socket is expected during abort races.
      }
      await killBrowser(child, profileDir, diagnostics);
    },
  };
  return session;
}

export async function createPageTarget(session: CdpSession): Promise<{ targetId: string; sessionId: string }> {
  const created = await session.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const attached = await session.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  return { targetId: created.targetId, sessionId: attached.sessionId };
}

export async function configurePageSession(
  session: CdpSession,
  pageSessionId: string,
  viewport: RenderViewport,
  allowedOrigin: string,
): Promise<{
  consoleErrors: string[];
  blockedRequests: string[];
  resourceFailures: string[];
}> {
  const consoleErrors: string[] = [];
  const blockedRequests: string[] = [];
  const resourceFailures: string[] = [];

  await session.send("Page.enable", {}, pageSessionId);
  await session.send("Runtime.enable", {}, pageSessionId);
  await session.send("Network.enable", {}, pageSessionId);
  try {
    await session.send("Network.setBypassServiceWorker", { bypass: true }, pageSessionId);
  } catch {
    // Older Chromium builds omit Network.setBypassServiceWorker; Fetch + page gate still apply.
    session.diagnostics.push({
      code: "service_worker_bypass_unavailable",
      message: "Network.setBypassServiceWorker unavailable",
    });
  }
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  }, pageSessionId);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: false,
  }, pageSessionId);
  await installPageNetworkGate(session, pageSessionId, allowedOrigin);
  try {
    await session.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: false });
  } catch {
    // Browser domain may be unavailable on some headless builds; Fetch still denies downloads of navigations.
    session.diagnostics.push({
      code: "download_guard_unavailable",
      message: "Browser.setDownloadBehavior unavailable; downloads still blocked at Fetch layer when possible",
    });
  }

  bindPageDiagnostics(session, pageSessionId, {
    consoleErrors,
    blockedRequests,
    resourceFailures,
    allowedOrigin,
  });

  return { consoleErrors, blockedRequests, resourceFailures };
}

async function installPageNetworkGate(
  session: CdpSession,
  pageSessionId: string,
  allowedOrigin: string,
): Promise<void> {
  // Fetch covers HTTP(S); WebSocket/EventSource/beacon need a page-world gate installed before any document script.
  const source = `(() => {
    const allowed = ${JSON.stringify(allowedOrigin)};
    const allow = (raw) => {
      try {
        if (typeof raw !== "string") return false;
        if (raw.startsWith("data:") || raw.startsWith("blob:")) return true;
        const u = new URL(raw, location.href);
        if (u.protocol === "file:") return false;
        return u.origin === allowed;
      } catch {
        return false;
      }
    };
    const block = (kind, raw) => {
      try { console.error("[reprise-network-gate]", kind, String(raw)); } catch {}
      throw new Error("blocked non-bundle " + kind);
    };
    const OrigWS = globalThis.WebSocket;
    if (typeof OrigWS === "function") {
      const Wrapped = function (url, protocols) {
        if (!allow(String(url))) block("websocket", url);
        return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      };
      Wrapped.prototype = OrigWS.prototype;
      Object.defineProperty(Wrapped, "CONNECTING", { value: OrigWS.CONNECTING });
      Object.defineProperty(Wrapped, "OPEN", { value: OrigWS.OPEN });
      Object.defineProperty(Wrapped, "CLOSING", { value: OrigWS.CLOSING });
      Object.defineProperty(Wrapped, "CLOSED", { value: OrigWS.CLOSED });
      globalThis.WebSocket = Wrapped;
    }
    const OrigES = globalThis.EventSource;
    if (typeof OrigES === "function") {
      globalThis.EventSource = function (url, config) {
        if (!allow(String(url))) block("eventsource", url);
        return config === undefined ? new OrigES(url) : new OrigES(url, config);
      };
      globalThis.EventSource.prototype = OrigES.prototype;
    }
    if (navigator.sendBeacon) {
      const origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        if (!allow(String(url))) {
          try { console.error("[reprise-network-gate]", "beacon", String(url)); } catch {}
          return false;
        }
        return origBeacon(url, data);
      };
    }
    const wrapWorker = (Orig, kind) => {
      if (typeof Orig !== "function") return Orig;
      const Wrapped = function (url, options) {
        if (!allow(String(url))) block(kind, url);
        return options === undefined ? new Orig(url) : new Orig(url, options);
      };
      Wrapped.prototype = Orig.prototype;
      return Wrapped;
    };
    globalThis.Worker = wrapWorker(globalThis.Worker, "worker");
    globalThis.SharedWorker = wrapWorker(globalThis.SharedWorker, "sharedworker");
  })();`;
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source }, pageSessionId);
}

function bindPageDiagnostics(
  session: CdpSession,
  pageSessionId: string,
  state: {
    consoleErrors: string[];
    blockedRequests: string[];
    resourceFailures: string[];
    allowedOrigin: string;
  },
): void {
  session.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    const text = cdpUnknownText(details?.exception?.description ?? details?.text) || "page exception";
    state.consoleErrors.push(text);
  });
  session.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    const args = Array.isArray(params.args) ? params.args as { value?: unknown; description?: string }[] : [];
    const text = args.map((arg) => cdpUnknownText(arg.value ?? arg.description)).join(" ");
    if (text.includes("[reprise-network-gate]")) {
      const url = text.replace(/^.*\[reprise-network-gate\]\s+\S+\s+/, "").trim();
      if (url) state.blockedRequests.push(url);
    }
    if (text) state.consoleErrors.push(text);
  });
  session.on("Network.loadingFailed", (params) => {
    const url = cdpUnknownText(params.errorText) || "resource failed";
    const kind = cdpUnknownText(params.type) || "Resource";
    state.resourceFailures.push(`${kind}: ${url}`);
  });
  session.on("Network.webSocketCreated", (params) => {
    const url = cdpUnknownText(params.url);
    if (!url || isAllowedBundleUrl(url, state.allowedOrigin)) return;
    state.blockedRequests.push(url);
    session.diagnostics.push({
      code: "network_blocked",
      message: "websocket created outside bundle origin",
      detail: redactNetworkUrl(url),
    });
  });
  session.on("Fetch.requestPaused", (params, eventSessionId) => {
    void (async () => {
      const requestId = cdpUnknownText(params.requestId);
      const request = params.request as { url?: string } | undefined;
      const url = typeof request?.url === "string" ? request.url : "";
      const sid = eventSessionId ?? pageSessionId;
      if (!requestId) return;
      if (isAllowedBundleUrl(url, state.allowedOrigin)) {
        // Abort races often reject continue/fail; the page navigation is already cancelled.
        await session.send("Fetch.continueRequest", { requestId }, sid).catch(() => undefined);
        return;
      }
      state.blockedRequests.push(url);
      await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sid).catch(() => undefined);
    })();
  });
  session.on("Target.targetCreated", (params) => {
    const targetInfo = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
    if (!targetInfo?.targetId) return;
    if (targetInfo.type === "page" || targetInfo.type === "other") {
      // Secondary targets are closed best-effort; abort may already have torn down the browser.
      void session.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
      session.diagnostics.push({
        code: "popup_blocked",
        message: "closed secondary target",
        ...(targetInfo.url ? { detail: targetInfo.url } : {}),
      });
    }
  });
}

function redactNetworkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

export async function navigateAndWait(
  session: CdpSession,
  pageSessionId: string,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<number> {
  const started = Date.now();
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("page load timed out")), timeoutMs);
    const off = session.on("Page.loadEventFired", () => {
      clearTimeout(timer);
      off();
      resolve();
    });
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      off();
      reject(new Error("cancelled during navigation"));
    }, { once: true });
  });
  await session.send("Page.navigate", { url }, pageSessionId);
  await loaded;
  return Date.now() - started;
}

export async function capturePngBase64(session: CdpSession, pageSessionId: string): Promise<string> {
  const result = await session.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  }, pageSessionId);
  if (!result.data) throw new Error("empty screenshot payload");
  return result.data;
}

export async function evaluateJson<T>(session: CdpSession, pageSessionId: string, expression: string): Promise<T> {
  const result = await session.send<{ result: { value?: T; subtype?: string; description?: string } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    pageSessionId,
  );
  if (result.result.subtype === "error") {
    throw new Error(result.result.description ?? "Runtime.evaluate failed");
  }
  return result.result.value as T;
}

function isAllowedBundleUrl(url: string, allowedOrigin: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return false;
    return parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

function cdpUnknownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

async function killBrowser(
  child: ChildProcessWithoutNullStreams,
  profileDir: string,
  diagnostics: RenderDiagnostic[],
): Promise<void> {
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      diagnostics.push({ code: "browser_kill_failed", message: "SIGTERM failed" });
    }
    const exited = await waitExit(child, 3_000);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        diagnostics.push({ code: "browser_kill_failed", message: "SIGKILL failed; process may linger" });
      }
    }
  }
  await rm(profileDir, { recursive: true, force: true }).catch((error: unknown) => {
    diagnostics.push({
      code: "profile_cleanup_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function waitExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
