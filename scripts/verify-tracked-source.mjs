#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function posixPath(path) {
  return path.replaceAll("\\", "/");
}

export function ignoredTypescriptInSourceTrees(names) {
  return names
    .map(posixPath)
    .filter((name) => (name.startsWith("src/") || name.startsWith("test/")) && name.endsWith(".ts"));
}

export function resolveRelativeTypescript(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = dirname(posixPath(fromFile));
  const trimmed = specifier.replace(/\.js$/u, "");
  const resolved = posixPath(join(fromDir, trimmed));
  if (extname(resolved) === ".ts") return resolved;
  return `${resolved}.ts`;
}

export function untrackedRelativeImports(fromFile, source, isTracked) {
  const errors = [];
  for (const pattern of [
    /\bfrom\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']/g,
    /^\s*import\s+["'](\.[^"']+)["']/gm,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const target = resolveRelativeTypescript(fromFile, match[1]);
      if (target && (target.startsWith("src/") || target.startsWith("test/")) && !isTracked(target)) {
        errors.push(`${fromFile} 相对导入 ${match[1]} 指向不受 Git 控制的 ${target}`);
      }
    }
  }
  return errors;
}

export function forbiddenSourceExcludes(exclude) {
  return exclude.filter((entry) => {
    const path = posixPath(entry);
    return path === "src" || path.startsWith("src/") || path === "test" || path.startsWith("test/");
  });
}

export function jscpdIgnorePatterns(script) {
  const match = script.match(/--ignore\s+(\S+)/);
  return match ? match[1].split(",") : [];
}

export function ignorePatternExists(root, pattern) {
  const posix = posixPath(pattern);
  if (!posix.includes("*")) return existsSync(join(root, posix));
  const dir = dirname(posix);
  const name = posix.slice(dir.length + (dir === "." ? 0 : 1));
  const escaped = name.replaceAll(".", "\\.").replaceAll("*", ".*");
  try {
    return readdirSync(join(root, dir)).some((entry) => new RegExp(`^${escaped}$`).test(entry));
  } catch {
    return false;
  }
}

export function staleControlledIgnores(root, patterns) {
  return patterns
    .map(posixPath)
    .filter((pattern) => pattern.startsWith("src/") || pattern.startsWith("test/"))
    .filter((pattern) => !ignorePatternExists(root, pattern));
}

export async function eslintIgnoredTrackedSource(cwd, files) {
  const eslint = new ESLint({ cwd });
  const hidden = [];
  for (const file of files) {
    if (await eslint.isPathIgnored(file)) hidden.push(posixPath(file));
  }
  return hidden;
}

function gitZ(root, args) {
  const output = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return output ? output.split("\0").filter(Boolean) : [];
}

