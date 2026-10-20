import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { summarizeDiagnostic } from "../infrastructure/process/stdio.js";
import { runProcess } from "../infrastructure/process-runner.js";
import { assertNoSymlinkAncestors } from "./local-workspace-fs.js";

async function assertMaterializedGitDirectory(root: string): Promise<void> {
  const gitdir = join(root, ".git");
  await assertNoSymlinkAncestors(root, ".git");
  const info = await lstat(gitdir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Recovery history sealing requires an owned materialized .git directory.");
  for (const name of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "shallow", "worktrees", "refs/replace", "reprise-disabled-hooks", "missing-global-config"]) {
    try { await lstat(join(gitdir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error("Recovery Git metadata redirection or alternate history is not supported for sealing.");
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const item = await lstat(path);
      if (item.isSymbolicLink()) throw new Error("Recovery Git metadata must not contain links.");
      if (item.isDirectory()) await visit(path);
      else if (!item.isFile()) throw new Error("Recovery Git metadata must contain ordinary files only.");
    }
  };
  await visit(gitdir);
}

/** Only after the investigated HEAD/tree/input checks have passed, remove successor reachability. */
export async function sealRecoveryGitHistory(root: string, head: string, signal?: AbortSignal): Promise<boolean> {
  await assertMaterializedGitDirectory(root);
  signal?.throwIfAborted();
  const gitdir = join(root, ".git");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = async (args: string[]) => {
    const result = await runProcess({ operation: "recovery_seal_history", executableKind: "git", command: "git",
      args: ["--git-dir=.git", "--work-tree=.", "-c", "core.hooksPath=.git/reprise-disabled-hooks", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "-c", "gc.auto=0", ...args],
      allowNonzeroExit: true, cwd: root, timeoutMs: 120000, maxOutputBytes: 8 * 1024 * 1024,
      env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`Recovery Git history sealing failed (${args[0]}, exit ${result.exitCode}): ${summarizeDiagnostic(result.stderr, 1000)}`);
    return result.stdout;
  };
  if ((await git(["rev-parse", "--verify", "HEAD"])).trim() !== head) throw new Error("Recovery HEAD changed before history sealing.");
  // Rebase continuation needs its refs, original tip and pending commit objects.
  if (["rebase-merge", "rebase-apply"].some(name => existsSync(join(gitdir, name)))) return false;
  // Detach without checkout: no working-tree rewrite or post-checkout hooks are needed.
  await git(["update-ref", "--no-deref", "HEAD", head]);
  const refs = (await git(["for-each-ref", "--format=%(refname)"])).split(/\r?\n/).filter(Boolean);
  for (const ref of refs) await git(["update-ref", "--no-deref", "-d", ref]);
  for (const name of ["FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "REBASE_HEAD"]) await rm(join(gitdir, name), { force: true });
  await git(["reflog", "expire", "--expire=now", "--all"]);
  await git(["repack", "-Ad"]);
  await git(["prune", "--expire=now"]);
  await git(["fsck", "--full", "--no-reflogs"]);
  signal?.throwIfAborted();
  return true;
}
