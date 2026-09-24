import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import { ExtractedContentSchema } from "../../src/infrastructure/content-extraction.js";

test("comparison shell invokes the current extraction CLI without a global reprise command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-extract-shell-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "sample.csv"), "name,value\nitem,7\n");
  const shell = workspaceTools(root, { role: "comparison", allowShell: true, shellCwd: root,
    homeRoot: join(root, ".home"), shellEnv: {
      REPRISE_CLI_PATH: fileURLToPath(new URL("../../src/cli/main.js", import.meta.url)),
      REPRISE_NODE_PATH: process.execPath,
    } }).find((item) => item.name === "shell_exec");
  assert.ok(shell);
  const command = process.platform === "win32"
    ? "& $env:REPRISE_NODE_PATH $env:REPRISE_CLI_PATH extract sample.csv --output extracted.json"
    : '"$REPRISE_NODE_PATH" "$REPRISE_CLI_PATH" extract sample.csv --output extracted.json';
  const result = await shell.execute({ command }, new AbortController().signal);
  assert.match(result.content, /"ok":true/);
  const extracted: unknown = JSON.parse(await readFile(join(root, "extracted.json"), "utf8"));
  assert.ok(Value.Check(ExtractedContentSchema, extracted));
  assert.deepEqual(extracted.fragments[3], { location: "row 2, column 2", text: "7" });
});
