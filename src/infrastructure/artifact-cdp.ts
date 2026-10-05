import { closeSync, openSync } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { spawnRuntimeProcess } from "./process/spawn.js";
import { terminateProcessTree } from "./platform.js";
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

export async function openCdpBrowserSession(signal: AbortSignal): Promise<CdpSession | { failure: "no_browser" | "capability_unavailable" | "timeout"; message: string; diagnostics: RenderDiagnostic[] }> {
  const diagnostics: RenderDiagnostic[] = [];
  const browserPath = await resolveHeadlessBrowser();
  if (!browserPath) return { failure: "no_browser", message: "no headless browser", diagnostics };
  if (signal.aborted) {
    return { ...classifyBrowserStartFailure(signal), diagnostics };
  }

  const profileDir = await mkdtemp(join(tmpdir(), "reprise-render-profile-"));
  const stderrLog = openBrowserStderr(profileDir);
  let child: ChildProcess;
  try {
    child = spawnPreviewBrowser(browserPath, profileDir, stderrLog.fd);
  } finally {
    // The child keeps its own dup. Closing the parent fd cannot fill an unread pipe.
    if (stderrLog.fd !== undefined) closeSync(stderrLog.fd);
  }
  // An unhandled ChildProcess "error" (spawn ENOENT) is thrown by Node and never reaches this wait.
  const watch = watchBrowserProcess(child);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= disposeBrowserProcess(child, profileDir, diagnostics);

  const abort = () => {
    void cleanup();
  };
  if (signal.aborted) {
    await cleanup();
    return { ...classifyBrowserStartFailure(signal), diagnostics };
  }
  signal.addEventListener("abort", abort, { once: true });

  try {
    const endpoint = await waitForDevtoolsEndpoint(profileDir, child, signal, 15_000, watch, stderrLog.path);
    const session = await connectCdp(endpoint, cleanup, diagnostics, signal);
    signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", () => {
      void session.close();
    }, { once: true });
    return session;
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await cleanup();
    return { ...classifyBrowserStartFailure(signal, error), diagnostics };
  }
}

/** A session or DevTools timeout is not a missing browser capability. */
export function classifyBrowserStartFailure(signal: AbortSignal, error?: unknown): { failure: "timeout" | "capability_unavailable"; message: string } {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason: unknown = signal.aborted ? signal.reason : undefined;
  const reasonText = reason instanceof Error ? reason.message : "";
  const timedOut = (reason instanceof Error && reason.name === "TimeoutError") || /timed out/i.test(message) || /timed out/i.test(reasonText);
  if (timedOut) return { failure: "timeout", message: message || reasonText || "page load timed out" };
  return { failure: "capability_unavailable", message: message || "cancelled before browser start" };
}

const BROWSER_STDERR_LOG = "reprise-browser-stderr.log";

