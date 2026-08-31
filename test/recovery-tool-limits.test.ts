import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryTools } from "../src/infrastructure/recovery-tools.js";
import { recoveryToolFailureCategory } from "../src/application/experiment-recovery-run-preflight.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-limits-"));
  await writeFile(join(root, "input.txt"), "original\r\n");
  return root;
}

test("destructive powershell stops after 16 calls without blocking ls", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tools = recoveryTools(root, 64);
  const shell = tools.find((item) => item.name === "powershell");
  const list = tools.find((item) => item.name === "ls");
  const report = tools.find((item) => item.name === "write");
  assert.ok(shell);
  assert.ok(list);
  assert.ok(report);
  const signal = new AbortController().signal;
  for (let index = 0; index < 16; index += 1) {
    const path = `scratch-${index}.txt`;
    await writeFile(join(root, path), "x\n");
    await shell.execute({ command: `Remove-Item -LiteralPath ${path}` }, signal);
    if (index === 0) await list.execute({}, signal);
  }
  await writeFile(join(root, "scratch-16.txt"), "x\n");
  await assert.rejects(
    shell.execute({ command: "Remove-Item -LiteralPath scratch-16.txt" }, signal),
    /destructive change budget of 16/i,
  );
  await list.execute({}, signal);
  await report.execute({ path: "recovery.md", content: "# Recovery\n" }, signal);
});

test("destructive cap does not consume the investigation budget", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tools = recoveryTools(root, 16);
  const shell = tools.find((item) => item.name === "powershell");
  const report = tools.find((item) => item.name === "write");
  assert.ok(shell);
  assert.ok(report);
  const signal = new AbortController().signal;
  for (let index = 0; index < 16; index += 1) {
    const path = `scratch-${index}.txt`;
    await writeFile(join(root, path), "x\n");
    await shell.execute({ command: `Remove-Item -LiteralPath ${path}` }, signal);
  }
  await writeFile(join(root, "scratch-16.txt"), "x\n");
  await assert.rejects(
    shell.execute({ command: "Remove-Item -LiteralPath scratch-16.txt" }, signal),
    /destructive change budget of 16/i,
  );
  await report.execute({ path: "recovery.md", content: "# Recovery\n" }, signal);
});

test("investigation budget exhaustion still fails powershell", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tools = recoveryTools(root, 16);
  const shell = tools.find((item) => item.name === "powershell");
  const list = tools.find((item) => item.name === "ls");
  assert.ok(shell);
  assert.ok(list);
  const signal = new AbortController().signal;
  for (let index = 0; index < 16; index += 1) {
    await list.execute({ path: `missing-${index}` }, signal);
  }
  await assert.rejects(
    shell.execute({ command: "Write-Output ok" }, signal),
    /tool-call budget of 16/i,
  );
});

test("old tool names are not registered", () => {
  const names = recoveryTools(".").map((item) => item.name);
  for (const name of ["delete_file", "list_dir", "write_file", "write_recovery_manifest", "staging_shell"]) {
    assert.equal(names.includes(name), false, name);
  }
});

test("destructive and investigation budget messages classify as budget_exhausted", () => {
  assert.equal(
    recoveryToolFailureCategory({
      message: "recovery_no_information_gain: destructive change budget of 16 was exhausted.",
    }),
    "budget_exhausted",
  );
  assert.equal(
    recoveryToolFailureCategory({
      message: "recovery_no_information_gain: delete_file budget of 16 was exhausted.",
    }),
    "budget_exhausted",
  );
  assert.equal(
    recoveryToolFailureCategory({ message: "Recovery tool-call budget of 64 was exhausted." }),
    "budget_exhausted",
  );
});
