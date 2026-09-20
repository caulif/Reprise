import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPARISON_BROWSER_SHELL_DENIED,
  isComparisonBrowserShellCommand,
  withComparisonShellDeny,
} from "../../src/application/comparison-shell-deny.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { hostNodeCommand, hostShellSleep } from "../host-shell.js";

function comparisonShell(root: string, options: { shellTimeoutMs?: number } = {}) {
  const tools = withComparisonShellDeny(
    workspaceTools(root, {
      role: "comparison",
      allowShell: true,
      ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
    }),
  );
  const shell = tools.find((tool) => tool.name === "shell_exec");
  assert.ok(shell);
  return shell;
}

test("isComparisonBrowserShellCommand matches browser exe, probe flags, and user profiles", () => {
  assert.equal(
    isComparisonBrowserShellCommand(
      "& 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --version",
    ),
    true,
  );
  assert.equal(
    isComparisonBrowserShellCommand(
      "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --dump-dom",
    ),
    true,
  );
  assert.equal(isComparisonBrowserShellCommand("firefox.exe --screenshot"), true);
  assert.equal(isComparisonBrowserShellCommand("chromium --remote-debugging-port=9222"), true);
  assert.equal(
    isComparisonBrowserShellCommand("--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"),
    true,
  );
  assert.equal(isComparisonBrowserShellCommand("node -v"), false);
  assert.equal(isComparisonBrowserShellCommand("python -c \"print(1)\""), false);
  assert.equal(isComparisonBrowserShellCommand("npm test"), false);
});

test("Comparison shell_exec fast-rejects msedge --version and Chrome --dump-dom", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = comparisonShell(root);
  await assert.rejects(
    shell.execute(
      { command: "& 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --version" },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, COMPARISON_BROWSER_SHELL_DENIED);
      assert.match(error.message, /render_artifact|preview_report/);
      return true;
    },
  );
  await assert.rejects(
    shell.execute(
      { command: "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --dump-dom file:///tmp/x.html" },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, COMPARISON_BROWSER_SHELL_DENIED);
      return true;
    },
  );
});

test("Comparison shell_exec still runs ordinary Node/Python static checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "note.txt"), "ok\n");
  const shell = comparisonShell(root);
  const node = await shell.execute(
    { command: hostNodeCommand("process.stdout.write('node-ok')") },
    new AbortController().signal,
  );
  assert.match(node.content, /node-ok/);
  const py = await shell.execute(
    { command: process.platform === "win32" ? "python -c \"print('py-ok')\"" : "python3 -c \"print('py-ok')\"" },
    new AbortController().signal,
  );
  assert.match(py.content, /py-ok/);
});

test("Comparison shell_exec timeout still fails and does not leave an orphan long-runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = comparisonShell(root, { shellTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(
    shell.execute(
      { command: hostNodeCommand("setTimeout(() => undefined, 30_000)") },
      new AbortController().signal,
    ),
    /timed out/i,
  );
  assert.ok(Date.now() - started < 15_000, "timeout must not wait for the full child sleep");
});

test("Comparison shell_exec AbortSignal cancels a long command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = comparisonShell(root, { shellTimeoutMs: 60_000 });
  const controller = new AbortController();
  const pending = shell.execute({ command: hostShellSleep(30) }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /cancel|abort/i);
});
