#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const RANK = {
  core: 0,
  infrastructure: 1,
  products: 1,
  environment: 1,
  agents: 1,
  report: 1,
  application: 2,
  tui: 3,
  cli: 4,
};

export function layerOf(posixPath) {
  const [, folder] = posixPath.split("/");
  return folder && folder in RANK ? folder : undefined;
}

export function forbiddenImport(fromPath, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const from = fromPath.replaceAll("\\", "/");
  const fromLayer = layerOf(from);
  if (!fromLayer) return undefined;
  const resolved = resolve(dirname(join(ROOT, from)), specifier).replaceAll("\\", "/");
  const rel = relative(ROOT, resolved).replaceAll("\\", "/");
  const toLayer = layerOf(rel);
  if (!toLayer) return undefined;
  if (RANK[fromLayer] < RANK[toLayer]) {
    return `${from} 的 ${fromLayer} 不得 import ${toLayer} (${specifier})`;
  }
  return undefined;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export function relativeSpecifiers(source) {
  const found = [];
  for (const pattern of [
    /\bfrom\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']/g,
    /^\s*import\s+["'](\.[^"']+)["']/gm,
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

function selfTest() {
  const violation = forbiddenImport("src/core/schema.ts", "../tui/controller.ts");
  if (!violation) throw new Error("core→tui 应当被拒绝");
  if (forbiddenImport("src/tui/controller.ts", "../application/experiment.ts")) {
    throw new Error("tui→application 应当允许");
  }
  const fromImport = relativeSpecifiers('import x from "./tui/page.ts";');
  const fromExport = relativeSpecifiers('export { x } from "./tui/page.ts";');
  const fromDynamic = relativeSpecifiers('await import("./tui/page.ts");');
  const fromSideEffect = relativeSpecifiers('import "./tui/page.ts";\n');
  if (![fromImport, fromExport, fromDynamic, fromSideEffect].every((items) => items.includes("./tui/page.ts"))) {
    throw new Error("应当识别 import/export from、import() 与 side-effect import");
  }
  console.log("verify-layer-imports self-test: 反向依赖被拒绝；三种真实 import 语法均覆盖");
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const errors = [];
  for (const file of walk(SRC)) {
    const from = relative(ROOT, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    for (const specifier of relativeSpecifiers(text)) {
      const error = forbiddenImport(from, specifier);
      if (error) errors.push(error);
    }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("verify-layer-imports: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
