import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverExecutable } from "../src/products/shared/process.js";

test("POSIX executable discovery rejects a non-executable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-discovery-"));
  const file = join(root, "tool");
  try {
    await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(file, 0o644);
    assert.equal(await discoverExecutable({ command: "tool", env: { PATH: root }, platform: "linux" }), undefined);
    await chmod(file, 0o755);
    if (process.platform !== "win32") assert.equal(await discoverExecutable({ command: "tool", env: { PATH: root }, platform: "linux" }), file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
