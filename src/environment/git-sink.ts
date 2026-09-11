import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import {
  GitSinkManifestSchema,
  GitSinkManifestV1Schema,
  type GitSinkIssue,
  type GitSinkManifest,
  type GitSinkRef,
  type GitSinkRefChange,
  type GitSinkRepoRecord,
  type GitSinkSkipped,
} from "../core/schema.js";

const GIT_NO_LAZY_FETCH = "1";

export class GitIsolationError extends Error {
  readonly reasonCode = "git_remote_unprotected" as const;
  constructor() {
    super("git_remote_unprotected");
    this.name = "GitIsolationError";
  }
}

const execFileAsync = promisify(execFile);

export type GitIsolationRecord = {
  readonly sinkRoot: string;
  readonly status: GitSinkManifest["status"];
  readonly repos: readonly {
    readonly relative: string;
    readonly sink: string;
    readonly originalUrls: readonly string[];
    readonly isolation: GitSinkRepoRecord["isolation"];
    readonly objectStore: GitSinkRepoRecord["objectStore"];
    readonly completeness: GitSinkRepoRecord["completeness"];
    readonly issues: readonly GitSinkIssue[];
  }[];
  readonly skipped: readonly GitSinkSkipped[];
  readonly errors: readonly string[];
};

type DiscoveredRepo = {
  readonly worktree: string;
  readonly relative: string;
  readonly gitDir: string;
  readonly kind: GitSinkRepoRecord["gitDirKind"];
};

export function gitSinkRoot(environmentRoot: string, id: string): string {
  return join(resolve(environmentRoot), "git-sinks", id);
}

export function gitSinkManifestPath(sinkRoot: string): string {
  return join(resolve(sinkRoot), "git-sink-manifest.json");
}

/** Rewrites remotes in a Harness-owned tree so push/fetch default to local bare sinks. */
export async function isolateGitTopology(tree: string, sinkRoot: string): Promise<GitIsolationRecord> {
  const treeRoot = resolve(tree);
  const sinks = resolve(sinkRoot);
  assertSinkLocation(sinks);
  const previous = await readGitSinkManifest(sinks);
  const { repos: discovered, skipped } = await discoverGitWorktrees(treeRoot, sinks);
  if (!discovered.length && !skipped.length) {
    return toRecord(emptyManifest(sinks, treeRoot, "ready", false, [], [], []));
  }
  await mkdir(join(sinks, "repos"), { recursive: true });
  const repos: GitSinkRepoRecord[] = [];
  for (const repo of discovered) {
    const sink = join(sinks, "repos", sinkName(repo.relative));
    const prior = previous?.repos.find((item) => item.relativePath === repo.relative);
    repos.push(await materializeRepo(repo, sink, sinks, prior));
  }
  const rewritten = new Set(repos.filter((repo) => repo.isolation === "rewritten").map((repo) => repo.relativePath));
  const rewriteFailed = await applyRemoteProtection(discovered, sinks, rewritten);
  for (const relative of rewriteFailed) {
    const index = repos.findIndex((repo) => repo.relativePath === relative);
    const current = repos[index];
    if (!current) continue;
    repos[index] = {
      ...current,
      isolation: "skipped",
      issues: uniqueIssues([...current.issues, { code: "remote_rewrite_failed" }]),
    };
  }
  const status = isolationStatus(repos, skipped);
  const manifest: GitSinkManifest = {
    schemaVersion: 2,
    sinkId: basename(sinks),
    treeRoot,
    sinkRoot: sinks,
    status,
    finalized: false,
    repos,
    skipped,
    errors: unique(repos.flatMap((repo) => repo.issues.map((issue) => issue.code))),
  };
  await persistIsolation(sinks, manifest);
  return toRecord(manifest);
}

