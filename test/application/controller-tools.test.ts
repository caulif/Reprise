import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  controllerDecisionTools,
  controllerProjectWriteAllowed,
  controllerReadEvidenceSource,
  createControllerToolBindings,
  shellExternalWriteRefs,
} from "../../src/application/controller-tools.js";
import type { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-tools-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  const sourceRoot = join(root, "source");
  await mkdir(join(briefingRoot, "run"), { recursive: true });
  await mkdir(replicaRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(briefingRoot, "INDEX.md"), "index\n");
  const events: unknown[] = [];
  const artifacts: { artifactId: string; runId: string }[] = [];
  const store = {
    commitArtifact: async (input: { artifactId: string; runId: string }) => {
      artifacts.push(input);
    },
    append: async (event: unknown) => {
      events.push(event);
      return event;
    },
  } as unknown as ExperimentStore;
  const bindings = createControllerToolBindings();
  bindings.requestId = "controller-request-run-1-1";
  const tools = controllerDecisionTools(
    {
      store,
      runId: "run-1",
      experimentRoot: root,
      environment: { root: replicaRoot },
      sourceRoot,
      taskCase: { privacy: { allowBinary: false } },
    },
    briefingRoot,
    bindings,
  );
  return { root, briefingRoot, replicaRoot, sourceRoot, events, artifacts, store, bindings, tools };
}

test("controllerProjectWriteAllowed allows files under project/ and notes/", () => {
  assert.equal(controllerProjectWriteAllowed("project/a.txt"), true);
  assert.equal(controllerProjectWriteAllowed("notes/understanding.md"), true);
  assert.equal(controllerProjectWriteAllowed("project"), false);
  assert.equal(controllerProjectWriteAllowed("notes"), false);
  assert.equal(controllerProjectWriteAllowed("INDEX.md"), false);
  assert.equal(controllerProjectWriteAllowed("history/user-inputs/a.txt"), false);
  assert.equal(controllerProjectWriteAllowed("project-evil/a.txt"), false);
  assert.equal(controllerProjectWriteAllowed("notes-evil/a.txt"), false);
});

test("reads classify briefing, replica, and external paths without gating on changedPaths", () => {
  const bindings = createControllerToolBindings();
  assert.equal(controllerReadEvidenceSource("history/user-inputs/INDEX.tsv", bindings), "briefing_read");
  assert.equal(controllerReadEvidenceSource("project/out/report.pdf", bindings), "workspace_read");
  assert.equal(controllerReadEvidenceSource("project/secret.bin", bindings), "workspace_read");
  assert.equal(controllerReadEvidenceSource("run/turns/0001/visible.txt", bindings), "briefing_read");
  bindings.phase = "steering";
  bindings.settledTurnCount = 1;
  assert.equal(controllerReadEvidenceSource("run/turns/0001/visible.txt", bindings), "workspace_read");
  assert.equal(controllerReadEvidenceSource("C:\\other\\session.jsonl", bindings), "external_read");
});

