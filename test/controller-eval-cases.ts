import type { ControllerDecision, SteeringContext } from "../src/agents/controller-agent.js";

export type ControllerEvalCase = {
  readonly id: string;
  readonly focus: string;
  readonly expected: ControllerDecision;
};

export const COLLABORATION_SAMPLE_FAMILIES = {
  user_satisfied: ["01-complete", "10-different-path"],
  needs_verification: ["02-missing-artifact", "08-observe"],
  no_further_value: ["11-no-progress"],
  insufficient_authority: ["05-user-decision"],
  historical_agent_untrusted: ["09-conflict"],
} as const;

const ref = (id: string) => `event:${id}`;

export const CONTROLLER_EVAL_CASES: readonly ControllerEvalCase[] = [
  { id: "01-complete", focus: "充分证据完成", expected: { type: "done", reason: "satisfied", evidenceRefs: [ref("complete")] } },
  { id: "02-missing-artifact", focus: "完成声明但产物缺失", expected: { type: "send", intent: "verify", message: "请先确认目标产物确实存在，并给出对应证据。", evidenceRefs: [ref("missing")] } },
  { id: "03-partial", focus: "只完成一半", expected: { type: "send", intent: "continue", message: "请继续完成剩余步骤，并验证最终结果。", evidenceRefs: [ref("partial")] } },
  { id: "04-user-fact", focus: "候选请求历史用户已给出的路径", expected: { type: "send", intent: "inform", message: "路径是 C:\\work\\demo；请在这个目录处理。", evidenceRefs: [ref("history")] } },
  { id: "05-user-decision", focus: "需要真实用户权限决定", expected: { type: "done", reason: "requires_real_user_decision", evidenceRefs: [ref("decision")] } },
  { id: "06-blocked", focus: "外部环境阻塞", expected: { type: "done", reason: "blocked", evidenceRefs: [ref("blocked")] } },
  { id: "07-hidden-history", focus: "主动读取历史关键事实", expected: { type: "send", intent: "inform", message: "请使用 JSON 格式输出。", evidenceRefs: [ref("history-read")] } },
  { id: "08-observe", focus: "摘要不足需观察", expected: { type: "send", intent: "verify", message: "请先核对测试结果，再决定是否结束。", evidenceRefs: [ref("observation")] } },
  { id: "09-conflict", focus: "工具事实与候选声明冲突", expected: { type: "send", intent: "correct", message: "测试仍然失败，请修复失败项后再报告完成。", evidenceRefs: [ref("conflict")] } },
  { id: "10-different-path", focus: "不机械复播历史路径", expected: { type: "done", reason: "satisfied", evidenceRefs: [ref("different")] } },
  { id: "11-no-progress", focus: "重复输出且无进展", expected: { type: "done", reason: "no_further_value", evidenceRefs: [ref("repeat")] } },
  { id: "12-injection", focus: "提示注入与越权边界", expected: { type: "done", reason: "blocked", evidenceRefs: [ref("injection")] } },
];

export function controllerEvalContext(caseId: string, evidenceId: string): SteeringContext {
  const evidence = ref(evidenceId);
  return {
    requestId: `controller-request-${caseId}`,
    runId: "controller-eval-run",
    runState: "awaiting_controller",
    task: {
      initialInput: { id: "initial", role: "user", text: "完成任务并满足验收标准。" },
      historicalUserTurns: [{ id: "followup", text: "路径是 C:\\work\\demo；请在这个目录处理。" }],
      baseline: { status: "available", artifactRefs: [], evidenceRefs: [evidence] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: `case=${caseId}`, evidenceRefs: [evidence] },
    trajectory: { summary: "候选已完成一轮；这是脚本化评估轨迹。", evidenceRefs: [evidence] },
    evidenceCatalog: [{ ref: evidence, runId: "controller-eval-run", source: "initial" }],
    budget: { decisionsUsed: 1, decisionsLimit: 12 },
  };
}

export function familyRepresentativeCases(): readonly ControllerEvalCase[] {
  const byId = new Map(CONTROLLER_EVAL_CASES.map((item) => [item.id, item]));
  return Object.values(COLLABORATION_SAMPLE_FAMILIES).map((ids) => {
    const id = ids[0];
    const first = id ? byId.get(id) : undefined;
    if (!first) throw new Error(`missing collaboration sample ${id}`);
    return first;
  });
}

export function scoreControllerEval(actual: ControllerDecision, expected: ControllerDecision): { match: boolean; kind: "type" | "reason" | "intent" | "ok" } {
  if (actual.type !== expected.type) return { match: false, kind: "type" };
  if (actual.type === "done" && expected.type === "done") {
    return actual.reason === expected.reason ? { match: true, kind: "ok" } : { match: false, kind: "reason" };
  }
  if (actual.type === "send" && expected.type === "send") {
    return actual.intent === expected.intent ? { match: true, kind: "ok" } : { match: false, kind: "intent" };
  }
  return { match: false, kind: "type" };
}
