import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { GitSinkManifestSchema } from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";
import { LocalWorkspaceProvider } from "../../src/environment/local-workspace-provider.js";
import {
  assertGitSinkManifest,
  finalizeGitSinkCatalog,
  gitSinkManifestPath,
  gitSinkRefsListing,
  gitSinkRoot,
  isolateGitTopology,
  readGitSinkManifest,
  removeGitSink,
} from "../../src/environment/git-sink.js";
import { isolateCandidateProcessEnv, spawnRuntimeProcess } from "../../src/infrastructure/process/spawn.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: env ?? process.env });
  return stdout.trim();
}

async function initRepo(root: string, origin?: string, branch = "main"): Promise<string> {
  await mkdir(root, { recursive: true });
  await git(["init", "-b", branch], root);
  await git(["config", "user.email", "harness@test"], root);
  await git(["config", "user.name", "Harness Test"], root);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(["add", "."], root);
  await git(["commit", "-m", "init"], root);
  if (origin) {
    await git(["remote", "add", "origin", origin], root);
    await git(["config", `remote.origin.pushurl`, origin], root);
    await git(["push", "-u", "origin", "HEAD"], root);
    return git(["--git-dir", origin, "rev-parse", `refs/heads/${branch}`]);
  }
  return git(["rev-parse", `refs/heads/${branch}`], root);
}

test("prepareRun retargets nested origin to a harness sink and does not advance the user remote", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-sink-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const userRemote = join(tmp, "user-remote.git");
  const nestedRemote = join(tmp, "nested-remote.git");
  const source = join(tmp, "source");
  const envRoot = join(tmp, "environment");
  await git(["init", "--bare", userRemote]);
  await git(["init", "--bare", nestedRemote]);
  const userHead = await initRepo(source, userRemote);
  const nestedHead = await initRepo(join(source, "caulif"), nestedRemote);
  const provider = new LocalWorkspaceProvider(envRoot);
  const baseline = await provider.resolveBaseline({ caseId: "case-git", sourceRoot: source }, [], {});
  const environment = await provider.prepareRun(baseline, "run-git");
  assert.equal(environment.gitSink?.status, "ready");
  assert.equal(environment.gitSink?.catalog, "git-sink-manifest.json");
  const replicaOrigin = await git(["config", "--local", "--get", "remote.origin.url"], environment.root);
  const nestedOrigin = await git(["config", "--local", "--get", "remote.origin.url"], join(environment.root, "caulif"));
  const replicaPush = await git(["config", "--local", "--get", "remote.origin.pushurl"], environment.root);
  assert.notEqual(replicaOrigin, userRemote);
  assert.notEqual(replicaOrigin, pathToFileURL(userRemote).href);
  assert.notEqual(nestedOrigin, nestedRemote);
  assert.notEqual(replicaPush, userRemote);
  assert.match(String(replicaPush), /git-sinks/);
  assert.match(replicaOrigin, /^file:/);
  await git(["config", "user.email", "harness@test"], environment.root);
  await git(["config", "user.name", "Harness Test"], environment.root);
  await git(["commit", "--allow-empty", "-m", "candidate"], environment.root);
  const candidateEnv = isolateCandidateProcessEnv(process.env, environment.root);
  await git(["push", "origin", "HEAD"], environment.root, candidateEnv);
  const sinkHead = await git(["--git-dir", join(gitSinkRoot(envRoot, "run-git"), "repos", "_root.git"), "rev-parse", "refs/heads/main"]);
  assert.notEqual(sinkHead, userHead);
  assert.equal(await git(["--git-dir", userRemote, "rev-parse", "refs/heads/main"]), userHead);
  await git(["push", userRemote, "HEAD"], environment.root, candidateEnv);
  assert.equal(await git(["--git-dir", userRemote, "rev-parse", "refs/heads/main"]), userHead);
  assert.equal(await git(["--git-dir", nestedRemote, "rev-parse", "refs/heads/main"]), nestedHead);
});