type BrowserProcessWatch = {
  spawnError?: NodeJS.ErrnoException;
  exited: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function watchBrowserProcess(child: ChildProcess): BrowserProcessWatch {
  const watch: BrowserProcessWatch = { exited: false, exitCode: null, signalCode: null };
  child.on("error", (error: NodeJS.ErrnoException) => {
    watch.spawnError = error;
  });
  child.on("exit", (code, signal) => {
    watch.exited = true;
    watch.exitCode = code;
    watch.signalCode = signal;
  });
  return watch;
}

function openBrowserStderr(profileDir: string): { fd?: number; path?: string } {
  const path = join(profileDir, BROWSER_STDERR_LOG);
  try {
    return { fd: openSync(path, "a"), path };
  } catch {
    return {};
  }
}

function spawnPreviewBrowser(browserPath: string, profileDir: string, stderrFd: number | undefined): ChildProcess {
  return spawnRuntimeProcess(browserPath, [
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
    stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    detached: process.platform !== "win32",
  });
}

export function describeDevtoolsStartTimeout(input: {
  process: string;
  profile: "present" | "missing";
  portFile: string;
  stderr: string;
}): string {
  return `timed out waiting for DevToolsActivePort: process ${input.process}; profile ${input.profile}; port file ${input.portFile}; stderr: ${input.stderr}`;
}

/** Spawn failures emit "error" and may leave exitCode negative without an "exit" event. */
function browserLaunchFailure(child: ChildProcess, watch: BrowserProcessWatch): Error | undefined {
  const spawnCode = typeof child.exitCode === "number" && child.exitCode < 0 && !watch.exited;
  if (watch.spawnError || spawnCode) {
    const code = watch.spawnError?.code ?? String(child.exitCode);
    const detail = watch.spawnError?.message ?? "spawn failed";
    return new Error(`browser spawn failed: ${code} ${detail}`);
  }
  const code = child.exitCode ?? watch.exitCode;
  const signal = child.signalCode ?? watch.signalCode;
  if (watch.exited || code !== null || signal !== null) {
    return new Error(`browser exited early with code ${code ?? "null"} signal ${signal ?? "none"}`);
  }
  return undefined;
}

function browserProcessPhrase(child: ChildProcess, watch: BrowserProcessWatch): string {
  const failure = browserLaunchFailure(child, watch);
  if (!failure) return "still alive";
  return failure.message.startsWith("browser spawn failed")
    ? `spawn failed (${watch.spawnError?.code ?? child.exitCode ?? "unknown"})`
    : failure.message.replace(/^browser /, "");
}

export function parseDevtoolsEndpoint(raw: string): string | undefined {
  const [portLine, pathLine] = raw.split(/\r?\n/);
  const port = Number(portLine?.trim());
  const path = (pathLine ?? "").trim();
  if (Number.isInteger(port) && port > 0 && port <= 65535 && path.startsWith("/")) {
    return `ws://127.0.0.1:${port}${path}`;
  }
  return undefined;
}

const STDERR_LISTENING_SCAN_BYTES = 64 * 1024;

/** Chrome prints this on stderr. Only loopback hosts are an endpoint; any other host is ignored. */
export function parseLoopbackDevtoolsListeningUrl(text: string): string | undefined {
  const pattern = /(?:^|\n)[^\n]*?DevTools listening on (ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/devtools\/browser\/([A-Za-z0-9-]+))(?=$|[\s"'<])/g;
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const url = match[1];
    const port = Number(match[2]);
    if (!url || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    found = url;
  }
  return found;
}

async function loopbackDevtoolsUrlFromStderr(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(STDERR_LISTENING_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return parseLoopbackDevtoolsListeningUrl(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function portFileRejectReason(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const port = Number(lines[0]);
  const path = lines[1] ?? "";
  const portOk = Number.isInteger(port) && port > 0 && port <= 65535;
  return `invalid (port=${portOk ? "ok" : "bad"}, path=${path.startsWith("/") ? "ok" : "bad"}, lines=${lines.length})`;
}

async function readDevtoolsEndpoint(portFile: string): Promise<{ endpoint?: string; state: string }> {
  try {
    const raw = await readFile(portFile, "utf8");
    const endpoint = parseDevtoolsEndpoint(raw);
    return endpoint ? { endpoint, state: "ready" } : { state: portFileRejectReason(raw) };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "ENOENT") return { state: "absent" };
    return { state: `unreadable (${code || "error"})` };
  }
}

async function profilePresence(profileDir: string): Promise<"present" | "missing"> {
  try {
    const info = await stat(profileDir);
    return info.isDirectory() ? "present" : "missing";
  } catch {
    return "missing";
  }
}

async function stderrExcerpt(path: string | undefined): Promise<string> {
  if (!path) return "not opened";
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buf, 0, 512, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 180) : "empty";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: string }).code) : "error";
    return `unreadable ${code}`;
  } finally {
    await handle?.close();
  }
}

export async function waitForDevtoolsEndpoint(
  profileDir: string,
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number,
  watch: BrowserProcessWatch = watchBrowserProcess(child),
  stderrPath?: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const portFile = join(profileDir, "DevToolsActivePort");
  let portFileState = "absent";
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("cancelled while waiting for DevTools");
    const launchFailure = browserLaunchFailure(child, watch);
    if (launchFailure) throw launchFailure;
    const read = await readDevtoolsEndpoint(portFile);
    portFileState = read.state;
    if (read.endpoint) return read.endpoint;
    // Win11 can print the listening URL and never create DevToolsActivePort. Do not sit out the rest of the wait.
    if (read.state === "absent") {
      const fromStderr = await loopbackDevtoolsUrlFromStderr(stderrPath);
      if (fromStderr) return fromStderr;
    }
    await sleep(50);
  }
  throw new Error(describeDevtoolsStartTimeout({
    process: browserProcessPhrase(child, watch),
    profile: await profilePresence(profileDir),
    portFile: portFileState,
    stderr: await stderrExcerpt(stderrPath),
  }));
}

