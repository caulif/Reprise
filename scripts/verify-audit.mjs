#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function productionAuditFailed(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object") return true;
  return (counts.high ?? 0) > 0 || (counts.critical ?? 0) > 0;
}

export function auditExitCodeFromReport(report) {
  return productionAuditFailed(report) ? 1 : 0;
}

function npmCli() {
  return join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

export function parseAuditStdout(stdout, status) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`npm audit 未返回 JSON（exit ${status ?? "unknown"}）: ${reason}`, { cause: error });
  }
}

function runProductionAudit() {
  const result = spawnSync(execPath, [npmCli(), "audit", "--omit=dev", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return parseAuditStdout(stdout, result.status);
}

function selfTest() {
  if (!productionAuditFailed({ metadata: { vulnerabilities: { high: 1, critical: 0 } } })) {
    throw new Error("高危漏洞应当使 audit 失败");
  }
  if (productionAuditFailed({ metadata: { vulnerabilities: { high: 0, critical: 0, moderate: 2 } } })) {
    throw new Error("仅中危时 production audit 不应当失败");
  }
  const helper = "process.stdout.write(JSON.stringify({metadata:{vulnerabilities:{high:0,critical:0,moderate:2}}})); process.exit(1);";
  const subprocess = spawnSync(execPath, ["-e", helper], { encoding: "utf8", windowsHide: true });
  if (subprocess.status === 0) {
    throw new Error("self-test 期望子进程非零退出");
  }
  const moderateReport = parseAuditStdout(subprocess.stdout ?? "", subprocess.status);
  if (auditExitCodeFromReport(moderateReport) !== 0) {
    throw new Error("子进程非零 + moderate JSON 应按策略通过");
  }
  console.log("verify-audit self-test: 高危失败、中危通过，含子进程非零 JSON 路径");
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  const report = runProductionAudit();
  if (productionAuditFailed(report)) {
    console.error("verify-audit: production 依赖存在 high/critical 漏洞");
    process.exitCode = 1;
    return;
  }
  console.log("verify-audit: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
