import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runProcess, type ProcessResult } from "../infrastructure/process-runner.js";

const EVERYONE_SID = "*S-1-1-0";
const LOCK_TIMEOUT_MS = 120_000;

export type SourceWriteLock = {
  release: () => Promise<void>;
};

export type SourceWriteLockHost = {
  platform?: NodeJS.Platform;
  homedir?: string;
  systemRoot?: string;
  runProcess?: (input: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>;
};

/** Denies Everyone write/create on the live source tree without blocking Host fingerprint reads. Restore from a saved ACL on release. */
export async function lockSourceWrites(
  sourceRoot: string,
  stateDir: string,
  host: SourceWriteLockHost = {},
): Promise<SourceWriteLock> {
  const platform = host.platform ?? process.platform;
  if (platform !== "win32") {
    return { release: async () => {} };
  }
  const source = resolve(sourceRoot);
  const dir = resolve(stateDir);
  await mkdir(dir, { recursive: true });
  const backupPath = join(dir, "source-acl.txt");
  const icacls = icaclsPath(host.systemRoot);
  const run = (args: readonly string[]) => runIcacls(icacls, args, host);
  const saved = await run([source, "/save", backupPath, "/T", "/C", "/Q"]);
  if (saved.exitCode !== 0) throw new Error("Could not save source ACLs before applying the write lock.");
  const denied = await run([source, "/deny", `${EVERYONE_SID}:(OI)(CI)(WD,AD,DC)`, "/T", "/C", "/Q"]);
  if (denied.exitCode !== 0) {
    await restoreSourceAcls(source, backupPath, run);
    throw new Error("Could not apply a write deny ACL to the user source directory.");
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await restoreSourceAcls(source, backupPath, run);
    },
  };
}

async function restoreSourceAcls(
  source: string,
  backupPath: string,
  run: (args: readonly string[]) => Promise<ProcessResult>,
): Promise<void> {
  const restored = await run([dirname(source), "/restore", backupPath]);
  if (restored.exitCode === 0) return;
  await run([source, "/remove:d", EVERYONE_SID, "/T", "/C", "/Q"]);
}

function icaclsPath(systemRoot?: string): string {
  const root = systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(root, "System32", "icacls.exe");
}

function runIcacls(
  executable: string,
  args: readonly string[],
  host: SourceWriteLockHost,
): Promise<ProcessResult> {
  const run = host.runProcess ?? runProcess;
  return run({
    operation: "source_write_lock",
    executableKind: "icacls",
    command: executable,
    args,
    cwd: host.homedir ?? homedir(),
    timeoutMs: LOCK_TIMEOUT_MS,
    maxOutputBytes: 16_384,
    truncateOutput: true,
    allowNonzeroExit: true,
    killTree: true,
  });
}