test("isolateGitTopology hashes nested sink names and does not clone --bare", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-nested-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const nestedRemote = join(tmp, "nested-remote.git");
  const source = join(tmp, "source");
  const paper = join(source, "caulif", "themes", "PaperMod");
  await git(["init", "--bare", nestedRemote]);
  await initRepo(paper, nestedRemote);
  const sinks = join(tmp, "git-sinks", "baseline-case-f4452141a0bc4dd0");
  const record = await isolateGitTopology(source, sinks);
  const nested = record.repos.find((repo) => repo.relative === "caulif/themes/PaperMod");
  assert.ok(nested);
  assert.equal(basename(nested.sink), `${sha256("caulif/themes/PaperMod").slice(0, 12)}.git`);
  assert.doesNotMatch(basename(nested.sink), /PaperMod|themes|__/);
  const index = await readFile(join(sinks, "INDEX.tsv"), "utf8");
  assert.match(index, /caulif\/themes\/PaperMod/);
  await isolateGitTopology(source, sinks);
  const sourceText = await readFile(join(process.cwd(), "src/environment/git-sink.ts"), "utf8");
  assert.doesNotMatch(sourceText, /clone", "--bare"/);
});

test("isolateGitTopology is a no-op without git metadata", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-empty-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const record = await isolateGitTopology(tmp, join(tmp, "git-sinks", "empty"));
  assert.equal(record.repos.length, 0);
  assert.equal(record.status, "ready");
});

test("isolateCandidateProcessEnv drops GitHub tokens and loads sink gitconfig", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-env-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const run = join(tmp, "runs", "run-env");
  const home = join(tmp, "git-sinks", "run-env");
  await mkdir(run, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "gitconfig"), "[user]\n\tname = sink\n");
  const env = isolateCandidateProcessEnv({
    PATH: process.env.PATH,
    HOME: "keep-home",
    USERPROFILE: "keep-profile",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "also-secret",
  }, run);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, join(home, "gitconfig"));
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_NO_LAZY_FETCH, "1");
  assert.equal(env.HOME, "keep-home");
  assert.equal(env.USERPROFILE, "keep-profile");
  const child = spawnRuntimeProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: run, env, stdio: "ignore" });
  assert.equal(child.spawnfile, process.execPath);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const spawnText = await readFile(join(process.cwd(), "src/infrastructure/process/spawn.ts"), "utf8");
  assert.match(spawnText, /shell:\s*false/);
});

