import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPARISON_BROWSER_SHELL_DENIED,
  isComparisonBrowserShellCommand,
  withComparisonShellDeny,
} from "../../src/application/comparison-shell-deny.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { instrumentTools } from "../../src/infrastructure/agent/tools.js";
import { toolResultBody } from "../../src/infrastructure/agent/model-input.js";
import type { AgentToolDefinition } from "../../src/infrastructure/agent/host.js";
import { hostNodeCommand } from "../host-shell.js";

function comparisonShell(root: string) {
  const tools = withComparisonShellDeny(
    workspaceTools(root, {
      role: "comparison",
      allowShell: true, managedExecution: true,
    }),
  );
  const shell = tools.find((tool) => tool.name === "exec_command");
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

test("Comparison exec_command fast-rejects msedge --version and Chrome --dump-dom", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = comparisonShell(root);
  const edge = await shell.execute({ cmd: BROWSER_PROBE }, new AbortController().signal, { sessionId: 'test', invocationId: 'test' });
  assert.equal(edge.content, COMPARISON_BROWSER_SHELL_DENIED);
  assert.match(edge.content, /render_artifact|preview_report/);
  const chrome = await shell.execute(
    { cmd: "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --dump-dom file:///tmp/x.html" },
    new AbortController().signal, { sessionId: 'test', invocationId: 'test' },
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
  const visible = await instrumented.execute({ cmd: BROWSER_PROBE }, new AbortController().signal, { sessionId: 'test', invocationId: 'test' });
  assert.equal(visible.content, COMPARISON_BROWSER_SHELL_DENIED);
  const body = toolResultBody(visible);
  assert.equal(body.encoding, "inline");
  assert.equal(body.text, COMPARISON_BROWSER_SHELL_DENIED);
  assert.doesNotMatch(visible.content, /agent tool execution failed/i);
});

test("reverse: throw-through deny is swallowed by AgentToolFailure before the model", async () => {
  const { Type } = await import("@sinclair/typebox");
  const fixture: AgentToolDefinition = {
    name: "exec_command",
    description: "throw-style deny fixture",
    parameters: Type.Object({ cmd: Type.String({ minLength: 1 }) }),
    async execute() {
      throw new Error(COMPARISON_BROWSER_SHELL_DENIED);
    },
  };
  const [instrumented] = instrumentTools([fixture], "session-throw", "comparison", { requestIndex: 0 });
  assert.ok(instrumented);
  await assert.rejects(
    instrumented.execute({ cmd: BROWSER_PROBE }, new AbortController().signal),
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

test("Comparison exec_command still runs ordinary Node/Python static checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-cmp-shell-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "note.txt"), "ok\n");
  const shell = comparisonShell(root);
  const node = await shell.execute(
    { cmd: hostNodeCommand("process.stdout.write('node-ok')") },
    new AbortController().signal, { sessionId: 'test', invocationId: 'test' },
  );
  assert.match(node.content, /node-ok/);
  const py = await shell.execute(
    { cmd: process.platform === "win32" ? "python -c \"print('py-ok')\"" : "python3 -c \"print('py-ok')\"" },
    new AbortController().signal, { sessionId: 'test', invocationId: 'test' },
  );
  assert.match(py.content, /py-ok/);
});

test('Comparison stdin keeps browser, readonly and credential guards without losing its owned process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-cmp-stdin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = withComparisonShellDeny(workspaceTools(root, { role: 'comparison', allowShell: true,
    managedExecution: true, mounts: { source: root }, processLogRoot: root }));
  const owner = { sessionId: 'test', invocationId: 'stdin' }, signal = new AbortController().signal;
  const exec = tools.find(tool => tool.name === 'exec_command')!, stdin = tools.find(tool => tool.name === 'write_stdin')!;
  const started = await exec.execute({ cmd: hostNodeCommand("process.stdin.once('data', () => process.exit(0))"), yield_time_ms: 0 }, signal, owner);
  const id = (started.details as { session_id: string }).session_id;
  t.after(() => exec.lifecycle!.finishInvocation(owner, false));
  const browser = await stdin.execute({ session_id: id, chars: 'chrome --headless\n' }, signal, owner);
  assert.equal(browser.content, COMPARISON_BROWSER_SHELL_DENIED);
  await assert.rejects(stdin.execute({ session_id: id, chars: 'Remove-Item source/file.txt\n' }, signal, owner), /write_denied/);
  await assert.rejects(stdin.execute({ session_id: id, chars: 'Get-Content auth.json\n' }, signal, owner), /credential_read_denied/);
  const finished = await stdin.execute({ session_id: id, chars: 'safe\n' }, signal, owner);
  assert.equal((finished.details as { exitCode: number }).exitCode, 0);
  const receipt = finished.details as { outputLog: string };
  assert.equal(await readFile(join(root, receipt.outputLog), 'utf8'), '');
  await exec.lifecycle!.finishInvocation(owner);
});
