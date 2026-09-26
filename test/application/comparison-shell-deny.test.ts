import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  COMPARISON_BROWSER_SHELL_DENIED,
  isComparisonBrowserShellCommand,
  withComparisonShellDeny,
} from "../../src/application/comparison-shell-deny.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { instrumentTools } from "../../src/infrastructure/agent/tools.js";
import { toolResultBody } from "../../src/infrastructure/agent/model-input.js";
import type { AgentToolDefinition } from "../../src/infrastructure/agent/host.js";
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

const BROWSER_PROBE =
  "& 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --version";

test("isComparisonBrowserShellCommand matches browser exe, probe flags, and user profiles", () => {
  assert.equal(isComparisonBrowserShellCommand(BROWSER_PROBE), true);
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
  const edge = await shell.execute({ command: BROWSER_PROBE }, new AbortController().signal);
  assert.equal(edge.content, COMPARISON_BROWSER_SHELL_DENIED);
  assert.match(edge.content, /render_artifact|preview_report/);
  const chrome = await shell.execute(
    { command: "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --dump-dom file:///tmp/x.html" },
    new AbortController().signal,
  );
  assert.equal(chrome.content, COMPARISON_BROWSER_SHELL_DENIED);
});

test("Host instrumentTools keeps deny guidance in model-visible tool result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = comparisonShell(root);
  const [instrumented] = instrumentTools([shell], "session-cmp-shell", "comparison", {
    requestIndex: 0,
    invocationId: "inv-1",
  });
  assert.ok(instrumented);
  const visible = await instrumented.execute({ command: BROWSER_PROBE }, new AbortController().signal);
  assert.equal(visible.content, COMPARISON_BROWSER_SHELL_DENIED);
  const body = toolResultBody(visible);
  assert.equal(body.encoding, "inline");
  assert.equal(body.text, COMPARISON_BROWSER_SHELL_DENIED);
  assert.doesNotMatch(visible.content, /agent tool execution failed/i);
});

test("reverse: throw-through deny is swallowed by AgentToolFailure before the model", async () => {
  const { Type } = await import("@sinclair/typebox");
  const fixture: AgentToolDefinition = {
    name: "shell_exec",
    description: "throw-style deny fixture",
    parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
    async execute() {
      throw new Error(COMPARISON_BROWSER_SHELL_DENIED);
    },
  };
  const [instrumented] = instrumentTools([fixture], "session-throw", "comparison", { requestIndex: 0 });
  assert.ok(instrumented);
  await assert.rejects(
    instrumented.execute({ command: BROWSER_PROBE }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /comparison agent tool execution failed/i);
      assert.doesNotMatch(error.message, /render_artifact|preview_report/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, COMPARISON_BROWSER_SHELL_DENIED);
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

test("Comparison shell_exec timeout terminates the shell and releases its workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  const shell = comparisonShell(root, { shellTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(
    shell.execute(
      { command: hostShellSleep(30) },
      new AbortController().signal,
    ),
    /timed out/i,
  );
  assert.ok(Date.now() - started < 15_000, "timeout must not wait for the full child sleep");
});

test("Comparison shell_exec cancels a started nested process", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows process-tree behavior");
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-tree-"));
  const marker = join(root, "child.pid");
  let childPid = 0;
  let childExited = false;
  t.after(async () => {
    if (childPid && !childExited) {
      try { process.kill(childPid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  const controller = new AbortController();
  const shell = comparisonShell(root, { shellTimeoutMs: 60_000 });
  const pending = shell.execute({
    command: hostNodeCommand("require('node:fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 30_000)"),
  }, controller.signal);
  void pending.catch(() => undefined);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const pid = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (pid) {
        childPid = Number(pid);
        break;
      }
      await delay(50);
    }
    assert.ok(childPid > 0, "nested process did not start");
  } finally {
    controller.abort();
  }
  await assert.rejects(pending, /cancel|abort/i);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        childExited = true;
        return;
      }
      throw error;
    }
    await delay(50);
  }
  assert.fail("nested process remained alive after cancellation");
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