test("git file worktree, submodule urls, new branch catalog, and github insteadOf stay on the sink", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-catalog-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const nestedRemote = join(tmp, "nested-remote.git");
  const source = join(tmp, "source");
  await git(["init", "--bare", nestedRemote]);
  await initRepo(source);
  await git(["remote", "add", "origin", "https://ghp_secretTOKEN123@github.com/example/reprise-sink-test.git"], source);
  await git(["config", "remote.origin.pushurl", "https://github.com/example/reprise-sink-test.git"], source);
  const vendor = join(source, "vendor", "mod");
  await initRepo(vendor, nestedRemote);
  const vendorOrigin = await git(["config", "--local", "--get", "remote.origin.url"], vendor);
  const moved = join(source, "vendor", "mod.git");
  await rename(join(vendor, ".git"), moved);
  await writeFile(join(vendor, ".git"), `gitdir: ${moved}\n`);
  await writeFile(join(source, ".gitmodules"), `[submodule "vendor/mod"]\n\tpath = vendor/mod\n\turl = ${vendorOrigin}\n`);
  await git(["config", "submodule.vendor/mod.url", vendorOrigin], source);
  const sinks = join(tmp, "git-sinks", "run-catalog");
  const record = await isolateGitTopology(source, sinks);
  assert.ok(record.repos.some((repo) => repo.relative === "vendor/mod"));
  const origin = await git(["config", "--local", "--get", "remote.origin.url"], source);
  const pushurl = await git(["config", "--local", "--get", "remote.origin.pushurl"], source);
  const submoduleUrl = await git(["config", "--local", "--get", "submodule.vendor/mod.url"], source);
  const modules = await readFile(join(source, ".gitmodules"), "utf8");
  assert.match(origin, /^file:/);
  assert.match(pushurl, /git-sinks/);
  assert.match(submoduleUrl, /git-sinks|file:/);
  assert.match(modules, /git-sinks|file:/);
  assert.doesNotMatch(modules, /nested-remote/);
  const manifest = await readGitSinkManifest(sinks);
  assert.ok(manifest);
  assert.equal(Value.Check(GitSinkManifestSchema, manifest), true);
  const text = `${JSON.stringify(manifest)}\n${await readFile(join(sinks, "INDEX.tsv"), "utf8")}\n${await gitSinkRefsListing(sinks)}`;
  assert.doesNotMatch(text, /ghp_secretTOKEN123/);
  assert.match(await readFile(gitSinkManifestPath(sinks), "utf8"), /initialRefs/);
  await git(["config", "user.email", "harness@test"], source);
  await git(["config", "user.name", "Harness Test"], source);
  await git(["checkout", "-b", "feature-sink"], source);
  await git(["commit", "--allow-empty", "-m", "feature"], source);
  const env = isolateCandidateProcessEnv(process.env, join(tmp, "runs", "run-catalog"));
  await mkdir(join(tmp, "runs", "run-catalog"), { recursive: true });
  await git(["push", "origin", "HEAD:refs/heads/feature-sink"], source, env);
  await git(["push", "https://github.com/example/reprise-sink-test.git", "HEAD:refs/heads/via-github-url"], source, env);
  await git(["remote", "add", "extra", "https://github.com/example/reprise-sink-test.git"], source);
  await git(["push", "extra", "HEAD:refs/heads/via-extra"], source, env);
  const finalized = await finalizeGitSinkCatalog(sinks);
  assert.equal(Value.Check(GitSinkManifestSchema, finalized), true);
  const listing = await gitSinkRefsListing(sinks);
  assert.match(listing, /relative\tsink\tphase\tref\tsha\tobjectStore/);
  assert.match(listing, /feature-sink/);
  const root = finalized.repos.find((repo) => repo.relativePath === ".");
  assert.ok(root?.finalRefs?.some((item) => item.ref === "refs/heads/feature-sink"));
  assert.ok(root?.refChanges?.some((item) => item.kind === "added" && item.ref.includes("feature-sink")));
  assert.ok(root?.initialRefs.some((item) => item.ref === "refs/heads/main"));
});

test("outside gitdir and symlink git are skipped; failed prepare deletes the sink", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-skip-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const outside = join(tmp, "outside");
  await initRepo(outside);
  const source = join(tmp, "source");
  await mkdir(join(source, "escape"), { recursive: true });
  await writeFile(join(source, "escape", ".git"), `gitdir: ${join(outside, ".git")}\n`);
  await mkdir(join(source, "ok"), { recursive: true });
  await initRepo(join(source, "ok"));
  try {
    await symlink(join(outside, ".git"), join(source, "link.git"));
    await mkdir(join(source, "sym"), { recursive: true });
    await symlink(join(outside, ".git"), join(source, "sym", ".git"));
  } catch {
    t.diagnostic("symlink creation unavailable");
  }
  const sinks = join(tmp, "git-sinks", "run-skip");
  const record = await isolateGitTopology(source, sinks);
  assert.ok(record.skipped.some((item) => item.reason === "gitdir_outside"));
  assert.ok(record.repos.some((repo) => repo.relative === "ok"));
  await isolateGitTopology(source, sinks);
  const first = await readGitSinkManifest(sinks);
  const initial = first?.repos.find((repo) => repo.relativePath === "ok")?.initialRefs[0]?.sha;
  await isolateGitTopology(source, sinks);
  const second = await readGitSinkManifest(sinks);
  assert.equal(second?.repos.find((repo) => repo.relativePath === "ok")?.initialRefs[0]?.sha, initial);
  const envRoot = join(tmp, "environment");
  const provider = new LocalWorkspaceProvider(envRoot);
  const broken = join(tmp, "broken-source");
  await mkdir(join(broken, ".git"), { recursive: true });
  await writeFile(join(broken, "README.md"), "no git objects\n");
  await assert.rejects(() => provider.resolveBaseline({ caseId: "case-broken", sourceRoot: broken }, [], {}).then((baseline) => provider.prepareRun(baseline, "run-broken")));
  assert.equal(existsSync(gitSinkRoot(envRoot, "run-broken")), false);
  await isolateGitTopology(join(source, "ok"), sinks);
  await removeGitSink(sinks);
  assert.equal(existsSync(sinks), false);
});