async function connectCdp(
  endpoint: string,
  cleanup: () => Promise<void>,
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
      if (signal.aborted) throw errorForSignal(signal, "CDP session timed out");
      if (ws.readyState !== WebSocket.OPEN) throw new Error("CDP socket closed");
      const id = nextId++;
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const result = new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(errorForSignal(signal, "CDP session timed out"));
        };
        if (signal.aborted) {
          reject(errorForSignal(signal, "CDP session timed out"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value as T);
          },
          reject: (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
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
      await cleanup();
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
  primaryTargetId: string,
): Promise<{
  consoleErrors: string[];
  blockedRequests: string[];
  resourceFailures: string[];
}> {
  const consoleErrors: string[] = [];
  const blockedRequests: string[] = [];
  const resourceFailures: string[] = [];

  // Discovery and auto-attach can emit events before their command replies.
  bindPageDiagnostics(session, pageSessionId, {
    consoleErrors,
    blockedRequests,
    resourceFailures,
    allowedOrigin,
    primaryTargetId,
  });

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
    await session.send("Target.setDiscoverTargets", { discover: true });
  } catch {
    // Discovery may already be on; worker target close still best-effort via targetCreated when emitted.
    session.diagnostics.push({
      code: "target_discovery_unavailable",
      message: "Target.setDiscoverTargets unavailable",
    });
  }
  try {
    // Pause secondary targets before their first navigation so close cannot race an off-bundle request.
    await session.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  } catch {
    session.diagnostics.push({
      code: "target_auto_attach_unavailable",
      message: "Target.setAutoAttach unavailable; page-world window.open / target=_blank gate still applies",
    });
  }
  try {
    await session.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: false });
  } catch {
    // Browser domain may be unavailable on some headless builds; Fetch still denies downloads of navigations.
    session.diagnostics.push({
      code: "download_guard_unavailable",
      message: "Browser.setDownloadBehavior unavailable; downloads still blocked at Fetch layer when possible",
    });
  }

  return { consoleErrors, blockedRequests, resourceFailures };
}

async function installPageNetworkGate(
  session: CdpSession,
  pageSessionId: string,
  allowedOrigin: string,
): Promise<void> {
  // Fetch covers page HTTP(S); WS/ES/beacon need a page-world gate; Worker/SW/WebRTC bypass Fetch, so deny them.
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: pageNetworkGateSource(allowedOrigin),
  }, pageSessionId);
}

function pageNetworkGateSource(allowedOrigin: string): string {
  return `(() => {
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
    const denyCtor = (name, kind) => {
      const Orig = globalThis[name];
      if (typeof Orig !== "function") return;
      const Wrapped = function () { block(kind, name); };
      Wrapped.prototype = Orig.prototype;
      try { globalThis[name] = Wrapped; } catch (e) {}
    };
    denyCtor("Worker", "worker");
    denyCtor("SharedWorker", "sharedworker");
    // WebRTC ICE/STUN/TURN uses UDP outside Fetch; deny constructors rather than allowlisting.
    denyCtor("RTCPeerConnection", "webrtc");
    denyCtor("webkitRTCPeerConnection", "webrtc");
    // WebTransport QUIC/UDP also bypasses Fetch; deny like WebRTC.
    denyCtor("WebTransport", "webtransport");
    ${pagePopupAndServiceWorkerDenySource()}
  })();`;
}

function pagePopupAndServiceWorkerDenySource(): string {
  return `
    window.open = function (url) {
      try { console.error("[reprise-network-gate]", "window.open", String(url ?? "")); } catch {}
      return null;
    };
    const blockBlankTarget = (event) => {
      const el = event.target;
      const node = el && el.closest ? el : null;
      const hit = node && node.closest("a[target], area[target], form[target]");
      if (!hit) return;
      const t = String(hit.getAttribute("target") || "").trim().toLowerCase();
      if (!t || t === "_self" || t === "_parent" || t === "_top") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const dest = hit.href || hit.action || t;
      try { console.error("[reprise-network-gate]", "target_blank", String(dest)); } catch {}
    };
    document.addEventListener("click", blockBlankTarget, true);
    document.addEventListener("auxclick", blockBlankTarget, true);
    document.addEventListener("submit", blockBlankTarget, true);
    if (navigator.serviceWorker) {
      const swStub = {
        controller: null,
        ready: new Promise(() => {}),
        register(url) { block("serviceworker", url); },
        getRegistration() { return Promise.resolve(undefined); },
        getRegistrations() { return Promise.resolve([]); },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
        startMessages() {},
      };
      try {
        Object.defineProperty(navigator, "serviceWorker", {
          configurable: true, enumerable: true, get() { return swStub; },
        });
      } catch (e) {
        try { navigator.serviceWorker.register = function (url) { block("serviceworker", url); }; } catch {}
      }
    }
  `;
}

