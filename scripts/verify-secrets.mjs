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
const ABSOLUTE_PATH_SCAN_PREFIXES = ["src/", "scripts/", "test/"];
const SYNTHETIC_WINDOWS_USERS = new Set([
  "RUNNER~1",
  "runneradmin",
  "demo",
  "x",
  "name with space",
  "example",
]);
const WINDOWS_USERS_PATH = /(?:^|[^A-Za-z0-9])C:[\\/]Users[\\/]([^\\/]+)/g;
const UNIX_USERS_PATH = /(?<![a-z:])\/Users\/([^/\s"'`]+)/g;
const UNIX_HOME_PATH = /(?<![a-z:])\/home\/([^/\s"'`]+)/g;
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

export function isAbsolutePathScanPath(name) {
  const normalized = name.replaceAll("\\", "/");
  return ABSOLUTE_PATH_SCAN_PREFIXES.some((prefix) => normalized.startsWith(prefix)) && isSecretScanPath(name);
}

function collectAbsolutePathRules(text, pattern, ruleName, whitelist) {
  const hits = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const segment = match[1];
    if (whitelist && whitelist.has(segment)) continue;
    hits.push(ruleName);
    break;
  }
  return hits;
}

export function absolutePathFindings(text) {
  const hits = [];
  hits.push(...collectAbsolutePathRules(text, WINDOWS_USERS_PATH, "windows-users-path", SYNTHETIC_WINDOWS_USERS));
  hits.push(...collectAbsolutePathRules(text, UNIX_USERS_PATH, "unix-users-path", null));
  hits.push(...collectAbsolutePathRules(text, UNIX_HOME_PATH, "unix-home-path", null));
  return hits;
}

export function formatAbsolutePathHits(path, origin, rules) {
  return rules.map((rule) => `${path} (${origin})  [${rule}]`);
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

export function scanAbsolutePathSources(sources) {
  const hits = [];
  for (const source of sources) {
    if (!isAbsolutePathScanPath(source.path)) continue;
    const rules = absolutePathFindings(source.text);
    if (rules.length) hits.push(...formatAbsolutePathHits(source.path, source.origin, rules));
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

function collectScanSources(root) {
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
  return sources;
}

export function collectSecretHits(root) {
  return scanSecretSources(collectScanSources(root));
}

export function collectAbsolutePathHits(root) {
  return scanAbsolutePathSources(collectScanSources(root));
}

export function collectVerifySecretsHits(root) {
  const sources = collectScanSources(root);
  return [...scanSecretSources(sources), ...scanAbsolutePathSources(sources)];
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
  selfTestAbsolutePaths();
  console.log("verify-secrets self-test: 未跟踪文件、test fixture 与新型 token 被拒绝；index 与 working tree 分歧时，index secret 被拒绝；合成绝对路径放行、真实形态绝对路径被拒绝；且不打印 secret");
}

function selfTestAbsolutePaths() {
  const synthetic = String.raw`C:\Users\demo\.codex\sessions\a.jsonl`;
  if (absolutePathFindings(synthetic).length) {
    throw new Error("合成 Windows demo 路径必须放行");
  }
  const wsl = "/mnt/c/Users/x/codex.cmd";
  if (absolutePathFindings(wsl).length) {
    throw new Error("WSL /mnt/c/Users/x 路径必须放行");
  }
  const realWindows = ["C:\\Users\\", "15893", "\\.claude\\projects\\sample.jsonl"].join("");
  if (!absolutePathFindings(realWindows).includes("windows-users-path")) {
    throw new Error("真实形态 Windows 用户路径必须被拒绝");
  }
  const realUnixUsers = ["/", "Users", "/jane/Documents/project"].join("");
  if (!absolutePathFindings(realUnixUsers).includes("unix-users-path")) {
    throw new Error("真实形态 /Users 路径必须被拒绝");
  }
  const realUnixHome = ["/", "home", "/ubuntu/project"].join("");
  if (!absolutePathFindings(realUnixHome).includes("unix-home-path")) {
    throw new Error("真实形态 /home 路径必须被拒绝");
  }
  const injected = scanAbsolutePathSources([
    { path: "scripts/probe.ts", origin: "working-tree", text: "export const ok = 1;\n" },
    {
      path: "scripts/probe.ts",
      origin: "index",
      text: `const session = '${realWindows}';\n`,
    },
  ]);
  if (!injected.includes("scripts/probe.ts (index)  [windows-users-path]")) {
    throw new Error("index 与 working tree 分歧时，index 绝对路径必须被拒绝");
  }
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const hits = collectVerifySecretsHits(ROOT);
  if (hits.length) {
    console.error(`verify-secrets: 待提交文本疑似含有 secret 或本机绝对路径:\n${hits.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("verify-secrets: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