test("corrupted git metadata records failure and is retryable after repair", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-retry-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(tmp, "source");
  await mkdir(source, { recursive: true });
  await mkdir(join(source, ".git"), { recursive: true });
  const sinks = join(tmp, "git-sinks", "run-retry");
  const failed = await isolateGitTopology(source, sinks);
  assert.equal(failed.status === "failed" || failed.status === "partial", true);
  await rm(join(source, ".git"), { recursive: true, force: true });
  await initRepo(source);
  const recovered = await isolateGitTopology(source, sinks);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.repos.length, 1);
});

test("missing origin is created, linked worktree is discovered, and pull of a missing ref fails", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-semantics-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(tmp, "source");
  await initRepo(source);
  const sinks = join(tmp, "git-sinks", "run-sem");
  await isolateGitTopology(source, sinks);
  const origin = await git(["config", "--local", "--get", "remote.origin.url"], source);
  assert.match(origin, /^file:/);
  await git(["worktree", "add", join(source, "linked"), "HEAD"], source);
  const withWorktree = await isolateGitTopology(source, sinks);
  assert.ok(withWorktree.repos.some((repo) => repo.relative === "linked"));
  const env = isolateCandidateProcessEnv(process.env, join(tmp, "runs", "run-sem"));
  await mkdir(join(tmp, "runs", "run-sem"), { recursive: true });
  await git(["fetch", "origin"], source, env);
  await assert.rejects(() => git(["fetch", "origin", "refs/heads/does-not-exist"], source, env));
});

test("relative gitdir traversal is skipped and public catalog omits credentials", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-traverse-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const outside = join(tmp, "outside");
  await initRepo(outside);
  const source = join(tmp, "source");
  await mkdir(join(source, "nested"), { recursive: true });
  await initRepo(join(source, "keep"));
  const gitdir = relative(join(source, "nested"), join(outside, ".git"));
  await writeFile(join(source, "nested", ".git"), `gitdir: ${gitdir}\n`);
  const sinks = join(tmp, "git-sinks", "run-traverse");
  const record = await isolateGitTopology(source, sinks);
  assert.ok(record.skipped.some((item) => item.reason === "gitdir_outside"));
  assert.ok(record.repos.some((repo) => repo.relative === "keep"));
  await git(["remote", "set-url", "origin", "https://user:ghp_secretTOKEN123@github.com/example/repo.git"], join(source, "keep"));
  await isolateGitTopology(join(source, "keep"), sinks);
  const publicText = `${await readFile(gitSinkManifestPath(sinks), "utf8")}\n${await gitSinkRefsListing(sinks)}`;
  assert.doesNotMatch(publicText, /ghp_secretTOKEN123/);
  assert.doesNotMatch(publicText, /GITHUB_TOKEN|GH_TOKEN=/);
});

