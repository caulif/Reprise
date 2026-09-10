import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LocalWorkspaceProvider } from "../../src/environment/local-workspace-provider.js";
import { gitSinkRoot, isolateGitTopology } from "../../src/environment/git-sink.js";
import { isolateCandidateProcessEnv } from "../../src/infrastructure/process/spawn.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: env ?? process.env });
  return stdout.trim();
}

async function initRepo(root: string, origin: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await git(["init", "-b", "main"], root);
  await git(["config", "user.email", "harness@test"], root);
  await git(["config", "user.name", "Harness Test"], root);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(["add", "."], root);
  await git(["commit", "-m", "init"], root);
  await git(["remote", "add", "origin", origin], root);
  await git(["push", "-u", "origin", "HEAD"], root);
  return git(["--git-dir", origin, "rev-parse", "refs/heads/main"]);
}

test("prepareRun retargets nested origin to a harness sink and does not advance the user remote", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-sink-"));
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
  const replicaOrigin = await git(["config", "--local", "--get", "remote.origin.url"], environment.root);
  const nestedOrigin = await git(["config", "--local", "--get", "remote.origin.url"], join(environment.root, "caulif"));
  const replicaPush = await git(["config", "--local", "--get", "remote.origin.pushurl"], environment.root);
  assert.notEqual(replicaOrigin, userRemote);
  assert.notEqual(replicaOrigin, pathToFileURL(userRemote).href);
  assert.notEqual(nestedOrigin, nestedRemote);
  assert.notEqual(replicaPush, userRemote);
  assert.match(replicaPush, /git-sinks/);
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

test("isolateGitTopology is a no-op without git metadata", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-empty-"));
  const record = await isolateGitTopology(tmp, join(tmp, "sinks"));
  assert.equal(record.repos.length, 0);
});

test("isolateCandidateProcessEnv drops GitHub tokens and loads sink gitconfig", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "reprise-git-env-"));
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
  assert.equal(env.HOME, "keep-home");
  assert.equal(env.USERPROFILE, "keep-profile");
});