function writeTempEslintProject(config) {
  const dir = mkdtempSync(join(tmpdir(), "reprise-eslint-ignore-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "eslint.config.js"), config);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "foo.ts"), "export const n = 1;\n");
  writeFileSync(join(dir, "src", "hidden.ts"), "export const n = 1;\n");
  return dir;
}

async function selfTest() {
  const ignored = ignoredTypescriptInSourceTrees([
    "src/tui/intake-tui.ts",
    "docs/foo.ts",
    "scripts/bar.ts",
  ]);
  if (!ignored.includes("src/tui/intake-tui.ts") || ignored.length !== 1) {
    throw new Error("src/ 下被忽略的 TypeScript 必须失败");
  }
  const missing = untrackedRelativeImports(
    "src/tui/controller.ts",
    'export { x } from "./intake-tui.js";\n',
    (path) => path === "src/tui/controller.ts",
  );
  if (!missing.some((error) => error.includes("intake-tui.ts"))) {
    throw new Error("受控源码相对导入未跟踪目标必须失败");
  }
  if (!forbiddenSourceExcludes(["node_modules", "src/tui/controller-ops.ts"]).includes("src/tui/controller-ops.ts")) {
    throw new Error("tsconfig.exclude 覆盖 src 必须失败");
  }
  const stale = staleControlledIgnores(ROOT, ["src/tui/controller-ops.ts", "src/tui/intake-tui.ts"]);
  if (!stale.includes("src/tui/controller-ops.ts") || stale.includes("src/tui/intake-tui.ts")) {
    throw new Error("指向已删除 src 文件的 ignore 必须失败");
  }

  const globDir = writeTempEslintProject(
    `export default [{ ignores: ["src/**/*.ts"] }, { files: ["**/*.ts"] }];\n`,
  );
  const quoteDir = writeTempEslintProject(
    `export default [{ ignores: ["src/hidden.ts"] }, { files: ["**/*.ts"] }];\n`,
  );
  const multiDir = writeTempEslintProject(
    `export default [{ ignores: ['dist/**'] }, { ignores: ["src/hidden.ts"] }, { files: ["**/*.ts"] }];\n`,
  );
  try {
    const globHidden = await eslintIgnoredTrackedSource(globDir, ["src/foo.ts"]);
    if (!globHidden.includes("src/foo.ts")) {
      throw new Error("双引号 src/**/*.ts ESLint ignore 必须失败");
    }
    const quoteHidden = await eslintIgnoredTrackedSource(quoteDir, ["src/foo.ts", "src/hidden.ts"]);
    if (!quoteHidden.includes("src/hidden.ts") || quoteHidden.includes("src/foo.ts")) {
      throw new Error("双引号精确路径 ESLint ignore 必须失败");
    }
    const multiHidden = await eslintIgnoredTrackedSource(multiDir, ["src/foo.ts", "src/hidden.ts"]);
    if (!multiHidden.includes("src/hidden.ts") || multiHidden.includes("src/foo.ts")) {
      throw new Error("多段 ESLint ignores 必须按实际配置失败");
    }
  } finally {
    rmSync(globDir, { recursive: true, force: true });
    rmSync(quoteDir, { recursive: true, force: true });
    rmSync(multiDir, { recursive: true, force: true });
  }
  console.log(
    "verify-tracked-source self-test: ignored src TS、未跟踪相对导入、tsconfig/jscpd 过期排除、双引号/glob/多段 ESLint ignore 均被拒绝",
  );
}

async function main() {
  await selfTest();
  if (process.argv.includes("--self-test")) return;
  const errors = [];
  const ignored = ignoredTypescriptInSourceTrees(
    gitZ(ROOT, ["ls-files", "--others", "-i", "--exclude-standard", "-z", "--", "src", "test"]),
  );
  for (const file of ignored) errors.push(`被 Git 忽略的 TypeScript: ${file}`);
  const tracked = new Set(gitZ(ROOT, ["ls-files", "-z", "--", "src", "test"]).map(posixPath));
  const isTracked = (path) => tracked.has(path);
  for (const file of tracked) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    errors.push(...untrackedRelativeImports(file, text, isTracked));
  }
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  for (const entry of forbiddenSourceExcludes(tsconfig.exclude ?? [])) {
    errors.push(`tsconfig.exclude 覆盖受控源码: ${entry}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const pattern of staleControlledIgnores(ROOT, jscpdIgnorePatterns(pkg.scripts?.jscpd ?? ""))) {
    errors.push(`jscpd ignore 指向不存在的受控源码: ${pattern}`);
  }
  const knip = JSON.parse(readFileSync(join(ROOT, "knip.json"), "utf8"));
  for (const pattern of staleControlledIgnores(ROOT, knip.ignore ?? [])) {
    errors.push(`knip ignore 指向不存在的受控源码: ${pattern}`);
  }
  const trackedTs = [...tracked].filter((name) => name.endsWith(".ts"));
  for (const file of await eslintIgnoredTrackedSource(ROOT, trackedTs)) {
    errors.push(`ESLint ignore 覆盖受控文件: ${file}`);
  }
  if (errors.length) {
    console.error(`verify-tracked-source: ${errors.length} 个问题\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("verify-tracked-source: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
