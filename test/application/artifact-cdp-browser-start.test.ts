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
  parseLoopbackDevtoolsListeningUrl,
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
  assert.match(describeDevtoolsStartTimeout({ process: "still alive", profile: "present", portFile: "absent", stderr: "empty", executable: "/opt/google/chrome/chrome" }), /; executable: \/opt\/google\/chrome\/chrome$/);
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

const listeningUrl = "ws://127.0.0.1:63008/devtools/browser/8ce6099e-1db6-4705-8e85-f44070382978";

test("a loopback DevTools listening line is an endpoint only for 127.0.0.1, localhost, and [::1]", () => {
  const id = "8ce6099e-1db6-4705-8e85-f44070382978";
  assert.equal(
    parseLoopbackDevtoolsListeningUrl(`DevTools listening on ws://127.0.0.1:63008/devtools/browser/${id}\n`),
    `ws://127.0.0.1:63008/devtools/browser/${id}`,
  );
  assert.equal(
    parseLoopbackDevtoolsListeningUrl(`DevTools listening on ws://localhost:63041/devtools/browser/${id}\r\n`),
    `ws://localhost:63041/devtools/browser/${id}`,
  );
  assert.equal(
    parseLoopbackDevtoolsListeningUrl(`DevTools listening on ws://[::1]:55420/devtools/browser/${id}`),
    `ws://[::1]:55420/devtools/browser/${id}`,
  );
  assert.equal(
    parseLoopbackDevtoolsListeningUrl(`noise\nDevTools listening on ws://192.0.2.10:63008/devtools/browser/${id}\n`),
    undefined,
  );
  assert.equal(parseLoopbackDevtoolsListeningUrl("DevTools listening was not printed\n"), undefined);
  assert.equal(parseLoopbackDevtoolsListeningUrl(""), undefined);
  assert.equal(
    parseLoopbackDevtoolsListeningUrl("DevTools listening on ws://127.0.0.1:65536/devtools/browser/abc\n"),
    undefined,
  );
  assert.equal(
    parseLoopbackDevtoolsListeningUrl("DevTools listening on ws://127.0.0.1:1/devtools/browser/abc/extra\n"),
    undefined,
  );
  assert.equal(
    parseLoopbackDevtoolsListeningUrl(
      "DevTools listening on ws://127.0.0.1:1/devtools/browser/first\nDevTools listening on ws://127.0.0.1:2/devtools/browser/second\n",
    ),
    "ws://127.0.0.1:2/devtools/browser/second",
  );
  assert.equal(parseLoopbackDevtoolsListeningUrl(`DevTools listening on ${listeningUrl}\n`), listeningUrl);
});

test("a missing port file still resolves from a loopback DevTools listening line before the wait expires", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-stderr-url-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const stderrPath = join(profile, "reprise-browser-stderr.log");
  await writeFile(stderrPath, `DevTools listening on ${listeningUrl}\n`);
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  const started = Date.now();
  const endpoint = await waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 15_000, undefined, stderrPath);
  assert.equal(endpoint, listeningUrl);
  assert.ok(Date.now() - started < 2_000);
});

test("a valid port file wins over a DevTools listening line in stderr", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-file-wins-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, "DevToolsActivePort"), "9333\n/devtools/browser/from-file\n");
  const stderrPath = join(profile, "reprise-browser-stderr.log");
  await writeFile(stderrPath, `DevTools listening on ${listeningUrl}\n`);
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  const started = Date.now();
  const endpoint = await waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 15_000, undefined, stderrPath);
  assert.equal(endpoint, "ws://127.0.0.1:9333/devtools/browser/from-file");
  assert.ok(Date.now() - started < 2_000);
});

test("a non-loopback DevTools listening line is not an endpoint", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-nonlocal-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const stderrPath = join(profile, "reprise-browser-stderr.log");
  await writeFile(stderrPath, "DevTools listening on ws://192.0.2.10:63008/devtools/browser/8ce6099e-1db6-4705-8e85-f44070382978\n");
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 180, undefined, stderrPath),
    /timed out waiting for DevToolsActivePort: process still alive; profile present; port file absent; stderr: DevTools listening on ws:\/\/192\.0\.2\.10:63008\/devtools\/browser\/8ce6099e-1db6-4705-8e85-f44070382978/,
  );
});

test("an empty stderr file with no port file still times out as a missing DevToolsActivePort", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "reprise-devtools-empty-stderr-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const stderrPath = join(profile, "reprise-browser-stderr.log");
  await writeFile(stderrPath, "");
  const child = aliveChild();
  t.after(() => child.kill("SIGKILL"));
  await assert.rejects(
    () => waitForDevtoolsEndpoint(profile, child, new AbortController().signal, 180, undefined, stderrPath, "/opt/google/chrome/chrome"),
    /timed out waiting for DevToolsActivePort: process still alive; profile present; port file absent; stderr: empty; executable: \/opt\/google\/chrome\/chrome/,
  );
});
