import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();

test("published pack-api export resolves from dist without source paths", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  assert.equal(pkg.exports?.["./pack-api"], "./dist/src/products/contract.js");
  const href = pathToFileURL(join(root, "dist/src/products/contract.js")).href;
  const api = await import(href) as { PACK_API_MAJOR?: number };
  assert.equal(api.PACK_API_MAJOR, 1);
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const packed = await exec(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const parsed: unknown = JSON.parse(packed.stdout);
  const paths = packedFilePaths(parsed);
  assert.ok(paths.includes("dist/src/products/contract.js"));
  assert.equal(paths.some((path) => path.startsWith("src/")), false);
});

function packedFilePaths(value: unknown): string[] {
  const record: unknown = Array.isArray(value) ? value[0] : value;
  if (!record || typeof record !== "object" || !("files" in record)) return [];
  const files = record.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file: unknown) => {
    if (typeof file === "string") return [file.replaceAll("\\", "/")];
    if (file && typeof file === "object" && "path" in file && typeof file.path === "string") {
      return [file.path.replaceAll("\\", "/")];
    }
    return [];
  });
}