function bindPageDiagnostics(
  session: CdpSession,
  pageSessionId: string,
  state: {
    consoleErrors: string[];
    blockedRequests: string[];
    resourceFailures: string[];
    allowedOrigin: string;
    primaryTargetId: string;
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
  session.on("Target.attachedToTarget", (params) => {
    handleAttachedTarget(session, state, params);
  });
  session.on("Target.targetCreated", (params) => {
    const targetInfo = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
    if (!targetInfo?.targetId || targetInfo.targetId === state.primaryTargetId) return;
    const type = targetInfo.type ?? "";
    const secondary = type === "page" || type === "other";
    const workerish = type === "worker" || type === "service_worker" || type === "shared_worker";
    if (!secondary && !workerish) return;
    // Backup close if auto-attach pause was unavailable; abort may already have torn down the browser.
    void session.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
    session.diagnostics.push({
      code: workerish ? "worker_target_blocked" : "popup_blocked",
      message: workerish ? "closed worker-class target" : "closed secondary target",
      ...(targetInfo.url ? { detail: targetInfo.url } : {}),
    });
  });
}

function handleAttachedTarget(
  session: CdpSession,
  state: { primaryTargetId: string },
  params: Record<string, unknown>,
): void {
  const targetInfo = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
  if (!targetInfo?.targetId) return;
  if (targetInfo.targetId === state.primaryTargetId) {
    if (params.waitingForDebugger === true && typeof params.sessionId === "string") {
      // Auto-attach has its own session; resume the primary without releasing secondary targets.
      void session.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {
        session.diagnostics.push({ code: "primary_resume_failed", message: "could not resume primary page target" });
      });
    }
    return;
  }
  const type = targetInfo.type ?? "";
  const secondary = type === "page" || type === "other";
  const workerish = type === "worker" || type === "service_worker" || type === "shared_worker";
  if (!secondary && !workerish) return;
  // Do not Runtime.runIfWaitingForDebugger — closing while paused prevents the first off-bundle navigation.
  void session.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
  session.diagnostics.push({
    code: workerish ? "worker_target_blocked" : "popup_blocked",
    message: workerish ? "closed worker-class target before resume" : "closed secondary target before resume",
    ...(targetInfo.url ? { detail: targetInfo.url } : {}),
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
  // Subscribe before navigation so a fast load is not missed, but do not arm the
  // timer until Page.navigate resolves. Arming it first rejects while navigate is
  // still in flight, and that rejection is unhandled until the send settles.
  const wait = createLoadWait(session, signal);
  try {
    await session.send("Page.navigate", { url }, pageSessionId);
    wait.armTimeout(timeoutMs);
    await wait.quiet;
    const error = wait.takeError();
    if (error) throw error;
    return Date.now() - started;
  } finally {
    wait.abandon();
  }
}

type LoadWait = {
  readonly quiet: Promise<void>;
  takeError(): Error | undefined;
  armTimeout(timeoutMs: number): void;
  abandon(): void;
};

function createLoadWait(session: CdpSession, signal: AbortSignal): LoadWait {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off = (): void => {};
  let finished = false;
  let captured: Error | undefined;
  let resolveWait: () => void = () => {};
  let rejectWait: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const quiet = done.then(
    () => undefined,
    (error: unknown) => {
      captured = error instanceof Error ? error : new Error(String(error));
    },
  );
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    off();
    signal.removeEventListener("abort", onAbort);
    if (error) rejectWait(error);
    else resolveWait();
  };
  const onAbort = (): void => {
    finish(errorForSignal(signal, "page load timed out"));
  };
  off = session.on("Page.loadEventFired", () => finish());
  if (signal.aborted) finish(errorForSignal(signal, "page load timed out"));
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    quiet,
    takeError: () => captured,
    armTimeout(timeoutMs: number): void {
      if (finished) return;
      timer = setTimeout(() => finish(new Error("page load timed out")), timeoutMs);
    },
    abandon(): void {
      finish();
    },
  };
}

function errorForSignal(signal: AbortSignal, timeoutMessage: string): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return new Error(timeoutMessage);
  return new Error("cancelled during navigation");
}


export async function capturePngBase64(session: CdpSession, pageSessionId: string): Promise<string> {
  const result = await session.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  }, pageSessionId);
  if (!result.data) throw new Error("empty screenshot payload");
  return result.data;
}

export async function evaluateJson<T>(session: CdpSession, pageSessionId: string, expression: string, contextId?: number): Promise<T> {
  const result = await session.send<{ result: { value?: T; subtype?: string; description?: string } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, ...(contextId === undefined ? {} : { contextId }) },
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

/** Kills the browser child with a bounded wait so sessionTimeout can release writer.lock. */
export async function disposeBrowserProcess(
  child: ChildProcess,
  profileDir: string,
  diagnostics: RenderDiagnostic[],
): Promise<void> {
  // Windows taskkill must be timed. An unbounded wait keeps compare's writer.lock held
  // long after AbortSignal.timeout has already fired.
  try {
    terminateProcessTree(child, true);
  } catch {
    diagnostics.push({ code: "browser_kill_failed", message: "process tree termination failed" });
  }
  const exited = await waitExit(child, 3_000);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      diagnostics.push({ code: "browser_kill_failed", message: "SIGKILL failed; process may linger" });
    }
    await waitExit(child, 1_000);
  }
  try {
    // Windows browser descendants can release profile handles after the parent exits.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error: unknown) {
    diagnostics.push({ code: "profile_cleanup_failed", message: error instanceof Error ? error.message : String(error) });
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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
