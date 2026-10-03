import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navigateAndWait, disposeBrowserProcess } from "../../src/infrastructure/artifact-cdp.js";
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
  const session = fakeSession(() => new Promise(() => {}));
  const request = new AbortController().signal;
  const watchdog = timeoutSignal(40);
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
