#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE(?:\.md)?$/,
  /^dist\/src\//,
];
const FORBIDDEN = /^(?:src|test|docs|scripts|\.reprise)\//;

export function packedPathAllowed(path) {
  const normalized = normalizePackedPath(path);
  if (FORBIDDEN.test(normalized) && !normalized.startsWith("dist/src/")) return false;
  return ALLOWED.some((pattern) => pattern.test(normalized));
}

export function checkPackedPaths(paths) {
  return paths.filter((path) => !packedPathAllowed(path));
}

export function normalizePackedPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function checkRequiredPackedPaths(paths, options = {}) {
  const files = paths.map(normalizePackedPath);
  const set = new Set(files);
  const errors = [];
  for (const name of ["package.json", "README.md"]) {
    if (!set.has(name)) errors.push(`缺少 ${name}`);
  }
  if (!set.has("LICENSE") && !set.has("LICENSE.md")) errors.push("缺少 LICENSE");
  const binTarget = normalizePackedPath(options.binTarget ?? "dist/src/cli/main.js");
  if (!set.has(binTarget)) errors.push(`缺少 bin 目标 ${binTarget}`);
  if (!files.some((path) => path.startsWith("dist/src/"))) errors.push("缺少 dist/src/ 文件");
  return errors;
}

function npmCli() {
  return join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

function readBinTarget() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const bin = pkg.bin?.reprise;
  if (typeof bin !== "string" || !bin.trim()) throw new Error("package.json.bin.reprise 缺失");
  return normalizePackedPath(bin);
}

function listPackedFiles() {
  const output = execFileSync(execPath, [npmCli(), "pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = record?.files;
  if (!Array.isArray(files)) throw new Error("npm pack --json 未返回 files");
  return files.map((file) => (typeof file === "string" ? file : file.path));
}

function selfTest() {
  const leaked = checkPackedPaths(["package.json", "src/cli/main.ts", "docs/secret.md"]);
  if (!leaked.includes("src/cli/main.ts") || !leaked.includes("docs/secret.md")) {
    throw new Error("pack allowlist 应当拒绝源码与 docs");
  }
  if (checkPackedPaths(["package.json", "README.md", "LICENSE", "dist/src/cli/main.js"]).length) {
    throw new Error("pack allowlist 应当接受发布清单");
  }
  const shell = checkRequiredPackedPaths(["package.json", "README.md", "LICENSE"]);
  if (!shell.some((error) => error.includes("bin 目标")) || !shell.some((error) => error.includes("dist/src/"))) {
    throw new Error("只有三个元数据文件的空壳包必须失败");
  }
  const missingBin = checkRequiredPackedPaths(
    ["package.json", "README.md", "LICENSE", "dist/src/other.js"],
    { binTarget: "dist/src/cli/main.js" },
  );
  if (!missingBin.some((error) => error.includes("dist/src/cli/main.js"))) {
    throw new Error("bin 指向不存在文件时必须失败");
  }
  const complete = checkRequiredPackedPaths(["package.json", "README.md", "LICENSE", "dist/src/cli/main.js"]);
  if (complete.length) {
    throw new Error(`完整发布清单不应当失败: ${complete.join("; ")}`);
  }
  console.log("verify-pack self-test: 坏包路径、空壳包与缺 bin 包被拒绝");
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const binTarget = readBinTarget();
  const files = listPackedFiles();
  const rejected = checkPackedPaths(files);
  if (rejected.length) {
    console.error(`verify-pack: 发布包含有非允许路径:\n${rejected.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const missing = checkRequiredPackedPaths(files, { binTarget });
  if (missing.length) {
    console.error(`verify-pack: 发布包缺少必需路径:\n${missing.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`verify-pack: ok (${files.length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
