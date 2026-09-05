import test from "node:test";
import assert from "node:assert/strict";
import { defaultShell, hostContext, openPathInvocation, shellInvocation } from "../src/infrastructure/platform.js";

test("host context exposes a supported shell and portable capabilities", () => {
  const context = hostContext({ PATH: process.env.PATH, SHELL: "/bin/zsh" });
  assert.ok(["win32", "darwin", "linux"].includes(context.platform));
  assert.ok(context.defaultShell.executable.length > 0);
  assert.ok(context.capabilities.has("process.spawn"));
});

test("shell selection honors POSIX SHELL without changing the host platform", () => {
  const shell = defaultShell({ SHELL: "/bin/fish", SystemRoot: "C:\\Windows" });
  if (process.platform === "win32") assert.equal(shell.kind, "powershell");
  else assert.deepEqual(shell, { kind: "fish", executable: "/bin/fish" });
});

test("platform adapters produce explicit argv without relying on the current host", () => {
  assert.deepEqual(shellInvocation("printf hello", { SHELL: "/bin/zsh" }, "darwin"), {
    executable: "/bin/zsh", args: ["-c", "printf hello"], kind: "zsh",
  });
  assert.deepEqual(shellInvocation("Write-Output hello", {}, "win32").args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.deepEqual(openPathInvocation("/tmp/report.html", "linux"), { executable: "xdg-open", args: ["/tmp/report.html"] });
});



