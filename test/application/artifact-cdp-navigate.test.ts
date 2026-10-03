import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navigateAndWait, disposeBrowserProcess, configurePageSession } from "../../src/infrastructure/artifact-cdp.js";
import { renderFailureResult } from "../../src/infrastructure/artifact-renderer.js";
import type { CdpSession } from "../../src/infrastructure/artifact-cdp.js";
import type { RenderDiagnostic } from "../../src/infrastructure/artifact-render-types.js";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";

function timeoutReason(): Error {
  const reason = new Error("The operation was aborted due to timeout");
  reason.name = "TimeoutError";
  return reason;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutReason()), ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function fakeSession(send: (method: string) => Promise<unknown>, on?: CdpSession["on"]): CdpSession {
  return {
    diagnostics: [],
    send: send as CdpSession["send"],
    on: on ?? (() => () => {}),
    async close() {},
  };
}

test("load timer starts after Page.navigate and does not reject unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let navigateSettled = false;
  const session = fakeSession(async (method) => {
    assert.equal(method, "Page.navigate");
    await new Promise((resolve) => setTimeout(resolve, 80));
    navigateSettled = true;
    return {};
  });
  const started = Date.now();
  try {
    await assert.rejects(
      navigateAndWait(session, "page", "http://127.0.0.1/index.html", 30, new AbortController().signal),
      /page load timed out/,
    );
    assert.equal(navigateSettled, true);
    assert.ok(Date.now() - started >= 80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("loadEventFired during Page.navigate still counts", async () => {
  let fire: (() => void) | undefined;
  const session = fakeSession(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {};
    },
    (method, handler) => {
      if (method === "Page.loadEventFired") {
        fire = () => handler({});
        setTimeout(() => fire?.(), 10);
      }
      return () => {
        fire = undefined;
      };
    },
  );
  const loadMs = await navigateAndWait(session, "page", "http://127.0.0.1/index.html", 500, new AbortController().signal);
  assert.ok(loadMs >= 40);
  assert.ok(loadMs < 400);
});

test("session timeout aborts an in-flight navigate into a timeout RenderResult", { timeout: 2_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const request = new AbortController().signal;
  const watchdog = timeoutSignal(40);
  const session = fakeSession(() => new Promise((_resolve, reject) => {
    if (watchdog.aborted) {
      reject(new Error("CDP session timed out"));
      return;
    }
    watchdog.addEventListener("abort", () => reject(new Error("CDP session timed out")), { once: true });
  }));
  let caught: unknown;
  try {
    await navigateAndWait(session, "page", "http://127.0.0.1/index.html", 30_000, watchdog);
    caught = undefined;
  } catch (error) {
    caught = error;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /timed out/);
  const result = renderFailureResult(caught, { request, watchdog }, []);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.kind, "timeout");
    if (result.failure.kind === "timeout") assert.match(result.failure.message, /timed out/);
  }
  assert.deepEqual(unhandled, []);
});

test("already-aborted signal awaits the Page.navigate rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const signal = AbortSignal.abort(timeoutReason());
  const session = fakeSession((method) => {
    assert.equal(method, "Page.navigate");
    return Promise.reject(new Error("CDP session timed out"));
  });
  try {
    await assert.rejects(
      navigateAndWait(session, "page", "http://127.0.0.1/index.html", 30_000, signal),
      /CDP session timed out/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("session timeout is not reported as a caller cancel", () => {
  const request = new AbortController().signal;
  const watchdog = AbortSignal.abort(timeoutReason());
  const closed = renderFailureResult(new Error("CDP session closed"), { request, watchdog }, []);
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.failure.kind, "timeout");
  const caller = new AbortController();
  caller.abort();
  const cancelled = renderFailureResult(new Error("CDP session closed"), { request: caller.signal, watchdog }, []);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.failure.kind, "cancelled");
});

test("session abort kills the browser child and releases writer.lock", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-session-lock-"));
  const profile = await mkdtemp(join(tmpdir(), "reprise-render-profile-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  const store = await ExperimentStore.open(root, "experiment-1");
  const diagnostics: RenderDiagnostic[] = [];
  await store.acquireWriter();
  const watchdog = timeoutSignal(30);
  let caught: unknown;
  try {
    try {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          void disposeBrowserProcess(child, profile, diagnostics).then(
            () => reject(new Error("page load timed out")),
            (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
          );
        };
        if (watchdog.aborted) onAbort();
        else watchdog.addEventListener("abort", onAbort, { once: true });
      });
      caught = new Error("session timeout should reject");
    } catch (error) {
      caught = error;
    }
    assert.match(caught instanceof Error ? caught.message : String(caught), /timed out/);
    await store.close();
    await assert.rejects(access(join(root, "writer.lock")));
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(diagnostics.some((item) => item.code === "browser_kill_failed"), false);
  } finally {
    await store.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});

test("configuration handles synchronous target events and resumes only the paused primary", async () => {
  const listeners = new Map<string, (params: Record<string, unknown>, sessionId?: string) => void>();
  const closed: string[] = [];
  const resumed: string[] = [];
  const continued: string[] = [];
  let primaryPaused = false;
  let networkGateInstalled = false;
  const emitAttached = (targetId: string, type: string, waitingForDebugger: boolean) => {
    listeners.get("Target.attachedToTarget")?.({
      targetInfo: { targetId, type }, sessionId: `${targetId}-auto`, waitingForDebugger,
    });
  };
  const session: CdpSession = {
    diagnostics: [],
    on(method, handler) {
      listeners.set(method, handler);
      return () => { listeners.delete(method); };
    },
    async close() {},
    async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      if (method === "Fetch.enable") {
        listeners.get("Fetch.requestPaused")?.({
          requestId: "initial-request", request: { url: "http://127.0.0.1:1234/preview.html" },
        }, "primary-page");
      }
      if (method === "Fetch.continueRequest") continued.push(String(params.requestId));
      if (method === "Page.addScriptToEvaluateOnNewDocument") networkGateInstalled = true;
      if (method === "Target.setDiscoverTargets") {
        listeners.get("Target.targetCreated")?.({ targetInfo: { targetId: "existing", type: "page" } });
      }
      if (method === "Target.setAutoAttach") {
        primaryPaused = true;
        emitAttached("primary", "page", true);
        emitAttached("popup", "page", true);
        emitAttached("worker", "worker", true);
      }
      if (method === "Target.closeTarget") closed.push(String(params.targetId));
      if (method === "Runtime.runIfWaitingForDebugger") {
        assert.equal(networkGateInstalled, true, "network gate must be installed before resuming the primary");
        resumed.push(sessionId ?? "");
        if (sessionId === "primary-auto") primaryPaused = false;
      }
      if (method === "Page.navigate") {
        if (primaryPaused) throw new Error("primary remains paused: navigation cannot load");
        listeners.get("Page.loadEventFired")?.({}, "primary-page");
      }
      return {} as T;
    },
  };
  await configurePageSession(session, "primary-page", { width: 320, height: 240, scale: 1 }, "http://127.0.0.1:1234", "primary");
  await navigateAndWait(session, "primary-page", "http://127.0.0.1:1234/preview.html", 100, new AbortController().signal);
  assert.deepEqual(continued, ["initial-request"]);
  assert.deepEqual(closed, ["existing", "popup", "worker"]);
  assert.deepEqual(resumed, ["primary-auto"]);
  emitAttached("primary", "page", false);
  emitAttached("late-popup", "page", true);
  assert.deepEqual(resumed, ["primary-auto"]);
  assert.deepEqual(closed, ["existing", "popup", "worker", "late-popup"]);
});