test("promisor blob:none worktrees rewrite remotes without seeding or throwing schema", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-partial-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(tmp, "source");
  await initRepo(source);
  const nested = join(source, "vendor", "mod");
  await initRepo(nested, undefined, "main");
  await git(["remote", "add", "origin", "https://github.com/example/partial-mod.git"], nested);
  await git(["config", "remote.origin.promisor", "true"], nested);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"], nested);
  const originBefore = await git(["config", "--local", "--get", "remote.origin.url"], nested);
  const sinks = join(tmp, "git-sinks", "run-partial");
  const record = await isolateGitTopology(source, sinks);
  const nestedRecord = record.repos.find((repo) => repo.relative === "vendor/mod");
  assert.ok(nestedRecord);
  assert.equal(nestedRecord.isolation, "rewritten");
  assert.equal(nestedRecord.objectStore, "not_seeded");
  assert.equal(nestedRecord.completeness, "incomplete");
  assert.ok(nestedRecord.issues.some((issue) => issue.code === "incomplete_object_store"));
  assert.equal(record.status, "partial");
  const manifest = await readGitSinkManifest(sinks);
  assert.ok(manifest);
  assert.equal(Value.Check(GitSinkManifestSchema, manifest), true);
  assert.equal(manifest.schemaVersion, 2);
  const originAfter = await git(["config", "--local", "--get", "remote.origin.url"], nested);
  assert.match(originAfter, /^file:/);
  assert.notEqual(originAfter, originBefore);
  const envRoot = join(tmp, "environment");
  const userRoot = join(tmp, "user-source");
  await initRepo(userRoot);
  const userNested = join(userRoot, "vendor", "mod");
  await initRepo(userNested);
  await git(["remote", "add", "origin", "https://github.com/example/partial-mod.git"], userNested);
  await git(["config", "remote.origin.promisor", "true"], userNested);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"], userNested);
  const provider = new LocalWorkspaceProvider(envRoot);
  const staging = await provider.beginRecovery({ caseId: "case-partial", sourceRoot: userRoot });
  const staged = await readGitSinkManifest(gitSinkRoot(envRoot, staging.recoveryId));
  const stagedNested = staged?.repos.find((repo) => repo.relativePath === "vendor/mod");
  assert.equal(stagedNested?.isolation, "rewritten");
  assert.equal(stagedNested?.objectStore, "not_seeded");
  assert.ok(stagedNested?.issues.some((issue) => issue.code === "incomplete_object_store"));
  assert.equal(await git(["config", "--local", "--get", "remote.origin.url"], userNested), "https://github.com/example/partial-mod.git");
  await provider.discardRecovery(staging);
});

test("invalid catalog objects fail Host assert and I1 failure deletes the baseline sink", async (t) => {
  assert.throws(() => assertGitSinkManifest({ schemaVersion: 1 }), /GitSinkManifestSchema/);
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-unprotected-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(tmp, "source");
  await initRepo(source);
  await git(["remote", "add", "origin", "https://github.com/example/unprotected.git"], source);
  await rm(join(source, ".git", "config"));
  await mkdir(join(source, ".git", "config"));
  const envRoot = join(tmp, "environment");
  const provider = new LocalWorkspaceProvider(envRoot);
  await assert.rejects(() => provider.resolveBaseline({ caseId: "case-unprotected", sourceRoot: source }, [], {}));
  assert.equal(existsSync(gitSinkRoot(envRoot, "baseline-case-unprotected")), false);
});

test("v1 catalogs migrate on read", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-v1-"));
  t.after(async () => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const sinks = join(tmp, "git-sinks", "run-v1");
  await mkdir(sinks, { recursive: true });
  await writeFile(gitSinkManifestPath(sinks), `${JSON.stringify({
    schemaVersion: 1,
    sinkId: "run-v1",
    treeRoot: tmp,
    sinkRoot: sinks,
    status: "ready",
    finalized: false,
    repos: [{
      relativePath: ".",
      sinkName: "_root.git",
      sinkPath: join(sinks, "repos", "_root.git"),
      gitDirKind: "directory",
      recordedUrls: ["https://github.com/example/repo.git"],
      initialRefs: [{ ref: "refs/heads/main", sha: "a".repeat(40) }],
      errors: [],
    }],
    skipped: [],
    errors: [],
  }, null, 2)}\n`);
  const migrated = await readGitSinkManifest(sinks);
  assert.equal(migrated?.schemaVersion, 2);
  assert.equal(migrated?.repos[0]?.isolation, "rewritten");
  assert.equal(migrated?.repos[0]?.objectStore, "seeded");
  assert.equal(Value.Check(GitSinkManifestSchema, migrated), true);
});