test("Controller registers shell_exec, writes project, and rejects briefing", async () => {
  const ctx = await fixture();
  try {
    assert.equal(ctx.tools.some((tool) => tool.name === "shell_exec"), true);
    const write = ctx.tools.find((tool) => tool.name === "write");
    assert.ok(write);
    const signal = new AbortController().signal;
    await assert.rejects(() => write.execute({ path: "INDEX.md", content: "no" }, signal), /write_denied/);
    await assert.rejects(() => write.execute({ path: "history/user-inputs/a.txt", content: "no" }, signal), /write_denied/);
    const notes = await write.execute({ path: "notes/understanding.md", content: "task goal" }, signal);
    assert.match(notes.content, /Wrote/);
    const written = await write.execute({ path: "project/note.txt", content: "user edit" }, signal);
    assert.match(written.content, /Wrote/);
    assert.equal(
      ctx.events.some((event) => (event as { type?: string }).type === "controller.workspace_write"),
      true,
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("Controller read/ls/grep/find can use host-readable paths outside project/", async () => {
  const ctx = await fixture();
  try {
    const outsideDir = join(ctx.root, "history-sessions");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "session.jsonl"), "needle-from-history\n");
    const signal = new AbortController().signal;
    const read = ctx.tools.find((tool) => tool.name === "read");
    const ls = ctx.tools.find((tool) => tool.name === "ls");
    const grep = ctx.tools.find((tool) => tool.name === "grep");
    const find = ctx.tools.find((tool) => tool.name === "find");
    assert.ok(read && ls && grep && find);
    const got = await read.execute({ path: join(outsideDir, "session.jsonl") }, signal);
    assert.match(got.content, /needle-from-history/);
    const listed = await ls.execute({ path: outsideDir }, signal);
    assert.match(listed.content, /session\.jsonl/);
    const grepped = await grep.execute({ query: "needle-from-history", path: outsideDir }, signal);
    assert.match(grepped.content, /needle-from-history/);
    const found = await find.execute({ name: "session.jsonl", path: outsideDir }, signal);
    assert.match(found.content, /session\.jsonl/);
    const readEvent = ctx.events.find((event) => (event as { type?: string }).type === "controller.observation_read") as
      | { payload?: { source?: string; evidenceRefs?: string[]; runId?: string } }
      | undefined;
    assert.equal(readEvent?.payload?.source, "external_read");
    assert.equal(readEvent?.payload?.runId, "run-1");
    assert.equal(readEvent?.payload?.evidenceRefs?.[0]?.startsWith("artifact:"), true);
    assert.equal(ctx.artifacts.every((item) => item.runId === "run-1"), true);
    const details = got.details as { evidenceRefs?: string[]; runId?: string };
    assert.equal(details.runId, "run-1");
    assert.deepEqual(details.evidenceRefs, readEvent?.payload?.evidenceRefs);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("Windows absolute paths succeed and WSL-style paths return a diagnostic reason", async () => {
  const ctx = await fixture();
  try {
    const absolute = join(ctx.root, "abs.txt");
    await writeFile(absolute, "abs-ok\n");
    const signal = new AbortController().signal;
    const read = ctx.tools.find((tool) => tool.name === "read");
    assert.ok(read);
    const got = await read.execute({ path: resolve(absolute) }, signal);
    assert.match(got.content, /abs-ok/);
    const wsl = await read.execute({ path: "/mnt/c/reprise-missing-wsl-path.txt" }, signal);
    const details = wsl.details as { available?: boolean; reason?: string };
    assert.equal(details.available, false);
    assert.equal(details.reason, "wsl_unavailable");
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("large, binary, and credential files keep read boundaries", async () => {
  const ctx = await fixture();
  try {
    const signal = new AbortController().signal;
    const read = ctx.tools.find((tool) => tool.name === "read");
    const grep = ctx.tools.find((tool) => tool.name === "grep");
    assert.ok(read && grep);
    const big = join(ctx.root, "big.txt");
    await writeFile(big, `${"a".repeat(70_000)}TAIL`);
    const sliced = await read.execute({ path: big, maxBytes: 16 }, signal);
    const slicedDetails = sliced.details as { truncated?: boolean };
    assert.equal(sliced.content, "a".repeat(16));
    assert.equal(slicedDetails.truncated, true);
    const binary = join(ctx.root, "blob.bin");
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await assert.rejects(
      () => read.execute({ path: binary, format: "image", mimeType: "image/png" }, signal),
      /binary_read_denied/,
    );
    const grepped = await grep.execute({ query: "nope", path: binary }, signal);
    assert.equal(grepped.content, "[]");
    const secret = join(ctx.root, ".env");
    await writeFile(secret, "TOKEN=do-not-read");
    await assert.rejects(() => read.execute({ path: secret }, signal), /credential_read_denied/);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("Controller shell_exec uses replica cwd, can read external paths, and diagnoses failures", async () => {
  const ctx = await fixture();
  try {
    const marker = join(ctx.root, "external-marker.txt");
    await writeFile(marker, "from-outside\n");
    const signal = new AbortController().signal;
    const shell = ctx.tools.find((tool) => tool.name === "shell_exec");
    assert.ok(shell);
    const cwd = await shell.execute({ command: "(Get-Location).Path" }, signal);
    assert.match(cwd.content.replaceAll("/", "\\"), new RegExp(ctx.replicaRoot.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "i"));
    const escaped = marker.replaceAll("'", "''");
    const external = await shell.execute({ command: `Get-Content -LiteralPath '${escaped}'` }, signal);
    assert.match(external.content, /from-outside/);
    assert.doesNotMatch(external.content, /slash-separated relative path/);
    const nonzero = await shell.execute({ command: "exit 9" }, signal);
    assert.equal((nonzero.details as { exitCode?: number }).exitCode, 9);
    const missing = await shell.execute({ command: "& 'C:\\reprise-missing-shell-exec.exe'" }, signal);
    assert.notEqual((missing.details as { exitCode?: number }).exitCode, 0);
    const timed = workspaceTools(ctx.briefingRoot, {
      allowShell: true,
      unrestrictedRead: true,
      shellCwd: ctx.replicaRoot,
      shellTimeoutMs: 100,
    }).find((tool) => tool.name === "shell_exec");
    assert.ok(timed);
    await assert.rejects(
      () => timed.execute({ command: "Start-Sleep -Seconds 5" }, signal),
      /timed out/i,
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("Controller shell_exec rejects writes to the historical source root", async () => {
  const ctx = await fixture();
  try {
    const shell = ctx.tools.find((tool) => tool.name === "shell_exec");
    assert.ok(shell);
    const signal = new AbortController().signal;
    await assert.rejects(
      () => shell.execute({ command: `Set-Content -LiteralPath '${ctx.sourceRoot}\\blocked.txt' -Value blocked` }, signal),
      /read-only mount|write_denied/,
    );
    assert.equal((await readFile(join(ctx.sourceRoot, "blocked.txt")).catch(() => "")), "");
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("shell external writes are audited as controller.external_write, not workspace_write", async () => {
  const ctx = await fixture();
  try {
    const outside = join(ctx.root, "shell-out.txt");
    const signal = new AbortController().signal;
    const shell = ctx.tools.find((tool) => tool.name === "shell_exec");
    const write = ctx.tools.find((tool) => tool.name === "write");
    assert.ok(shell && write);
    const escaped = outside.replaceAll("'", "''");
    await assert.rejects(
      () => shell.execute({ command: `Set-Content -LiteralPath '${escaped}' -Value 'external'` }, signal),
      /read-only mount|write_denied/i,
    );
    const types = ctx.events.map((event) => (event as { type?: string }).type);
    assert.equal(types.includes("controller.external_write"), false);
    assert.equal(types.includes("controller.workspace_write"), false);
    await write.execute({ path: "project/from-host.txt", content: "host" }, signal);
    assert.equal(
      ctx.events.filter((event) => (event as { type?: string }).type === "controller.workspace_write").length,
      1,
    );
    await assert.rejects(
      () => shell.execute({ command: "Set-Content -LiteralPath replica-shell.txt -Value 'in-copy'" }, signal),
      /read-only mount|write_denied/i,
    );
    assert.equal(
      ctx.events.filter((event) => (event as { type?: string }).type === "controller.workspace_write").length,
      1,
    );
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("edit/write still reject source, briefing, absolute, traversal, and junction escape", async () => {
  const ctx = await fixture();
  try {
    const source = join(ctx.root, "user-source", "keep.txt");
    await mkdir(join(ctx.root, "user-source"));
    await writeFile(source, "original\n");
    const signal = new AbortController().signal;
    const write = ctx.tools.find((tool) => tool.name === "write");
    const edit = ctx.tools.find((tool) => tool.name === "edit");
    assert.ok(write && edit);
    await write.execute({ path: "project/keep.txt", content: "replica\n" }, signal);
    await assert.rejects(() => write.execute({ path: source, content: "no" }, signal), /write_denied|relative path/);
    await assert.rejects(() => write.execute({ path: "INDEX.md", content: "no" }, signal), /write_denied/);
    await assert.rejects(() => write.execute({ path: "../user-source/keep.txt", content: "no" }, signal), /write_denied|relative path|escapes/);
    await assert.rejects(() => edit.execute({ path: source, oldText: "original", newText: "no" }, signal), /write_denied|relative path/);
    assert.equal(await readFile(source, "utf8"), "original\n");
    try {
      await symlink(join(ctx.root, "user-source"), join(ctx.replicaRoot, "escape"), "junction");
    } catch {
      return;
    }
    await assert.rejects(
      () => write.execute({ path: "project/escape/keep.txt", content: "no" }, signal),
      /symbolic|write_denied|escapes|junction/i,
    );
    assert.equal(await readFile(source, "utf8"), "original\n");
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("unrestricted reads do not loosen Recovery default containment or write policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-unrestricted-read-"));
  try {
    await writeFile(join(root, "inside.txt"), "in\n");
    const outside = join(root, "..", `outside-${Date.now()}.txt`);
    await writeFile(outside, "out\n");
    const signal = new AbortController().signal;
    const contained = workspaceTools(root).find((tool) => tool.name === "read");
    assert.ok(contained);
    await assert.rejects(() => contained.execute({ path: resolve(outside) }, signal), /relative path/);
    const open = workspaceTools(root, { unrestrictedRead: true }).find((tool) => tool.name === "read");
    const write = workspaceTools(root, { unrestrictedRead: true }).find((tool) => tool.name === "write");
    assert.ok(open && write);
    const got = await open.execute({ path: resolve(outside) }, signal);
    assert.match(got.content, /out/);
    await assert.rejects(() => write.execute({ path: resolve(outside), content: "no" }, signal), /relative path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shellExternalWriteRefs ignore replica-relative writes", () => {
  const replica = "C:\\exp\\replica";
  const briefing = "C:\\exp\\briefing";
  assert.deepEqual(shellExternalWriteRefs("Set-Content note.txt x", replica, briefing), []);
  const refs = shellExternalWriteRefs(`Set-Content -LiteralPath 'D:\\other\\x.txt' -Value z`, replica, briefing);
  assert.equal(refs[0]?.pathClass, "absolute");
  assert.match(refs[0]?.pathRef ?? "", /x\.txt/);
});
