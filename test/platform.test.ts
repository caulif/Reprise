import test from "node:test";
import assert from "node:assert/strict";
import { defaultShell, hostContext, openPathInvocation, shellInvocation, spawnCancelOptions } from "../src/infrastructure/platform.js";

test("host context exposes a supported shell and portable capabilities", () => {
  const context = hostContext({ PATH: process.env.PATH, SHELL: "/bin/zsh" });
  assert.ok(["win32", "darwin", "linux"].includes(context.platform));
  assert.ok(context.defaultShell.executable.length > 0);
  assert.ok(context.capabilities.has("process.spawn"));
  assert.equal(context.pathCase, process.platform === "win32" ? "insensitive" : "sensitive");
  if (context.platform === "win32") assert.equal(context.defaultShell.kind, "powershell");
  else assert.deepEqual(context.defaultShell, { kind: "bash", executable: "/bin/bash" });
});

test("shell selection ignores SHELL on every host", () => {
  const win = defaultShell({ SHELL: "/bin/fish", SystemRoot: "C:\\Windows" }, "win32");
  assert.equal(win.kind, "powershell");
  assert.match(win.executable, /System32.*powershell\.exe$/i);
  assert.deepEqual(defaultShell({ SHELL: "/bin/fish" }, "darwin"), { kind: "bash", executable: "/bin/bash" });
  assert.deepEqual(defaultShell({ SHELL: "/usr/bin/zsh" }, "linux"), { kind: "bash", executable: "/bin/bash" });
});

test("platform adapters produce explicit argv without relying on the current host", () => {
  assert.deepEqual(shellInvocation("printf hello", { SHELL: "/bin/zsh" }, "darwin"), {
    executable: "/bin/bash", args: ["-c", "printf hello"], kind: "bash",
  });
  assert.deepEqual(shellInvocation("printf hello", {}, "linux"), {
    executable: "/bin/bash", args: ["-c", "printf hello"], kind: "bash",
  });
  assert.deepEqual(shellInvocation("Write-Output hello", {}, "win32").args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.deepEqual(openPathInvocation("/tmp/report.html", "linux"), { executable: "xdg-open", args: ["/tmp/report.html"] });
  assert.equal(spawnCancelOptions(true, "linux").detached, true);
  assert.equal(spawnCancelOptions(true, "win32").detached, undefined);
  assert.equal(spawnCancelOptions(true, "linux").shell, false);
});
