#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXT = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".md", ".yml", ".yaml", ".json", ".jsonc",
  ".toml", ".html", ".css", ".sh", ".bash", ".ps1", ".cmd", ".bat", ".env",
  ".example", ".txt", ".xml", ".svg",
]);
const SKIP_PATH = /^(?:dist\/|node_modules\/|package-lock\.json$)/;
const RULES = [
  { name: "openai-legacy", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "openai-project", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github-pat", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { name: "bearer-or-api-key", pattern: /(?:Authorization\s*:\s*Bearer|api[_-]?key\s*[:=]\s*)[A-Za-z0-9._~+/-]{24,}/gi },
];

export function secretFindings(text) {
  const hits = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) hits.push(rule.name);
  }
  return hits;
}

export function formatSecretHits(path, origin, rules) {
  return rules.map((rule) => `${path} (${origin})  [${rule}]`);
}

export function isSecretScanPath(name) {
  const normalized = name.replaceAll("\\", "/");
  if (SKIP_PATH.test(normalized)) return false;
  const ext = extname(normalized).toLowerCase();
  return TEXT_EXT.has(ext) || normalized.endsWith(".env");
}

function gitZ(root, args) {
  const output = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return output ? output.split("\0").filter(Boolean) : [];
}

function normalizeNames(names) {
  return names.map((name) => name.replaceAll("\\", "/")).filter(isSecretScanPath);
}

export function listWorkingTreeScanPaths(listFiles) {
  const names = new Set();
  for (const args of [
    ["ls-files", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    for (const name of listFiles(args)) names.add(name.replaceAll("\\", "/"));
  }
  return [...names].filter(isSecretScanPath);
}

export function listIndexScanPaths(listFiles) {
  return normalizeNames(listFiles(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]));
}

export function listSecretScanPaths(listFiles) {
  return [...new Set([...listWorkingTreeScanPaths(listFiles), ...listIndexScanPaths(listFiles)])];
}

export function scanSecretSources(sources) {
  const hits = [];
  for (const source of sources) {
    const rules = secretFindings(source.text);
    if (rules.length) hits.push(...formatSecretHits(source.path, source.origin, rules));
  }
  return hits;
}

function readIndexBlob(root, file) {
  try {
    return execFileSync("git", ["show", `:${file}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // 路径已从 `git diff --cached` 列出，但 blob 可能在并发 unstage 后消失。
    if (error && typeof error === "object" && "status" in error) return null;
    throw error;
  }
}

export function collectSecretHits(root) {
  const listFiles = (args) => gitZ(root, args);
  const sources = [];
  for (const file of listWorkingTreeScanPaths(listFiles)) {
    try {
      sources.push({
        path: file,
        origin: "working-tree",
        text: readFileSync(join(root, file), "utf8"),
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  for (const file of listIndexScanPaths(listFiles)) {
    const text = readIndexBlob(root, file);
    if (text == null) continue;
    sources.push({ path: file, origin: "index", text });
  }
  return scanSecretSources(sources);
}

function selfTestIndexDivergence() {
  const dir = mkdtempSync(join(tmpdir(), "reprise-secret-"));
  const sample = ["sk-", "abcdefghijklmnopqrstuvwxyz1234"].join("");
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"));
    const file = "src/probe.ts";
    writeFileSync(join(dir, file), "export const ok = 1;\n");
    execFileSync("git", ["add", "--", file], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, file), `export const token = "${sample}";\n`);
    execFileSync("git", ["add", "--", file], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, file), "export const ok = 1;\n");
    const hits = collectSecretHits(dir);
    const joined = hits.join("\n");
    if (!hits.some((hit) => hit.includes(`${file} (index)`) && hit.includes("[openai-legacy]"))) {
      throw new Error("index 与 working tree 分歧时，index secret 必须被拒绝");
    }
    if (hits.some((hit) => hit.includes("(working-tree)"))) {
      throw new Error("工作区干净时不应报告 working-tree");
    }
    if (joined.includes(sample)) {
      throw new Error("输出不得包含 secret 值");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest() {
  const sample = ["sk-", "abcdefghijklmnopqrstuvwxyz1234"].join("");
  if (!secretFindings(`token ${sample}`).includes("openai-legacy")) {
    throw new Error("应当检测到 OpenAI 形态令牌");
  }
  const project = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz"].join("");
  if (!secretFindings(project).includes("openai-project")) {
    throw new Error("应当检测到 OpenAI project key");
  }
  const anthropic = ["sk-ant-", "api03-abcdefghijklmnopqrstuv"].join("");
  if (!secretFindings(anthropic).includes("anthropic")) {
    throw new Error("应当检测到 Anthropic key");
  }
  const fine = ["github_pat_", "11AAAAAAAAAAAAAAAAAAAA"].join("");
  if (!secretFindings(fine).includes("github-fine-grained")) {
    throw new Error("应当检测到 GitHub fine-grained token");
  }
  if (secretFindings("documentation mentions API keys without values").length) {
    throw new Error("普通说明不应当判为 secret");
  }
  const rendered = formatSecretHits("test/fixture.ts", "working-tree", ["openai-legacy"]).join("\n");
  if (rendered.includes(sample) || /sk-[a-z]{10}/.test(rendered)) {
    throw new Error("输出不得包含 secret 值");
  }
  const listed = listSecretScanPaths(() => ["test/fixture.ts", "src/core/a.ts"]);
  if (!listed.includes("test/fixture.ts")) {
    throw new Error("test fixture 必须纳入扫描");
  }
  const untracked = listWorkingTreeScanPaths((args) => (args.includes("--others") ? ["scripts/tmp-untracked.sh"] : []));
  if (!untracked.includes("scripts/tmp-untracked.sh")) {
    throw new Error("未跟踪且未被 ignore 的文本必须纳入扫描");
  }
  const staged = listIndexScanPaths((args) => (args.includes("--cached") ? ["src/staged.ts"] : []));
  if (!staged.includes("src/staged.ts")) {
    throw new Error("staged 路径必须纳入 index 扫描");
  }
  const injected = scanSecretSources([
    { path: "src/probe.ts", origin: "working-tree", text: "export const ok = 1;\n" },
    { path: "src/probe.ts", origin: "index", text: `export const token = "${sample}";\n` },
  ]);
  if (!injected.includes("src/probe.ts (index)  [openai-legacy]")) {
    throw new Error("index 与 working tree 分歧时，index secret 必须被拒绝");
  }
  selfTestIndexDivergence();
  console.log("verify-secrets self-test: 未跟踪文件、test fixture 与新型 token 被拒绝；index 与 working tree 分歧时，index secret 被拒绝，且不打印 secret");
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const hits = collectSecretHits(ROOT);
  if (hits.length) {
    console.error(`verify-secrets: 待提交文本疑似含有 secret:\n${hits.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("verify-secrets: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
