import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalWorkspaceProvider } from "../../src/environment/local-workspace-provider.js";
import { copyTree } from "../../src/environment/local-workspace-fs.js";
import { workspaceTools, SOURCE_MOUNT } from "../../src/infrastructure/recovery-tools.js";
import { SNAPSHOT_LIMITS } from "../../src/environment/snapshots.js";
import { preflightFromBaseline } from "../../src/application/experiment-preflight.js";

const exec = promisify(execFile);

async function overwriteEvenIfLocked(root: string, filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
  }
  const icacls = join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "icacls.exe");
  await exec(icacls, [root, "/remove:d", "*S-1-1-0", "/T", "/C", "/Q"], { windowsHide: true });
  await writeFile(filePath, content);
}

test("over-budget source starts sparse staging instead of failing Recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-sparse-provider-"));
  const source = await mkdtemp(join(tmpdir(), "reprise-sparse-source-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await mkdir(join(source, "apps", "desktop", "src"), { recursive: true });
  await writeFile(join(source, "apps", "desktop", "src", "ui.ts"), "export const page = 1;\n");
  await mkdir(join(source, "node_modules", "leftpad"), { recursive: true });
  await writeFile(join(source, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
  await writeFile(join(source, "package.json"), '{"name":"app"}\n');
  const provider = new LocalWorkspaceProvider(root, copyTree, {
    files: 2,
    totalBytes: SNAPSHOT_LIMITS.totalBytes,
    fileBytes: SNAPSHOT_LIMITS.fileBytes,
  });
  const inspected = await provider.inspectBaseline({ caseId: "case-sparse", sourceRoot: source }, [], {});
  assert.ok(inspected.budget.blockedReasons.length > 0);
  assert.equal(inspected.readiness.runnable, "isolated");
  assert.deepEqual(inspected.readiness.blockingResourceIds, []);
  const preflight = preflightFromBaseline(inspected, {
    productId: "codex",
    executable: "codex",
    requestedModel: "gpt-5",
    resolvedModel: "gpt-5",
  });
  assert.equal(preflight.sourceBaseline, "available");
  assert.equal(preflight.comparisonClass, "observational");
  const staging = await provider.beginRecovery({ caseId: "case-sparse", sourceRoot: source });
  assert.equal(staging.workspaceSeed, "sparse");
  assert.equal(staging.sourceSummary.budgetExceeded, true);
  await assert.rejects(stat(join(staging.root, "node_modules")));
  await assert.rejects(stat(join(staging.root, "package.json")));
  assert.match(
    await readFile(join(staging.root, ".reprise", "recovery-work", "source-summary.json"), "utf8"),
    /node_modules/,
  );
  const names = await readdir(staging.root);
  assert.deepEqual(names.filter((name) => name !== ".reprise"), []);
  const tools = workspaceTools(staging.root, {
    workspaceAlias: true,
    mounts: { [SOURCE_MOUNT]: staging.sourceRoot },
    denyDestructiveOnPrefix: [SOURCE_MOUNT],
    allowShell: true,
    shellEnv: { REPRISE_SOURCE_MOUNT: staging.sourceRoot },
  });
  const read = tools.find((item) => item.name === "read");
  const write = tools.find((item) => item.name === "write");
  const shell = tools.find((item) => item.name === "shell_exec");
  assert.ok(read && write && shell);
  const signal = new AbortController().signal;
  const deep = await read.execute({ path: "source/apps/desktop/src/ui.ts" }, signal);
  assert.match(deep.content, /export const page/);
  await write.execute({ path: "workspace/apps/desktop/src/ui.ts", content: deep.content }, signal);
  assert.equal(await readFile(join(staging.root, "apps", "desktop", "src", "ui.ts"), "utf8"), deep.content);
  await assert.rejects(stat(join(staging.root, "node_modules")));
  await writeFile(join(staging.root, "recovery.md"), "# ready\r\n");
  const preview = await provider.validateRecovery(staging, {
    status: "ready",
    summary: "Ready for the original task.",
    reportPath: "recovery.md",
    unresolved: ["node_modules was not copied"],
  });
  assert.equal(preview.baseline.readiness.runnable, "isolated");
  assert.equal(preview.baseline.fingerprint.resources.some((item) => item.path.includes("node_modules")), false);
  assert.ok(preview.baseline.fingerprint.resources.some((item) => item.path === "apps/desktop/src/ui.ts"));
  const accepted = await provider.acceptRecovery(preview);
  const runA = await provider.prepareRun(accepted, "run-a");
  const runB = await provider.prepareRun(accepted, "run-b");
  assert.equal(await readFile(join(runA.root, "apps", "desktop", "src", "ui.ts"), "utf8"), deep.content);
  await writeFile(join(runA.root, "apps", "desktop", "src", "ui.ts"), "changed");
  assert.equal(await readFile(join(runB.root, "apps", "desktop", "src", "ui.ts"), "utf8"), deep.content);
  assert.equal(await readFile(join(source, "apps", "desktop", "src", "ui.ts"), "utf8"), "export const page = 1;\n");
});

test("source tripwire still discards staging when the real user directory changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-sparse-tripwire-"));
  const source = await mkdtemp(join(tmpdir(), "reprise-sparse-tripwire-source-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "a.txt"), "a");
  await writeFile(join(source, "b.txt"), "b");
  await writeFile(join(source, "c.txt"), "c");
  const provider = new LocalWorkspaceProvider(root, copyTree, {
    files: 2,
    totalBytes: SNAPSHOT_LIMITS.totalBytes,
    fileBytes: SNAPSHOT_LIMITS.fileBytes,
  });
  const staging = await provider.beginRecovery({ caseId: "case-tripwire", sourceRoot: source });
  assert.equal(staging.workspaceSeed, "sparse");
  await overwriteEvenIfLocked(source, join(source, "a.txt"), "mutated");
  await writeFile(join(staging.root, "recovery.md"), "# ready\r\n");
  await assert.rejects(
    provider.probeRecovery(staging),
    /source directory/,
  );
});

test("raising copy limits is not the sparse-source admission path", async () => {
  assert.equal(SNAPSHOT_LIMITS.files, 50_000);
  assert.equal(SNAPSHOT_LIMITS.totalBytes, 1024 * 1024 * 1024);
});
