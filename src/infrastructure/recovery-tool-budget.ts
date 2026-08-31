type RecoveryToolCallBudget = {
  investigationCalls: number;
  completionCalls: number;
  deleteCalls: number;
};

const DESTRUCTIVE_SHELL = /\b(Remove-Item|rmdir|Erase-Item|\brm\b|\bdel\b|\brd\b)\b/i;

function isDestructiveRecoveryCommand(command: string): boolean {
  return DESTRUCTIVE_SHELL.test(command);
}

export function chargeRecoveryToolBudget(
  name: string,
  budget: RecoveryToolCallBudget,
  maxToolCalls: number,
  completionTools: ReadonlySet<string>,
  onBudgetExhausted?: (category: "budget_exhausted") => void,
  params?: unknown,
  completionPaths: ReadonlySet<string> = new Set(["recovery.md"]),
): void {
  if (completionTools.has(name) || isCompletionWrite(name, params, completionPaths)) {
    if (++budget.completionCalls > 8) throw new Error("Recovery completion-tool budget of 8 was exhausted.");
    return;
  }
  if (isDestructiveCall(name, params) && budget.deleteCalls >= 16) {
    throw new Error(
      "recovery_no_information_gain: destructive change budget of 16 was exhausted.",
    );
  }
  if (++budget.investigationCalls > maxToolCalls) {
    onBudgetExhausted?.("budget_exhausted");
    throw new Error(`Recovery tool-call budget of ${maxToolCalls} was exhausted.`);
  }
}

export function noteDestructiveRecoveryCall(
  name: string,
  params: unknown,
  budget: RecoveryToolCallBudget,
): void {
  if (isDestructiveCall(name, params)) budget.deleteCalls += 1;
}

function isCompletionWrite(name: string, params: unknown, completionPaths: ReadonlySet<string>): boolean {
  if (name !== "write") return false;
  const path = params && typeof params === "object" && "path" in params ? String((params as { path?: unknown }).path) : "";
  return completionPaths.has(path);
}

function isDestructiveCall(name: string, params: unknown): boolean {
  if (name !== "powershell") return false;
  const command =
    params && typeof params === "object" && "command" in params
      ? String((params as { command?: unknown }).command)
      : "";
  return isDestructiveRecoveryCommand(command);
}