export async function finalizeGitSinkCatalog(sinkRoot: string): Promise<GitSinkManifest> {
  const sinks = resolve(sinkRoot);
  const manifest = await readGitSinkManifest(sinks);
  if (!manifest) {
    return emptyManifest(sinks, sinks, "missing", true, [], [], ["manifest_missing"]);
  }
  const repos: GitSinkRepoRecord[] = [];
  for (const repo of manifest.repos) {
    const finalRefs = await listRefs(repo.sinkPath);
    repos.push({
      ...repo,
      finalRefs,
      refChanges: diffRefs(repo.initialRefs, finalRefs),
    });
  }
  const next: GitSinkManifest = {
    ...manifest,
    finalized: true,
    repos,
    status: isolationStatus(repos, manifest.skipped),
  };
  await writeManifest(sinks, next);
  await writeRefsListing(sinks, next);
  return next;
}

export async function gitSinkRefsListing(sinkRoot: string): Promise<string> {
  const resolved = resolve(sinkRoot);
  const manifest = await readGitSinkManifest(resolved);
  if (!manifest) {
    if (!existsSync(resolved)) return "status\tmissing\n";
    const scanned = await scanRefsFallback(resolved);
    return scanned;
  }
  return formatRefsListing(manifest);
}

export async function readGitSinkManifest(sinkRoot: string): Promise<GitSinkManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(gitSinkManifestPath(sinkRoot), "utf8")) as unknown;
    return migrateManifest(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function removeGitSink(sinkRoot: string): Promise<void> {
  const resolved = resolve(sinkRoot);
  assertSinkLocation(resolved);
  await rm(resolved, { recursive: true, force: true });
}

async function materializeRepo(
  repo: DiscoveredRepo,
  sink: string,
  sinks: string,
  prior: GitSinkRepoRecord | undefined,
): Promise<GitSinkRepoRecord> {
  const classified = await classifyObjectStore(repo.worktree);
  const previousUrls = await readRecordedUrls(sink);
  const liveUrls = await remoteUrls(repo.worktree);
  const inherited = (await Promise.all(liveUrls.map(readRecordedUrlsFromRemote))).flat();
  const originalUrls = unique([
    ...previousUrls,
    ...liveUrls.filter((url) => !isSinkUrl(url, sinks)),
    ...inherited,
  ]);
  await ensureBareSink(sink);
  await writeAtomic(join(sink, "original-urls.json"), `${JSON.stringify(originalUrls, null, 2)}\n`);
  const initialRefs = prior?.initialRefs.length ? prior.initialRefs : await listWorktreeRefs(repo.worktree);
  let objectStore: GitSinkRepoRecord["objectStore"] = prior?.objectStore === "seeded" ? "seeded" : "not_seeded";
  const issues = [...classified.issues];
  if (classified.completeness === "complete" && objectStore !== "seeded") {
    const seeded = await seedSinkFromWorktree(repo.worktree, sink);
    objectStore = seeded;
    if (seeded === "seed_failed") issues.push({ code: "seed_fetch_failed" });
  }
  return {
    relativePath: repo.relative,
    sinkName: basename(sink),
    sinkPath: sink,
    gitDirKind: repo.kind,
    recordedUrls: originalUrls.map(redactRemoteUrl),
    initialRefs,
    isolation: "rewritten",
    objectStore,
    completeness: classified.completeness,
    issues: uniqueIssues(issues),
  };
}

async function persistIsolation(sinks: string, manifest: GitSinkManifest): Promise<void> {
  await writeManifest(sinks, manifest);
  await writeGitconfig(sinks, await Promise.all(manifest.repos.map(async (repo) => ({
    relative: repo.relativePath,
    sink: repo.sinkPath,
    originalUrls: await readRecordedUrls(repo.sinkPath),
  }))));
  await writeAtomic(join(sinks, "INDEX.tsv"), [
    "relative\tsink\trecorded_urls",
    ...manifest.repos.map((repo) => `${repo.relativePath}\t${repo.sinkName}\t${repo.recordedUrls.join(" ")}`),
    "",
  ].join("\n"));
  await writeRefsListing(sinks, manifest);
}

async function writeManifest(sinks: string, manifest: GitSinkManifest): Promise<void> {
  assertGitSinkManifest(manifest);
  await writeAtomic(gitSinkManifestPath(sinks), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Host bug if production isolation emits an object that fails this check. */
export function assertGitSinkManifest(manifest: unknown): asserts manifest is GitSinkManifest {
  if (!Value.Check(GitSinkManifestSchema, manifest)) throw new Error("git-sink-manifest.json failed GitSinkManifestSchema.");
}

async function writeRefsListing(sinks: string, manifest: GitSinkManifest): Promise<void> {
  await writeAtomic(join(sinks, "git-sink-refs.txt"), formatRefsListing(manifest));
}

function formatRefsListing(manifest: GitSinkManifest): string {
  const rows = [
    `status\t${manifest.status}`,
    `finalized\t${manifest.finalized ? "yes" : "no"}`,
    "relative\tsink\tphase\tref\tsha\tobjectStore",
  ];
  for (const repo of manifest.repos) {
    appendRefRows(rows, repo, "initial", repo.initialRefs);
    if (repo.finalRefs) appendRefRows(rows, repo, "final", repo.finalRefs);
    if (!repo.initialRefs.length && !repo.finalRefs?.length) {
      rows.push(`${repo.relativePath}\t${repo.sinkName}\tcurrent\tmissing\t\t${repo.objectStore}`);
    }
  }
  for (const skip of manifest.skipped) rows.push(`${skip.relativePath}\t\tskipped\t${skip.reason}\t\tabsent`);
  return `${rows.join("\n")}\n`;
}

function appendRefRows(rows: string[], repo: GitSinkRepoRecord, phase: string, refs: readonly GitSinkRef[]): void {
  for (const item of refs) rows.push(`${repo.relativePath}\t${repo.sinkName}\t${phase}\t${item.ref}\t${item.sha}\t${repo.objectStore}`);
}

async function scanRefsFallback(sinkRoot: string): Promise<string> {
  const rows = ["status\tready", "finalized\tno", "relative\tsink\tphase\tref\tsha\tobjectStore"];
  let repos: string[] = [];
  try {
    repos = (await readdir(join(sinkRoot, "repos"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sinkRoot, "repos", entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const repo of repos) {
    const refs = await listRefs(repo);
    const name = basename(repo);
    if (!refs.length) rows.push(`unknown\t${name}\tcurrent\tmissing\t\tabsent`);
    for (const item of refs) rows.push(`unknown\t${name}\tcurrent\t${item.ref}\t${item.sha}\tabsent`);
  }
  return `${rows.join("\n")}\n`;
}

async function discoverGitWorktrees(tree: string, sinkRoot: string): Promise<{ repos: DiscoveredRepo[]; skipped: GitSinkSkipped[] }> {
  const found: DiscoveredRepo[] = [];
  const skipped: GitSinkSkipped[] = [];
  const treeReal = await realpath(tree).catch(() => tree);
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        skipped.push({ relativePath: relativePosix(tree, dir) || ".", reason: "unreadable_directory" });
        return;
      }
      throw error;
    }
    const gitEntry = entries.find((entry) => entry.name === ".git");
    if (gitEntry) {
      const resolved = await resolveDiscoveredRepo(dir, tree, treeReal, sinkRoot);
      if ("reason" in resolved) skipped.push({ relativePath: relativePosix(tree, dir) || ".", reason: resolved.reason });
      else found.push(resolved);
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "git-sinks") continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      await walk(join(dir, entry.name));
    }
  }
  await walk(tree);
  return { repos: found, skipped };
}

async function resolveDiscoveredRepo(
  worktree: string,
  tree: string,
  treeReal: string,
  sinkRoot: string,
): Promise<DiscoveredRepo | { reason: string }> {
  const gitPath = join(worktree, ".git");
  let info;
  try {
    info = await lstat(gitPath);
  } catch {
    return { reason: "unreadable_git" };
  }
  if (info.isSymbolicLink()) return { reason: "symlink_git" };
  let gitDir = gitPath;
  let kind: GitSinkRepoRecord["gitDirKind"] = "directory";
  if (info.isFile()) {
    kind = "file";
    const body = await readFile(gitPath, "utf8").catch(() => "");
    const match = body.match(/^gitdir:\s*(.+)\s*$/m);
    const gitdirLine = match?.[1]?.trim();
    if (!gitdirLine) return { reason: "invalid_gitfile" };
    gitDir = resolve(worktree, gitdirLine);
    if (gitDir.replaceAll("\\", "/").includes("/worktrees/")) kind = "worktree";
  } else if (!info.isDirectory()) {
    return { reason: "unsupported_git" };
  }
  if (pathContainedBy(sinkRoot, gitDir)) return { reason: "git_sinks" };
  const gitReal = await realpath(gitDir).catch(() => undefined);
  if (!gitReal) return { reason: "unreadable_gitdir" };
  if (!pathContainedBy(treeReal, gitReal) && !pathContainedBy(tree, gitDir)) return { reason: "gitdir_outside" };
  const workReal = await realpath(worktree).catch(() => undefined);
  if (!workReal || (!pathContainedBy(treeReal, workReal) && !pathContainedBy(tree, worktree))) {
    return { reason: "worktree_outside" };
  }
  if (await isBareGitDir(gitDir)) kind = "bare";
  return {
    worktree,
    relative: relativePosix(tree, worktree) || ".",
    gitDir,
    kind,
  };
}

async function isBareGitDir(gitDir: string): Promise<boolean> {
  const { stdout } = await git(["--git-dir", gitDir, "rev-parse", "--is-bare-repository"]).catch(() => ({ stdout: "" }));
  return stdout.trim() === "true";
}

function sinkName(relativePath: string): string {
  if (relativePath === ".") return "_root.git";
  return `${sha256(relativePath).slice(0, 12)}.git`;
}

async function ensureBareSink(sink: string): Promise<void> {
  if (existsSync(join(sink, "HEAD"))) return;
  await mkdir(sink, { recursive: true });
  await git(["init", "--bare", sink]);
  await git(["--git-dir", sink, "config", "core.longpaths", "true"]);
}

async function seedSinkFromWorktree(worktree: string, sink: string): Promise<"seeded" | "seed_failed"> {
  try {
    await git(["--git-dir", sink, "fetch", "--update-head-ok", worktree, "+refs/*:refs/*"]);
    return "seeded";
  } catch {
    return "seed_failed";
  }
}

async function classifyObjectStore(worktree: string): Promise<{ completeness: "complete" | "incomplete"; issues: GitSinkIssue[] }> {
  const issues: GitSinkIssue[] = [];
  const shallow = (await git(["-C", worktree, "rev-parse", "--is-shallow-repository"]).catch(() => ({ stdout: "false" }))).stdout.trim() === "true";
  if (shallow) issues.push({ code: "incomplete_object_store" });
  const { stdout: config } = await git(["-C", worktree, "config", "--get-regexp", String.raw`^(remote\..*\.(promisor|partialclonefilter)|extensions\.partialclone)$`]).catch(() => ({ stdout: "" }));
  if (/promisor|partialclonefilter|partialclone/i.test(config)) {
    issues.push({ code: "incomplete_object_store" });
    if (/promisor/i.test(config)) issues.push({ code: "promisor_lazy_fetch_disabled" });
  }
  const gitDirRaw = (await git(["-C", worktree, "rev-parse", "--git-dir"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const gitDir = gitDirRaw ? resolve(worktree, gitDirRaw) : join(worktree, ".git");
  try {
    const packs = await readdir(join(gitDir, "objects", "pack"));
    if (packs.some((name) => name.endsWith(".promisor"))) issues.push({ code: "incomplete_object_store" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const refs = await listWorktreeRefs(worktree);
  const shas = unique(refs.map((item) => item.sha));
  const head = (await git(["-C", worktree, "rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
  if (/^[0-9a-f]{40,64}$/i.test(head)) shas.push(head);
  for (const sha of shas) {
    const ok = await git(["-C", worktree, "cat-file", "-e", sha]).then(() => true).catch(() => false);
    if (!ok) issues.push({ code: "incomplete_object_store", objectId: sha });
  }
  if (!refs.length && !head) {
    const usable = await git(["-C", worktree, "rev-parse", "--is-inside-work-tree"]).then(() => true).catch(() => false);
    if (!usable) issues.push({ code: "incomplete_object_store" });
  }
  return { completeness: issues.length ? "incomplete" : "complete", issues: uniqueIssues(issues) };
}

async function listWorktreeRefs(worktree: string): Promise<GitSinkRef[]> {
  const { stdout } = await git(["-C", worktree, "show-ref"]).catch(() => ({ stdout: "" }));
  return parseShowRef(stdout);
}

async function listRefs(gitDir: string): Promise<GitSinkRef[]> {
  if (!existsSync(gitDir)) return [];
  const { stdout } = await git(["--git-dir", gitDir, "show-ref"]).catch(() => ({ stdout: "" }));
  return parseShowRef(stdout);
}

function parseShowRef(stdout: string): GitSinkRef[] {
  return stdout.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [sha, ref] = line.split(/\s+/, 2);
    return sha && ref ? [{ sha, ref }] : [];
  });
}

function diffRefs(initial: readonly GitSinkRef[], final: readonly GitSinkRef[]): GitSinkRefChange[] {
  const before = new Map(initial.map((item) => [item.ref, item.sha]));
  const after = new Map(final.map((item) => [item.ref, item.sha]));
  const changes: GitSinkRefChange[] = [];
  for (const [ref, sha] of after) {
    const previous = before.get(ref);
    if (!previous) changes.push({ ref, kind: "added", after: sha });
    else if (previous !== sha) changes.push({ ref, kind: "updated", before: previous, after: sha });
  }
  for (const [ref, sha] of before) {
    if (!after.has(ref)) changes.push({ ref, kind: "removed", before: sha });
  }
  return changes;
}

async function remoteUrls(worktree: string): Promise<string[]> {
  const { stdout } = await git(["-C", worktree, "config", "--get-regexp", String.raw`^remote\..*\.(url|pushurl)$`]).catch(() => ({ stdout: "" }));
  return unique(stdout.split(/\r?\n/).flatMap((line) => expandRemoteUrl(line.replace(/^\S+\s+/, "").trim())).filter(Boolean));
}

function expandRemoteUrl(url: string): string[] {
  if (!url) return [];
  const aliases = new Set(githubUrlAliases(url));
  aliases.add(url);
  if (!url.includes("://") && !url.startsWith("git@")) {
    try {
      aliases.add(pathToFileURL(resolve(url)).href);
    } catch {
      // Not a filesystem path; keep the original remote string only.
    }
  }
  return [...aliases];
}

function githubUrlAliases(url: string): string[] {
  const match = url.match(/(?:github\.com[:/]|github\.com\/)([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!match) return [url];
  const repo = `${match[1]}/${match[2]}`;
  return [
    url,
    `https://github.com/${repo}.git`,
    `https://github.com/${repo}`,
    `git@github.com:${repo}.git`,
    `ssh://git@github.com/${repo}.git`,
  ];
}

async function retargetRemotes(worktree: string, sinkUrl: string): Promise<void> {
  const { stdout } = await git(["-C", worktree, "remote"]).catch(() => ({ stdout: "" }));
  const remotes = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!remotes.length) {
    await git(["-C", worktree, "remote", "add", "origin", sinkUrl]);
    await git(["-C", worktree, "config", "remote.origin.pushurl", sinkUrl]);
    return;
  }
  for (const remote of remotes) {
    await git(["-C", worktree, "config", `remote.${remote}.url`, sinkUrl]);
    await git(["-C", worktree, "config", "--unset-all", `remote.${remote}.pushurl`]).catch(() => undefined);
    await git(["-C", worktree, "config", `remote.${remote}.pushurl`, sinkUrl]);
  }
}

async function applyRemoteProtection(discovered: readonly DiscoveredRepo[], sinks: string, succeeded: ReadonlySet<string>): Promise<string[]> {
  const urlMap = new Map<string, string>();
  const failed: string[] = [];
  for (const repo of discovered) {
    if (!succeeded.has(repo.relative)) continue;
    const sinkUrl = gitFileUrl(join(sinks, "repos", sinkName(repo.relative)));
    const originals = await readRecordedUrls(join(sinks, "repos", sinkName(repo.relative)));
    for (const url of originals.flatMap(expandRemoteUrl)) urlMap.set(url, sinkUrl);
  }
  const keys = [...urlMap.keys()].sort((left, right) => right.length - left.length);
  for (const repo of discovered) {
    if (!succeeded.has(repo.relative)) continue;
    const sinkUrl = gitFileUrl(join(sinks, "repos", sinkName(repo.relative)));
    try {
      await retargetRemotes(repo.worktree, sinkUrl);
      await rewriteGitmodules(repo.worktree, keys, urlMap);
      await rewriteSubmoduleConfig(repo.worktree, urlMap);
      const remaining = (await remoteUrls(repo.worktree)).filter((url) => !isSinkUrl(url, sinks));
      if (remaining.length) failed.push(repo.relative);
    } catch {
      failed.push(repo.relative);
    }
  }
  return failed;
}

async function rewriteGitmodules(worktree: string, urls: readonly string[], urlMap: ReadonlyMap<string, string>): Promise<void> {
  const path = join(worktree, ".gitmodules");
  if (!existsSync(path) || !urls.length) return;
  let body = await readFile(path, "utf8");
  for (const url of urls) {
    const sinkUrl = urlMap.get(url);
    if (sinkUrl) body = body.replaceAll(url, sinkUrl);
  }
  await writeFile(path, body);
}

async function rewriteSubmoduleConfig(worktree: string, urlMap: ReadonlyMap<string, string>): Promise<void> {
  const { stdout } = await git(["-C", worktree, "config", "--get-regexp", String.raw`^submodule\..*\.url$`]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    const sinkUrl = urlMap.get(value) ?? [...urlMap.entries()].find(([url]) => value.includes(url))?.[1];
    if (sinkUrl) await git(["-C", worktree, "config", key, sinkUrl]);
  }
}

async function readRecordedUrls(sink: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(sink, "original-urls.json"), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeGitconfig(
  sinkRoot: string,
  repos: readonly { relative: string; sink: string; originalUrls: readonly string[] }[],
): Promise<void> {
  const gitconfig = join(sinkRoot, "gitconfig");
  await writeAtomic(gitconfig, "[user]\n\tname = Reprise Harness\n\temail = reprise@local\n[core]\n\tlongpaths = true\n");
  for (const repo of repos) {
    const sinkUrl = gitFileUrl(repo.sink);
    for (const url of unique(repo.originalUrls.flatMap(expandRemoteUrl))) {
      await git(["config", "-f", gitconfig, "--add", `url.${sinkUrl}.insteadOf`, url]);
    }
  }
}

async function readRecordedUrlsFromRemote(url: string): Promise<string[]> {
  const path = remoteUrlToPath(url);
  return path ? readRecordedUrls(path) : [];
}

function remoteUrlToPath(url: string): string | undefined {
  if (url.startsWith("file:")) {
    try {
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  if (!url.includes("://") && !url.startsWith("git@")) return resolve(url);
  return undefined;
}

function gitFileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

function isSinkUrl(url: string, sinkRoot: string): boolean {
  const normalized = url.replaceAll("\\", "/").toLowerCase();
  const sink = sinkRoot.replaceAll("\\", "/").toLowerCase();
  const sinkFile = gitFileUrl(sinkRoot).toLowerCase();
  return normalized.includes("/git-sinks/") || normalized.includes(sink) || normalized.startsWith(sinkFile);
}

function redactRemoteUrl(url: string): string {
  const withoutToken = url.replace(/ghp_[A-Za-z0-9]+/gi, "ghp_redacted").replace(/github_pat_[A-Za-z0-9_]+/gi, "github_pat_redacted");
  try {
    if (withoutToken.includes("://")) {
      const parsed = new URL(withoutToken);
      if (parsed.username || parsed.password) {
        parsed.username = "redacted";
        parsed.password = "";
      }
      return parsed.toString();
    }
  } catch {
    // Fall through to credential-shaped replacement.
  }
  return withoutToken.replace(/(\/\/)([^/@]+)@/g, "$1redacted@").replace(/:([^/@]+)@/g, ":***@");
}

function isolationStatus(
  repos: readonly GitSinkRepoRecord[],
  skipped: readonly GitSinkSkipped[],
): GitSinkManifest["status"] {
  const rewritten = repos.filter((repo) => repo.isolation === "rewritten");
  const unprotected = repos.some((repo) => repo.issues.some((issue) => issue.code === "remote_rewrite_failed"));
  if (unprotected) return "failed";
  if (!repos.length && !skipped.length) return "ready";
  const fullySeeded = rewritten.length === repos.length
    && skipped.length === 0
    && rewritten.every((repo) => repo.objectStore === "seeded");
  if (fullySeeded && rewritten.length) return "ready";
  if (rewritten.length) return "partial";
  if (repos.length && !rewritten.length) return "failed";
  return "partial";
}

function toRecord(manifest: GitSinkManifest): GitIsolationRecord {
  return {
    sinkRoot: manifest.sinkRoot,
    status: manifest.status,
    repos: manifest.repos.map((repo) => ({
      relative: repo.relativePath,
      sink: repo.sinkPath,
      originalUrls: repo.recordedUrls,
      isolation: repo.isolation,
      objectStore: repo.objectStore,
      completeness: repo.completeness,
      issues: repo.issues,
    })),
    skipped: manifest.skipped,
    errors: manifest.errors,
  };
}

function assertSinkLocation(sinkRoot: string): void {
  if (basename(dirname(resolve(sinkRoot))) !== "git-sinks") {
    throw new Error("Git sink path must be environment/git-sinks/{id}.");
  }
}

function relativePosix(root: string, target: string): string {
  return relative(root, target).replaceAll("\\", "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueIssues(issues: readonly GitSinkIssue[]): GitSinkIssue[] {
  const seen = new Set<string>();
  const next: GitSinkIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.objectId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(issue);
  }
  return next;
}

function emptyManifest(
  sinks: string,
  treeRoot: string,
  status: GitSinkManifest["status"],
  finalized: boolean,
  repos: GitSinkRepoRecord[],
  skipped: GitSinkSkipped[],
  errors: string[],
): GitSinkManifest {
  return {
    schemaVersion: 2,
    sinkId: basename(sinks),
    treeRoot,
    sinkRoot: sinks,
    status,
    finalized,
    repos,
    skipped,
    errors,
  };
}

function migrateManifest(parsed: unknown): GitSinkManifest | undefined {
  if (Value.Check(GitSinkManifestSchema, parsed)) return parsed;
  if (!Value.Check(GitSinkManifestV1Schema, parsed)) return undefined;
  const v1 = parsed;
  return {
    schemaVersion: 2,
    sinkId: v1.sinkId,
    treeRoot: v1.treeRoot,
    sinkRoot: v1.sinkRoot,
    status: v1.status,
    finalized: v1.finalized,
    repos: v1.repos.map((repo) => ({
      relativePath: repo.relativePath,
      sinkName: repo.sinkName,
      sinkPath: repo.sinkPath,
      gitDirKind: repo.gitDirKind,
      recordedUrls: repo.recordedUrls,
      initialRefs: repo.initialRefs,
      ...(repo.finalRefs ? { finalRefs: repo.finalRefs } : {}),
      ...(repo.refChanges ? { refChanges: repo.refChanges } : {}),
      isolation: "rewritten" as const,
      objectStore: repo.initialRefs.length ? "seeded" as const : "not_seeded" as const,
      completeness: "complete" as const,
      issues: [],
    })),
    skipped: v1.skipped,
    errors: unique(v1.errors.map((item) => item.slice(0, 128)).filter((item) => item.length > 0)),
  };
}

function git(args: readonly string[]) {
  return execFileAsync("git", ["-c", "core.longpaths=true", ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH },
  });
}
