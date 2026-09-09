import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryTools } from "../src/infrastructure/recovery-tools.js";
import { recoveryToolFailureCategory } from "../src/application/recovery/run-preflight.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-limits-"));
  await writeFile(join(root, "input.txt"), "original\r\n");
  return root;
}

test("workspace tools do not cap investigation or destructive shell_exec calls", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tools = recoveryTools(root, { allowShell: true });
  const shell = tools.find((item) => item.name === "shell_exec");
  const list = tools.find((item) => item.name === "ls");
  const report = tools.find((item) => item.name === "write");
  assert.ok(shell);
  assert.ok(list);
  assert.ok(report);
  const signal = new AbortController().signal;
  for (let index = 0; index < 17; index += 1) {
    const path = `scratch-${index}.txt`;
    await writeFile(join(root, path), "x\n");
    await shell.execute({ command: `Remove-Item -LiteralPath ${path}` }, signal);
    await list.execute({}, signal);
  }
  await report.execute({ path: "recovery.md", content: "# Recovery\n" }, signal);
});

test("identical ls calls are not rejected", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const list = recoveryTools(root).find((item) => item.name === "ls");
  assert.ok(list);
  const signal = new AbortController().signal;
  await list.execute({}, signal);
  await list.execute({}, signal);
});

test("old tool names are not registered", () => {
  const names = recoveryTools(".").map((item) => item.name);
  for (const name of ["delete_file", "list_dir", "write_file", "write_recovery_manifest", "staging_shell"]) {
    assert.equal(names.includes(name), false, name);
  }
});

test("legacy budget messages still classify as budget_exhausted", () => {
  assert.equal(
    recoveryToolFailureCategory({
      message: "recovery_no_information_gain: destructive change budget of 16 was exhausted.",
    }),
    "budget_exhausted",
  );
  assert.equal(
    recoveryToolFailureCategory({ message: "Recovery tool-call budget of 64 was exhausted." }),
    "budget_exhausted",
  );
});



