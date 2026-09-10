import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverExecutable,
  spawnRuntimeProcess,
  windowsProcessInvocation,
} from "../../src/infrastructure/process/spawn.js";

test("POSIX executable discovery rejects a non-executable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-discovery-"));
  const file = join(root, "tool");
  try {
    await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(file, 0o644);
    assert.equal(await discoverExecutable({ command: "tool", env: { PATH: root }, platform: "linux" }), undefined);
    await chmod(file, 0o755);
    if (process.platform !== "win32") assert.equal(await discoverExecutable({ command: "tool", env: { PATH: root }, platform: "linux" }), file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows .cmd invocation wraps the whole command for cmd /s and requests verbatim arguments", () => {
  const invocation = windowsProcessInvocation(
    String.raw`C:\Users\name with space\npm\codex.cmd`,
    ["app-server", "--listen", "stdio://"],
    "win32",
    String.raw`C:\Windows\System32\cmd.exe`,
  );
  assert.equal(invocation.command, String.raw`C:\Windows\System32\cmd.exe`);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    invocation.args[3],
    String.raw`""C:\Users\name with space\npm\codex.cmd" app-server --listen stdio://"`,
  );
});

test("non-cmd executables keep an argv array", () => {
  assert.deepEqual(
    windowsProcessInvocation(String.raw`C:\tools\codex.exe`, ["app-server"], "win32"),
    { command: String.raw`C:\tools\codex.exe`, args: ["app-server"] },
  );
});

test("Windows .cmd with extra args and spaces in the path starts", async (t) => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "reprise cmd "));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const shim = join(root, "echo-args.cmd");
  const out = join(root, "args.txt");
  await writeFile(shim, `@echo off\r\n> "${out}" echo %*\r\nexit /b 0\r\n`);
  await new Promise<void>((resolve, reject) => {
    const child = spawnRuntimeProcess(shim, ["app-server", "--listen", "stdio://"], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`shim exited ${code ?? "null"}`));
    });
  });
  assert.match(await readFile(out, "utf8"), /app-server --listen stdio:\/\//);
});

test("Node's default argv quoting of a pre-quoted cmd /c line cannot start a .cmd shim", async (t) => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "reprise cmd broken "));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const shim = join(root, "ok.cmd");
  await writeFile(shim, "@echo off\r\nexit /b 0\r\n");
  const commandLine = `"${shim}" app-server --listen stdio://`;
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  assert.notEqual(code, 0);
});

test("WSL discovery rejects a host Windows executable even when the file exists", async () => {
  const windowsExe = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  assert.equal(
    await discoverExecutable({
      command: "powershell",
      executable: windowsExe,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin" },
      cwd: process.cwd(),
    }),
    undefined,
  );
});
