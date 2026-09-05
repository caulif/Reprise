import { homedir, platform as hostPlatform, arch } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type ShellKind = "powershell" | "cmd" | "bash" | "zsh" | "fish";
export type HostPlatform = "win32" | "darwin" | "linux";

export type HostContext = {
  platform: HostPlatform;
  arch: string;
  homeDir: string;
  pathCase: "sensitive" | "insensitive" | "unknown";
  defaultShell: { kind: ShellKind; executable: string };
  capabilities: ReadonlySet<"process.spawn" | "workspace.write" | "git" | "pty" | "symlink">;
};

function hostPlatformInfo(): HostPlatform {
  const value = hostPlatform();
  if (value !== "win32" && value !== "darwin" && value !== "linux")
    throw new Error(`Unsupported host platform: ${value}`);
  return value;
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: HostPlatform = hostPlatformInfo()): { kind: ShellKind; executable: string } {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
    return { kind: "powershell", executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") };
  }
  const configured = env.SHELL?.trim();
  if (configured) return { kind: configured.endsWith("zsh") ? "zsh" : configured.endsWith("fish") ? "fish" : "bash", executable: configured };
  return platform === "darwin" ? { kind: "zsh", executable: "/bin/zsh" } : { kind: "bash", executable: "/bin/bash" };
}

export function hostContext(env: NodeJS.ProcessEnv = process.env): HostContext {
  const platform = hostPlatformInfo();
  const shell = defaultShell(env);
  const capabilities = new Set<"process.spawn" | "workspace.write" | "git" | "pty" | "symlink">([
    "process.spawn", "workspace.write",
  ]);
  if (env.GIT_EXEC_PATH || env.PATH?.split(delimiter).some((item) => item && /(?:^|[\\/])git(?:[\\/]|$)/i.test(item))) capabilities.add("git");
  return { platform, arch: arch(), homeDir: homedir(), pathCase: "unknown", defaultShell: shell, capabilities };
}

export function shellInvocation(command: string, env: NodeJS.ProcessEnv = process.env, platform: HostPlatform = hostPlatformInfo()): { executable: string; args: string[]; kind: ShellKind } {
  const shell = defaultShell(env, platform);
  if (shell.kind === "powershell") return { executable: shell.executable, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], kind: shell.kind };
  return { executable: shell.executable, args: ["-c", command], kind: shell.kind };
}

export function openPathInvocation(path: string, platform: HostPlatform = hostPlatformInfo()): { executable: string; args: string[] } {
  return platform === "win32"
    ? { executable: "explorer.exe", args: [path] }
    : platform === "darwin"
      ? { executable: "open", args: [path] }
      : { executable: "xdg-open", args: [path] };
}

export function terminateProcessTree(child: ChildProcess, killTree: boolean): void {
  if (!killTree || hostPlatformInfo() !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)], {
    stdio: "ignore", windowsHide: true,
  });
  killer.once("error", () => child.kill());
  killer.once("close", () => { if (!child.killed) child.kill(); });
}





