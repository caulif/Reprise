import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import { pathContainedBy } from "../../core/paths.js";
import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../../core/identity.js";
import { ProcessBoundaryError, runProcess } from "../../infrastructure/process-runner.js";
import {
  RecoveryReadinessContextSchema,
  type RecoveryReadinessContext,
  type TaskCase,
} from "../../core/schema.js";

export type RecoveryReadinessCommandCheck = {
  command: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  exitCode?: number;
  outputDigest?: string;
  reason?: string;
};

export type RecoveryReadinessResult = {
  status: "ready" | "not_ready" | "blocked";
  checkedPaths: string[];
  missingPaths: string[];
  commandChecks: RecoveryReadinessCommandCheck[];
  feedback: string;
};

export type RecoveryReadinessOptions = {
  /** Commands are disabled by default; callers must explicitly opt into staging-only execution. */
  executeCommands?: boolean;
  timeoutMs?: number;
};

const COMMAND_PATTERN = /(?:^|\n)\s*(?:\$\s*)?((?:npm|pnpm|yarn|node|python|pytest|cargo|go|make)\s+[^\n`]{1,200})/g;
const READINESS_LIMITS = { summary: 4096, workspace: 512, path: 512, command: 2048, check: 2048 } as const;

function boundedStrings(values: readonly unknown[], maxLength: number, maxItems: number): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.slice(0, maxLength)))]
    .slice(0, maxItems);
}

/** Derives conservative, inspectable continuation hints; it never invents file contents. */
export function deriveRecoveryReadinessContext(taskCase: TaskCase, cwd?: string): RecoveryReadinessContext {
  const text = [taskCase.initialInput.text, ...taskCase.transcript.map((message) => message.text), JSON.stringify(taskCase.taskContext ?? {})].join("\n");
  const taskHints = taskCase.taskContext ?? {};
  const explicitPaths = Array.isArray(taskHints.relevantPaths)
    ? taskHints.relevantPaths.filter((value): value is string => typeof value === "string")
    : [];
  const historicalBehavior = taskHints.historicalBehavior;
  const historicalRecord = historicalBehavior && typeof historicalBehavior === "object"
    ? (historicalBehavior as Record<string, unknown>)
    : undefined;
  const touchedPaths = Array.isArray(historicalRecord?.touchedPaths)
    ? historicalRecord.touchedPaths.filter((value): value is string => typeof value === "string")
    : [];
  const historicalCwd = typeof taskHints.historicalCwd === "string" ? taskHints.historicalCwd : cwd;
  const derivedPaths = taskCase.evidenceLevel && typeof taskHints.historicalCwd === "string" ? touchedPaths.flatMap((path) => {
    if (!isAbsolute(path)) return [path.replaceAll("\\", "/")];
    if (!historicalCwd || !isAbsolute(historicalCwd)) return [];
    const candidate = relative(historicalCwd, path).replaceAll("\\", "/");
    return candidate && candidate !== "." && candidate !== ".." && !candidate.startsWith("../") ? [candidate] : [];
  }) : [];
  const relevantPaths = boundedStrings([...explicitPaths, ...derivedPaths], READINESS_LIMITS.path, 256);
  const pathSemantics = isOutputProducingTask(text) ? "task_outputs" as const : "required_inputs" as const;
  const historicalCommands = historicalRecord?.commands;
  const priorCommands = boundedStrings([
    ...(Array.isArray(historicalCommands) ? historicalCommands.filter((value): value is string => typeof value === "string") : []),
    ...[...text.matchAll(COMMAND_PATTERN)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value)),
  ], READINESS_LIMITS.command, 64);
  const observedWorkspaces = cwd ? boundedStrings([cwd], READINESS_LIMITS.workspace, 32) : [];
  const availableChecks = priorCommands.length > 0
    ? boundedStrings(priorCommands.map((command) => `replayable command: ${command}`), READINESS_LIMITS.check, 64)
    : ["inspect required paths and task inputs"];
  const context: RecoveryReadinessContext = {
    schemaVersion: 1,
    taskSummary: taskCase.initialInput.text.trim().slice(0, READINESS_LIMITS.summary) || "Continue the historical task from its recovered workspace.",
    observedWorkspaces,
    relevantPaths,
    pathSemantics,
    priorCommands,
    availableChecks,
  };
  if (!Value.Check(RecoveryReadinessContextSchema, context)) throw new Error("Derived Recovery readiness context is invalid.");
  return context;
}

/** Checks Host-observable local facts and, only when explicitly enabled, replayable commands in staging. */
export async function checkRecoveryReadiness(root: string, context: RecoveryReadinessContext, options: RecoveryReadinessOptions = {}): Promise<RecoveryReadinessResult> {
  if (!Value.Check(RecoveryReadinessContextSchema, context)) throw new Error("Recovery readiness context is invalid.");
  const checkedPaths: string[] = [];
  const missingPaths: string[] = [];
  const commandChecks: RecoveryReadinessCommandCheck[] = [];
  for (const path of context.relevantPaths) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) return { status: "blocked", checkedPaths, missingPaths, commandChecks, feedback: `Readiness path escaped staging boundary: ${path}` };
    const absolute = resolve(root, ...normalized.split("/"));
    if (!pathContainedBy(resolve(root), absolute)) return { status: "blocked", checkedPaths, missingPaths, commandChecks, feedback: `Readiness path escaped staging boundary: ${path}` };
    checkedPaths.push(normalized);
    try {
      await access(absolute);
      const fileStat = await stat(absolute);
      if (fileStat.isFile() && fileStat.size === 0) missingPaths.push(normalized);
      if (fileStat.isFile() && fileStat.size > 0 && fileStat.size <= 1024 * 1024) await readFile(absolute);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missingPaths.push(normalized);
      else throw error;
    }
  }
  if (checkedPaths.length === 0) {
    return {
      status: "ready",
      checkedPaths,
      missingPaths,
      commandChecks,
      feedback: "No extra task paths were derived; Host already accepted the recovered workspace fingerprint.",
    };
  }
  if (options.executeCommands && missingPaths.length === 0 && context.priorCommands.length > 0) {
    for (const command of context.priorCommands) {
      const parsed = parseReadinessCommand(command);
      if (!parsed) {
        commandChecks.push({ command, status: "blocked", reason: "command is not in the staging-only readiness allowlist" });
        continue;
      }
      try {
        const result = await runProcess({
          operation: "recovery_readiness_command",
          executableKind: "staging_readiness_command",
          command: parsed.command,
          args: parsed.args,
          cwd: resolve(root),
          timeoutMs: options.timeoutMs ?? 30_000,
          maxOutputBytes: 16_384,
          truncateOutput: true,
          allowNonzeroExit: true,
          killTree: true,
        });
        commandChecks.push({
          command,
          status: result.exitCode === 0 ? "passed" : "failed",
          exitCode: result.exitCode,
          outputDigest: sha256(`${result.stdout}
${result.stderr}`),
        });
      } catch (error) {
        commandChecks.push({ command, status: "failed", reason: error instanceof ProcessBoundaryError ? error.exitCategory : "process_boundary_failed" });
      }
    }
  } else {
    commandChecks.push(...context.priorCommands.map((command) => ({ command, status: "not_run" as const, reason: "explicit staging command execution was not enabled" })));
  }
  const missingNote = missingPaths.length > 0 ? ` Host-derived paths missing from staging: ${missingPaths.join(", ")}.` : "";
  const failedCommands = commandChecks.filter((check) => check.status === "failed" || check.status === "blocked");
  const commandNote = failedCommands.length > 0
    ? ` ${failedCommands.length} readiness command check(s) did not pass; Host does not rewrite the Agent envelope.`
    : "";
  return {
    status: "ready",
    checkedPaths,
    missingPaths,
    commandChecks,
    feedback: `Host recorded ${checkedPaths.length} inspectable path fact(s).${missingNote}${commandNote}${commandChecks.some((check) => check.status === "passed") ? " Some readiness commands passed." : ""}`.trim(),
  };
}

export function taskReadinessBlocksPublication(_status: RecoveryReadinessResult["status"]): boolean {
  return false;
}

export function taskContinuationOutcome(
  envelopeStatus: string,
): "ready_for_task" | "unrecoverable" | "blocked_by_safety" {
  return envelopeStatus === "ready" ? "ready_for_task" : "unrecoverable";
}

export async function measureRecoveryStagingReadiness(
  root: string,
  taskCase: TaskCase,
  options: { executeCommands?: boolean; cwd?: string } = {},
): Promise<RecoveryReadinessResult> {
  // Readiness is a Host mechanical check. Do not derive replayable commands
  // from the full historical transcript during the live Recovery path.
  const derived = deriveRecoveryReadinessContext(taskCase, options.cwd);
  const context: RecoveryReadinessContext = {
    ...derived,
    priorCommands: [],
    availableChecks: ["inspect required paths and task inputs"],
  };
  return checkRecoveryReadiness(root, context, { executeCommands: false });
}

export function applyTaskReadinessGate<T extends {
  baseline: {
    readiness: { runnable: string; strictness: string; blockingResourceIds: string[] };
  };
}>(preview: T, _readiness: RecoveryReadinessResult): T {
  return preview;
}

function isOutputProducingTask(text: string): boolean {
  return /(?:下载|整理|创建|生成|写入|导出|保存|download|organize|create|generate|write|export|save)/i.test(text);
}

function parseReadinessCommand(command: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | undefined {
  if (!command || /[\r\n&|;<>`]/.test(command)) return undefined;
  const tokens = [...command.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]).filter((token): token is string => token !== undefined);
  if (!tokens.length || (command.match(/"/g)?.length ?? 0) % 2 !== 0 || (command.match(/'/g)?.length ?? 0) % 2 !== 0) return undefined;
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = executableToken.toLowerCase().replace(/\.cmd$/, "");
  if (!["npm", "pnpm", "yarn", "node", "python", "pytest", "cargo", "go", "make"].includes(executable)) return undefined;
  if (tokens.slice(1).some((token) => token === "-e" || token === "-c" || token.includes(".."))) return undefined;
  return { command: platform === "win32" && ["npm", "pnpm", "yarn"].includes(executable) ? `${executable}.cmd` : executableToken, args: tokens.slice(1) };
}
