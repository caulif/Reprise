import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBrowserStartFailure,
  describeDevtoolsStartTimeout,
  parseDevtoolsEndpoint,
  waitForDevtoolsEndpoint,
} from "../../src/infrastructure/artifact-cdp.js";

function aliveChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
}

test("devtools endpoint parser accepts the Chrome port file shape", () => {
  assert.equal(parseDevtoolsEndpoint("9222\n/devtools/browser/abc\n"), "ws://127.0.0.1:9222/devtools/browser/abc");
  assert.equal(parseDevtoolsEndpoint("9222\r\n/devtools/browser\r\n"), "ws://127.0.0.1:9222/devtools/browser");
  assert.equal(parseDevtoolsEndpoint("nope\n/devtools/browser\n"), undefined);
  assert.equal(parseDevtoolsEndpoint("9222\nnot-a-path\n"), undefined);
});

test("a devtools start timeout stays kind timeout when the process is still alive", () => {
  const message = describeDevtoolsStartTimeout({
    process: "still alive",
    profile: "present",
    portFile: "absent",
    stderr: "empty",
  });
  assert.match(message, /timed out waiting for DevToolsActivePort/);
  assert.match(message, /process still alive/);
  assert.match(message, /port file absent/);
  assert.equal(classifyBrowserStartFailure(new AbortController().signal, new Error(message)).failure, "timeout");
  assert.equal(
    classifyBrowserStartFailure(new AbortController().signal, new Error("browser spawn failed: ENOENT spawn ENOENT")).failure,
    "capability_unavailable",
  );
});

test("a live process with no port file reports alive, not a dead browser", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-alive-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const stderrPath = join(profile, "reprise-browser-stderr.log");
  await writeFile(stderrPath, "DevTools listening was not printed\n");
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  const error = await waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 180, undefined, stderrPath).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /timed out waiting for DevToolsActivePort/);
  assert.match(error.message, /process still alive/);
  assert.match(error.message, /profile present/);
  assert.match(error.message, /port file absent/);
  assert.match(error.message, /stderr: DevTools listening was not printed/);
  assert.equal(classifyBrowserStartFailure(new AbortController().signal, error).failure, "timeout");
});

test("a missing profile directory is not reported as a still-running port wait without that fact", async (t) => {
  const profile = join(tmpdir(), `reprise-devtools-missing-${process.pid}-${Date.now()}`);
  t.after(() => rm(profile, { recursive: true, force: true }));
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 180),
    /timed out waiting for DevToolsActivePort: process still alive; profile missing; port file absent; stderr: not opened/,
  );
});

test("an unreadable-shape port file is not treated as not-yet-written", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-invalid-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, "DevToolsActivePort"), "nope\n");
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 180),
    /port file invalid \(port=bad, path=bad, lines=1\)/,
  );
});

test("a ready port file resolves without launching a browser", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-ready-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, "DevToolsActivePort"), "9333\n/devtools/browser/ready\n");
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  const endpoint = await waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 1_000);
  assert.equal(endpoint, "ws://127.0.0.1:9333/devtools/browser/ready");
});

test("an early process exit is not a 15s DevToolsActivePort timeout", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-exit-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", "process.exit(4)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const started = Date.now();
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 15_000),
    /browser exited early with code 4 signal none/,
  );
  assert.ok(Date.now() - started < 2_000);
});

test("a spawn error is surfaced and does not crash as an unhandled error", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-spawn-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const child = spawn("/no/such/reprise-browser", [], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const crashes: unknown[] = [];
  const onError = (error: unknown) => crashes.push(error);
  process.on("uncaughtException", onError);
  t.after(() => process.off("uncaughtException", onError));
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 2_000),
    /browser spawn failed: ENOENT/,
  );
  assert.equal(crashes.length, 0);
});
