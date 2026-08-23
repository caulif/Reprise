import { resolve } from "node:path";
import type { SourceRootKind } from "../agents/controller-agent.js";
import type { EventEnvelope, RunRecord, TaskCase } from "../core/schema.js";

export type { SourceRootKind };

export type ReplayLang = "zh" | "en";

export type ReplayHostInput = {
  sourceRootKind: SourceRootKind;
  requestedModel: string;
  resolvedModel?: string;
  record?: RunRecord;
  events?: readonly EventEnvelope[];
  settledTurns?: number;
  changedPaths?: readonly string[];
  productId?: string;
  lang?: ReplayLang;
};

export function historicalCwdOf(taskCase: TaskCase): string | undefined {
  const value = taskCase.taskContext?.historicalCwd;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function inferSourceRootKind(input: {
  sourceRoot: string;
  historicalCwd?: string;
  explicit?: SourceRootKind;
}): SourceRootKind {
  if (input.explicit) return input.explicit;
  if (
    input.historicalCwd &&
    samePath(input.sourceRoot, input.historicalCwd)
  ) {
    return "historical_cwd";
  }
  return "operator_selected";
}

function describeStop(record: RunRecord | undefined, lang: ReplayLang = "en"): string {
  const zh = lang === "zh";
  if (!record) return zh ? "运行尚未到达 Host 终态决定。" : "The run has not reached a terminal Host decision.";
  const code = record.outcome.termination.code;
  if (code === "completed.controller_satisfied") {
    return zh
      ? "Controller 判定任务已完成（done/satisfied）。这是完成判断，不是安全上限停止。"
      : "Controller judged the task complete (done/satisfied). This is a completion judgment, not a safety-limit stop.";
  }
  if (code.startsWith("limit.")) {
    return zh
      ? `安全上限停止了本次运行（${code}）。这不是任务完成。`
      : `Safety limit stopped the run (${code}). This is not task completion.`;
  }
  if (record.outcome.termination.initiatedBy === "controller") {
    return zh
      ? `Controller 停止了本次运行（${code}）。这不是安全上限停止。`
      : `Controller stopped the run (${code}). This is not a safety-limit stop.`;
  }
  return zh ? `运行以 ${code} 结束。` : `The run ended with ${code}.`;
}

export function hostReplayConditions(input: ReplayHostInput): readonly string[] {
  const lang = input.lang ?? "en";
  const zh = lang === "zh";
  const notes: string[] = [];
  const requested = input.requestedModel;
  const resolved = input.resolvedModel ?? input.record?.manifest?.resolvedModel.resolved;
  if (resolved && resolved !== "unknown" && resolved !== requested) {
    notes.push(
      zh
        ? `请求的模型 ${requested} 解析为 ${resolved}；别名不是另一个模型。`
        : `Requested model ${requested} resolved to ${resolved}; the alias is not a different model.`,
    );
  }
  const catalogListed = Boolean(resolved && resolved !== "unknown");
  const settledTurns = input.settledTurns ?? 0;
  const kind = input.record?.outcome.termination.kind;
  const actuallyRan =
    settledTurns > 0 &&
    (kind === "completed" || kind === "failed" || kind === "limit_reached");
  notes.push(
    catalogListed
      ? actuallyRan
        ? zh
          ? "CLI 目录列出了该模型，且本次运行产生了原生回合结果。列入目录不等于调用成功。"
          : "The CLI catalog listed this model, and this run produced a native turn result. Listing is not the same as a successful call."
        : zh
          ? "CLI 目录列出了该模型；列入目录不等于调用成功。"
          : "The CLI catalog listed this model; listing is not the same as a successful call."
      : zh
        ? "未能从 CLI 目录核验候选模型。"
        : "The candidate model was not verified from the CLI catalog.",
  );
  notes.push(describeStop(input.record, lang));
  notes.push(sourceRootKindNote(input.sourceRootKind, lang));
  notes.push(
    zh
      ? "写入只留在隔离副本。没有出现在用户原目录是不变量，不是能力差异。"
      : "Writes stay in the isolated replica. Not appearing in the original user directory is an invariant, not a capability difference.",
  );
  const init = input.events?.find((event) => event.type.endsWith(".system_init"));
  const permissionMode = recordValue(init?.payload).permissionMode;
  if (typeof permissionMode === "string" && permissionMode.trim()) {
    notes.push(`permissionMode=${permissionMode}`);
  }
  const productId = input.productId ?? input.record?.attempt.candidate.productId;
  if (productId === "claude-code") {
    notes.push(
      zh
        ? "隔离：--no-session-persistence；禁止 CronCreate、CronDelete、ScheduleWakeup、SendMessage。"
        : "Isolation: --no-session-persistence; disallowed CronCreate, CronDelete, ScheduleWakeup, SendMessage.",
    );
  }
  if (input.changedPaths?.length) {
    notes.push(zh ? `改动路径：${input.changedPaths.join("、")}` : `Changed paths: ${input.changedPaths.join(", ")}`);
  }
  return notes;
}

function sourceRootKindNote(kind: SourceRootKind, lang: ReplayLang = "en"): string {
  const zh = lang === "zh";
  if (kind === "stand_in") {
    return zh
      ? "sourceRootKind=stand_in。候选没有看到历史工作树。不要把空副本里的新文件夹当成已接受的基线质量。"
      : "sourceRootKind=stand_in. The candidate did not see the historical working tree. Do not treat a new folder in this empty replica as matching the accepted baseline quality.";
  }
  if (kind === "historical_start") {
    return zh
      ? "sourceRootKind=historical_start。副本从历史工作目录拷出后，Host 删除了冻结会话期间写入的文件。候选从任务开始前的树起跑，不是从已接受的结果起跑。"
      : "sourceRootKind=historical_start. The replica was copied from the historical working directory, then Host removed files written during the frozen session. The candidate starts from the pre-task tree, not the accepted result.";
  }
  if (kind === "historical_cwd") {
    return zh
      ? "sourceRootKind=historical_cwd。副本按历史工作目录的当前状态拷出，其中包含已完成的历史结果。"
      : "sourceRootKind=historical_cwd. The replica was copied from the historical working directory as it exists now, including the completed historical result.";
  }
  return zh
    ? "sourceRootKind=operator_selected。操作者选择了历史 cwd 以外的目录。"
    : "sourceRootKind=operator_selected. The operator chose a directory other than the historical cwd.";
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
