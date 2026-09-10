import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { writeAtomic } from "../core/identity.js";

const execFileAsync = promisify(execFile);

export type GitIsolationRecord = {
  readonly sinkRoot: string;
  readonly repos: readonly {
    readonly relative: string;
    readonly sink: string;
    readonly originalUrls: readonly string[];
  }[];
};

export function gitSinkRoot(environmentRoot: string, id: string): string {
  return join(resolve(environmentRoot), "git-sinks", id);
}

/** Rewrites remotes in a Harness-owned tree so push/fetch default to local bare sinks. */
export async function isolateGitTopology(tree: string, sinkRoot: string): Promise<GitIsolationRecord> {
  const treeRoot = resolve(tree);
  const sinks = resolve(sinkRoot);
  const worktrees = await findGitWorktrees(treeRoot);
  if (!worktrees.length) return { sinkRoot: sinks, repos: [] };
  await mkdir(sinks, { recursive: true });
  const repos: GitIsolationRecord["repos"][number][] = [];
  for (const worktree of worktrees) {
    const relativePath = relative(treeRoot, worktree).replaceAll("\\", "/") || ".";
    const sink = join(sinks, "repos", sinkName(relativePath));
    const previous = await readRecordedUrls(sink);
    const liveUrls = await remoteUrls(worktree);
    const inherited = (await Promise.all(liveUrls.map(readRecordedUrlsFromRemote))).flat();
    const originalUrls = unique([
      ...previous,
      ...liveUrls.filter((url) => !isSinkUrl(url, sinks)),
      ...inherited,
    ]);
    await ensureBareSink(worktree, sink);
    const sinkUrl = gitFileUrl(sink);
    await retargetRemotes(worktree, sinkUrl);
    await rewriteGitmodules(worktree, originalUrls, sinkUrl);
    await writeAtomic(join(sink, "original-urls.json"), `${JSON.stringify(originalUrls, null, 2)}\n`);
    repos.push({ relative: relativePath, sink, originalUrls });
  }
  await writeGitconfig(sinks, repos);
  await writeAtomic(join(sinks, "INDEX.tsv"), [
    "relative\tsink\toriginal_urls",
    ...repos.map((repo) => `${repo.relative}\t${repo.sink}\t${repo.originalUrls.join(" ")}`),
    "",
  ].join("\n"));
  return { sinkRoot: sinks, repos };
}

export async function gitSinkRefsListing(sinkRoot: string): Promise<string> {
  if (!existsSync(sinkRoot)) return "status\tmissing\n";
  const rows = ["repo\tref\tsha"];
  let repos: string[] = [];
  try {
    repos = (await readdir(join(sinkRoot, "repos"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sinkRoot, "repos", entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const repo of repos) {
    const { stdout } = await execFileAsync("git", ["--git-dir", repo, "show-ref"], {
      encoding: "utf8",
      windowsHide: true,
    }).catch(() => ({ stdout: "" }));
    const name = basename(repo);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) rows.push(`${name}\tmissing\t`);
    for (const line of lines) {
      const [sha, ref] = line.split(/\s+/, 2);
      rows.push(`${name}\t${ref ?? ""}\t${sha ?? ""}`);
    }
  }
  return `${rows.join("\n")}\n`;
}

async function findGitWorktrees(tree: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        found.push(dir);
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "git-sinks") continue;
      await walk(join(dir, entry.name));
    }
  }
  await walk(tree);
  return found;
}

function sinkName(relativePath: string): string {
  const slug = relativePath === "." ? "_root" : relativePath.replaceAll("/", "__");
  return `${slug}.git`;
}

async function ensureBareSink(worktree: string, sink: string): Promise<void> {
  if (existsSync(join(sink, "HEAD"))) {
    await execFileAsync("git", ["--git-dir", sink, "fetch", "--update-head-ok", worktree, "+refs/*:refs/*"], {
      windowsHide: true,
    });
    return;
  }
  await mkdir(dirname(sink), { recursive: true });
  await execFileAsync("git", ["clone", "--bare", "--local", worktree, sink], { windowsHide: true });
}

async function remoteUrls(worktree: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", worktree, "config", "--get-regexp", String.raw`^remote\..*\.(url|pushurl)$`], {
    encoding: "utf8",
    windowsHide: true,
  }).catch(() => ({ stdout: "" }));
  return unique(stdout.split(/\r?\n/).flatMap((line) => expandRemoteUrl(line.replace(/^\S+\s+/, "").trim())).filter(Boolean));
}

function expandRemoteUrl(url: string): string[] {
  if (!url) return [];
  const aliases = [url];
  if (!url.includes("://") && !url.startsWith("git@")) {
    try {
      aliases.push(pathToFileURL(resolve(url)).href);
    } catch {
      // Not a filesystem path; keep the original remote string only.
    }
  }
  return aliases;
}

async function retargetRemotes(worktree: string, sinkUrl: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", worktree, "remote"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch(() => ({ stdout: "" }));
  const remotes = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!remotes.length) {
    await execFileAsync("git", ["-C", worktree, "remote", "add", "origin", sinkUrl], { windowsHide: true });
    await execFileAsync("git", ["-C", worktree, "config", "remote.origin.pushurl", sinkUrl], { windowsHide: true });
    return;
  }
  for (const remote of remotes) {
    await execFileAsync("git", ["-C", worktree, "config", `remote.${remote}.url`, sinkUrl], { windowsHide: true });
    await execFileAsync("git", ["-C", worktree, "config", `remote.${remote}.pushurl`, sinkUrl], { windowsHide: true });
  }
}

async function rewriteGitmodules(worktree: string, originalUrls: readonly string[], sinkUrl: string): Promise<void> {
  const path = join(worktree, ".gitmodules");
  if (!existsSync(path) || !originalUrls.length) return;
  let body = await readFile(path, "utf8");
  for (const url of originalUrls) body = body.replaceAll(url, sinkUrl);
  await writeFile(path, body);
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

async function writeGitconfig(sinkRoot: string, repos: GitIsolationRecord["repos"]): Promise<void> {
  const gitconfig = join(sinkRoot, "gitconfig");
  await writeAtomic(gitconfig, "[user]\n\tname = Reprise Harness\n\temail = reprise@local\n");
  for (const repo of repos) {
    const sinkUrl = gitFileUrl(repo.sink);
    for (const url of repo.originalUrls) {
      await execFileAsync("git", ["config", "-f", gitconfig, "--add", `url.${sinkUrl}.insteadOf`, url], { windowsHide: true });
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
