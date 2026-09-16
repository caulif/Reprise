import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

async function loadNpmCli() {
  return import(pathToFileURL(join(process.cwd(), "scripts/npm-cli.mjs")).href) as Promise<{
    npmCliCandidates: (execPath: string) => string[];
    resolveNpmCliJs: (execPath?: string) => string;
    selfTestNpmCli: () => void;
  }>;
}

test("npm-cli resolver covers Windows and Unix hostedtoolcache layouts", async () => {
  const { selfTestNpmCli, resolveNpmCliJs } = await loadNpmCli();
  selfTestNpmCli();
  assert.match(resolveNpmCliJs(), /npm-cli\.js$/);
});
