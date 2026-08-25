#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const TEST = join(ROOT, "test");
const ALLOWLIST_PATH = join(ROOT, "scripts", "source-size-allowlist.json");
const TEST_FUNCTION_LIMIT = Number.MAX_SAFE_INTEGER;

export function posixPath(path) {
  return path.replaceAll("\\", "/");
}

export function fileLineCount(text) {
  return text.split(/\r?\n/).length;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function allowlistKey(file, name) {
  return `${posixPath(file)}::${name}`;
}

function spanLines(sf, node) {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.end).line + 1;
  return { start, end, lines: end - start + 1 };
}

function symbolName(node, sf) {
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    const parent =
      node.parent && ts.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : "?";
    const method = ts.isConstructorDeclaration(node)
      ? "constructor"
      : ts.isIdentifier(node.name)
        ? node.name.text
        : sf.text.slice(node.name.getStart(sf), node.name.end);
    return `${parent}.${method}`;
  }
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.parent) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    if (ts.isPropertyDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      const owner = node.parent.parent && ts.isClassLike(node.parent.parent) && node.parent.parent.name
        ? node.parent.parent.name.text
        : "?";
      return `${owner}.${node.parent.name.text}`;
    }
  }
  return "<anonymous>";
}

function isSizedNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

export function scanSourceText(file, text, limits) {
  const findings = [];
  const rel = posixPath(file);
  const fileLines = fileLineCount(text);
  if (fileLines > limits.fileLimit) {
    findings.push({ kind: "file", name: rel, file: rel, lines: fileLines, start: 1, end: fileLines });
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (isSizedNode(node)) {
      const { lines, start, end } = spanLines(sf, node);
      if (lines > limits.functionLimit) {
        findings.push({
          kind: ts.isClassDeclaration(node) ? "class" : "fn",
          name: symbolName(node, sf),
          file: rel,
          lines,
          start,
          end,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function walkTsFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(path, files);
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

export function loadAllowlist(raw) {
  if (!raw || typeof raw !== "object") throw new Error("allowlist 必须是对象");
  const until = raw.until;
  const owner = raw.owner;
  if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    throw new Error("allowlist.until 必须是 YYYY-MM-DD");
  }
  if (typeof owner !== "string" || !owner.trim()) throw new Error("allowlist.owner 必须非空");
  const fileLimit = raw.fileLimit ?? 1000;
  const functionLimit = raw.functionLimit ?? 100;
  if (!Number.isSafeInteger(fileLimit) || fileLimit < 1) throw new Error("fileLimit 无效");
  if (!Number.isSafeInteger(functionLimit) || functionLimit < 1) throw new Error("functionLimit 无效");
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || typeof entry.file !== "string") {
      throw new Error("allowlist.entries 项必须含 name 与 file");
    }
    normalized.push({
      name: entry.name,
      file: posixPath(entry.file),
      owner: typeof entry.owner === "string" ? entry.owner : owner,
      until: typeof entry.until === "string" ? entry.until : until,
    });
  }
  return { owner, until, fileLimit, functionLimit, entries: normalized };
}

export function evaluateSourceSize({ findings, allowlist, today }) {
  const errors = [];
  const allowed = new Map();
  for (const entry of allowlist.entries) {
    const key = allowlistKey(entry.file, entry.name);
    allowed.set(key, entry);
    if (today >= entry.until) {
      errors.push(`过期例外 ${entry.file} ${entry.name} until ${entry.until} owner ${entry.owner}`);
    }
  }
  const used = new Set();
  for (const finding of findings) {
    const key = allowlistKey(finding.file, finding.name);
    const entry = allowed.get(key);
    if (!entry) {
      errors.push(`未登记超限 ${finding.kind} ${finding.file} ${finding.name} (${finding.lines} 行)`);
      continue;
    }
    used.add(key);
  }
  for (const [key, entry] of allowed) {
    if (!used.has(key) && today < entry.until) {
      errors.push(`清单多余 ${entry.file} ${entry.name}`);
    }
  }
  return errors;
}

export function scanDirectory(root, limits) {
  const findings = [];
  for (const file of walkTsFiles(root)) {
    const rel = posixPath(relative(ROOT, file));
    findings.push(...scanSourceText(rel, readFileSync(file, "utf8"), limits));
  }
  return findings;
}

function writeLines(path, count, prefix) {
  writeFileSync(path, Array.from({ length: count }, (_, i) => `${prefix}${i};`).join("\n"));
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-source-size-'));
  try {
    mkdirSync(join(dir, "src"));
    const hugeFile = join(dir, "src", "huge.ts");
    writeLines(hugeFile, 1001, "export const n");
    const probe = join(dir, "src", "intake-tui-probe.ts");
    writeLines(probe, 1001, "export const n");
    const hugeFn = join(dir, "src", "fn.ts");
    const body = Array.from({ length: 99 }, (_, i) => `  const x${i} = ${i};`).join("\n");
    writeFileSync(hugeFn, `export function tooBig() {\n${body}\n}\n`);
    const methodBody = Array.from({ length: 99 }, (_, i) => `    const x${i} = ${i};`).join("\n");
    const hugeMethod = `export class Host {\n  tooBig() {\n${methodBody}\n  }\n}\n`;
    const wideClass = `export class Wide {\n${Array.from({ length: 80 }, (_, i) => `  m${i}() { return ${i}; }`).join("\n")}\n}\n`;
    const limits = { fileLimit: 1000, functionLimit: 100 };
    const fileHits = scanSourceText("src/huge.ts", readFileSync(hugeFile, "utf8"), limits);
    if (!fileHits.some((hit) => hit.kind === "file" && hit.lines === 1001)) {
      throw new Error("1001 行文件必须使门禁失败");
    }
    const probeHits = scanSourceText("src/intake-tui-probe.ts", readFileSync(probe, "utf8"), limits);
    if (!probeHits.some((hit) => hit.kind === "file" && hit.lines === 1001)) {
      throw new Error("名为 intake-tui-probe.ts 的超限源码必须使门禁失败");
    }
    const fnHits = scanSourceText("src/fn.ts", readFileSync(hugeFn, "utf8"), limits);
    if (!fnHits.some((hit) => hit.kind === "fn" && hit.name === "tooBig" && hit.lines >= 101)) {
      throw new Error("101 行函数必须使门禁失败");
    }
    const methodHits = scanSourceText("src/method.ts", hugeMethod, limits);
    if (!methodHits.some((hit) => hit.kind === "fn" && hit.name === "Host.tooBig" && hit.lines >= 101)) {
      throw new Error("101 行方法必须使门禁失败");
    }
    const classHits = scanSourceText("src/wide.ts", wideClass, limits);
    if (classHits.some((hit) => hit.kind === "class" || hit.name === "Wide")) {
      throw new Error("多个短方法组成的类不得按函数超限失败");
    }
    const hugeTest = join(dir, "test", "huge.test.ts");
    mkdirSync(join(dir, "test"));
    writeLines(hugeTest, 1001, "export const n");
    const testFileHits = scanSourceText("test/huge.test.ts", readFileSync(hugeTest, "utf8"), limits);
    if (!testFileHits.some((hit) => hit.kind === "file" && hit.lines === 1001)) {
      throw new Error("1001 行测试文件必须使门禁失败");
    }
    const testFnHits = scanSourceText("test/fn.test.ts", `export function tooBig() {\n${body}\n}\n`, {
      fileLimit: 1000,
      functionLimit: TEST_FUNCTION_LIMIT,
    });
    if (testFnHits.some((hit) => hit.kind === "fn")) {
      throw new Error("测试文件中的长回调不得按函数超限失败");
    }
    const allowlist = loadAllowlist({
      owner: "@caulif",
      until: "2026-09-06",
      fileLimit: 1000,
      functionLimit: 100,
      entries: [
        { name: "src/huge.ts", file: "src/huge.ts" },
        { name: "tooBig", file: "src/fn.ts" },
      ],
    });
    const covered = evaluateSourceSize({
      findings: [...fileHits, ...fnHits],
      allowlist,
      today: "2026-08-24",
    });
    if (covered.length) throw new Error(`已登记超限不应报错: ${covered.join("; ")}`);
    const unregistered = evaluateSourceSize({
      findings: fnHits,
      allowlist: loadAllowlist({ owner: "@caulif", until: "2026-09-06", entries: [] }),
      today: "2026-08-24",
    });
    if (!unregistered.some((error) => error.includes("未登记超限"))) {
      throw new Error("未登记的 101 行函数必须失败");
    }
    const expired = evaluateSourceSize({
      findings: fnHits,
      allowlist: loadAllowlist({
        owner: "@caulif",
        until: "2026-08-01",
        entries: [{ name: "tooBig", file: "src/fn.ts" }],
      }),
      today: "2026-08-24",
    });
    if (!expired.some((error) => error.includes("过期例外"))) {
      throw new Error("过期例外必须失败");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("verify-source-size self-test: 1001 行 src/test 文件、intake-tui-probe、101 行函数/方法被拒绝；宽类与测试长回调不按函数计；过期例外失败");
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const allowlist = loadAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")));
  const findings = [
    ...scanDirectory(SRC, {
      fileLimit: allowlist.fileLimit,
      functionLimit: allowlist.functionLimit,
    }),
    ...scanDirectory(TEST, {
      fileLimit: allowlist.fileLimit,
      functionLimit: TEST_FUNCTION_LIMIT,
    }),
  ];
  const errors = evaluateSourceSize({
    findings,
    allowlist,
    today: todayUtc(),
  });
  if (errors.length) {
    console.error(`verify-source-size: ${errors.length} 个问题\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `verify-source-size: ok (${findings.length} 个已登记超限；0 个未登记；0 个过期例外)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
