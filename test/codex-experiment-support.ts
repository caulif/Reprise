import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonAgentPort } from "../src/agents/comparison-agent.js";
import { type ControllerPort } from "../src/agents/controller-agent.js";
import { startExperiment, type ExperimentAgentConfig } from "../src/application/experiment.js";
import type {
  ResolvedRuntime,
  RuntimeModelOffer,
  ProductRuntime,
  TargetEventSink,
  TargetRunner,
} from "../src/core/runtime.js";
import type { TaskCase } from "../src/core/schema.js";
import { ScriptedRunner } from "./support/scripted-runtime.js";
export const now = "2026-08-11T12:00:00.000Z";
export class VerifiedRuntime implements ProductRuntime {
  readonly id = "verified-test";
  created = 0;
  async inspectAvailable() {
    return [
      { productId: "codex", executable: "verified-test", version: "fixture" },
    ] as const;
  }
  async inspectAvailability() {
    return [
      {
        productId: "codex",
        executable: "verified-test",
        observedVersion: "fixture",
        status: "available" as const,
        observedAt: now,
      },
    ];
  }
  async resolve(request: {
    productId: string;
    requestedModel: string;
  }): Promise<ResolvedRuntime> {
    return {
      productId: request.productId,
      executable: "verified-test",
      version: "fixture",
      requestedModel: request.requestedModel,
      resolvedModel: request.requestedModel,
    };
  }
  async validateCandidate(request: {
    productId: string;
    requestedModel: string;
  }) {
    return this.resolve(request);
  }
  async listCatalog(): Promise<readonly RuntimeModelOffer[]> {
    return [{ value: "gpt-5", displayName: "gpt-5", resolvedModel: "gpt-5" }];
  }
  recoveryCapabilities() {
    return {
      sessionHistory: "available" as const,
      localArtifacts: true,
      workspaceHistory: false,
      externalSideEffects: "unobserved" as const,
    };
  }
  async createRunner(
    _runtime: ResolvedRuntime,
    _environment: { environmentId: string; runId: string; root: string },
    sink: TargetEventSink,
    _launch: import("../src/core/schema.js").CandidateLaunchContext,
  ): Promise<TargetRunner> {
    this.created += 1;
    await sink.append({
      type: "runtime.session_started",
      occurredAt: now,
      payload: { productId: "verified-test" },
    });
    await sink.append({
      type: "runtime.tool_finished",
      occurredAt: now,
      payload: { item: { type: "commandExecution", command: "npm test" } },
    });
    await sink.append({
      type: "runtime.visible_output",
      occurredAt: now,
      payload: {
        item: { type: "agentMessage", text: "Focused change completed." },
      },
    });
    return new ScriptedRunner(
      [{ delivery: "accepted", evidence: "native_admission" }],
      [
        {
          turnId: "turn-1",
          status: "waiting_input",
          confidence: "native",
          observedAt: now,
          rawRefs: [],
        },
      ],
    );
  }
}
const controller: ControllerPort = {
  decide: async (ctx) =>
    ctx.phase === "opening" || ctx.runState === "created"
      ? {
          status: "completed",
          sessionId: "controller-1",
          value: {
            type: "send",
            message: ctx.task.initialInput.text,
            intent: "continue",
          },
        }
      : {
          status: "completed",
          sessionId: "controller-1",
          value: { type: "done", reason: "satisfied" },
        },
};
const comparison: ComparisonAgentPort = {
  compare: async (_context, tools = []) => {
    const reader = tools.find((tool) => tool.name === "read")!;
    for (const path of ["briefing/facts/context.json", "briefing/facts/comparison-links.json", "briefing/candidate/process-index.tsv"]) {
      const read = await reader.execute({ path }, new AbortController().signal);
      if (!(read.details as { available?: boolean }).available) throw new Error(`Comparison briefing unavailable: ${path}`);
    }
    const index = await reader.execute({ path: "briefing/INDEX.md" }, new AbortController().signal);
    for (const match of index.content.matchAll(/^- (briefing\/\S+)/gm)) {
      const read = await reader.execute({ path: match[1] }, new AbortController().signal);
      if (!(read.details as { available?: boolean }).available) throw new Error(`Comparison indexed path unavailable: ${match[1]}`);
    }
    const writer = tools.find((tool) => tool.name === "write");
    await writer?.execute(
      { path: "work/comparison-plan.md", content: "# Plan\n\nCompare the delivered files and the final settled turn.\n" },
      new AbortController().signal,
    );
    await writer?.execute(
      { path: "report.html", content: '<!doctype html><style>body{color:rebeccapurple}</style><svg></svg><script>window.ready=true</script><p>Evidence-based narrative.</p><a href="./artifacts/recovery-md">recovery_report</a>' },
      new AbortController().signal,
    );
    return {
      status: "completed",
      sessionId: "comparison-1",
      value: {
        status: "completed",
        reportPath: "report.html",
        evidenceRefs: [],
      },
    };
  },
};
function taskCase(): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-experiment-1",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: {
      id: "message-1",
      role: "user",
      text: "Make the focused change.",
    },
    transcript: [
      { id: "message-1", role: "user", text: "Make the focused change." },
    ],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: {
      historicalBehavior: {
        commands: ["npm test"],
        touchedPaths: ["src/example.ts"],
      },
    },
    provenance: {
      packVersion: "test",
      importedAt: now,
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}
export type PersistedModels = { requestedModel?: string };
export type PersistedAgents = {
  controller?: PersistedModels;
  comparison?: PersistedModels;
};
export async function readJson(
  path: string,
): Promise<PersistedAgents & { spec?: PersistedAgents }> {
  return JSON.parse(await readFile(path, "utf8")) as PersistedAgents & {
    spec?: PersistedAgents;
  };
}
export function input(root: string, runtime: VerifiedRuntime) {
  const dataDir = join(root, "data");
  return {
    dataDir,
    caseId: "case-experiment-1",
    experimentId: "experiment-1",
    runId: "run-1",
    sourceRoot: join(root, "source"),
    taskCase: taskCase(),
    candidate: {
      candidateId: "candidate-1",
      productId: "codex",
      requestedModel: "test-model",
    },
    policy: {
      wallClockMs: 1_000,
      maxTargetTurns: 2,
      maxModelCalls: 2,
      turnTimeoutMs: 1_000,
      maxConsecutiveNoProgress: 1,
    },
    agentConfig: {
      providerId: "test",
      requestedModel: "test-model",
      budget: { callTimeoutMs: 1_000, maxStructuredRepairAttempts: 0 },
    } as ExperimentAgentConfig,
    runtime,
    controller,
    comparison,
    now,
    compare: true,
  };
}
class MultiTurnRuntime implements ProductRuntime {
  readonly id = "multi-turn-test";
  constructor(readonly turns: number) {}
  async inspectAvailable() {
    return [
      { productId: "codex", executable: "multi-turn-test", version: "fixture" },
    ] as const;
  }
  async inspectAvailability() {
    return [
      {
        productId: "codex",
        executable: "multi-turn-test",
        observedVersion: "fixture",
        status: "available" as const,
        observedAt: now,
      },
    ];
  }
  async resolve(request: {
    productId: string;
    requestedModel: string;
  }): Promise<ResolvedRuntime> {
    return {
      productId: request.productId,
      executable: "multi-turn-test",
      version: "fixture",
      requestedModel: request.requestedModel,
      resolvedModel: request.requestedModel,
    };
  }
  async validateCandidate(request: {
    productId: string;
    requestedModel: string;
  }) {
    return this.resolve(request);
  }
  async listCatalog(): Promise<readonly RuntimeModelOffer[]> {
    return [{ value: "gpt-5", displayName: "gpt-5", resolvedModel: "gpt-5" }];
  }
  recoveryCapabilities() {
    return {
      sessionHistory: "available" as const,
      localArtifacts: true,
      workspaceHistory: false,
      externalSideEffects: "unobserved" as const,
    };
  }
  async createRunner(
    _runtime?: ResolvedRuntime,
    _environment?: { environmentId: string; runId: string; root: string },
    _sink?: TargetEventSink,
    _launch?: import("../src/core/schema.js").CandidateLaunchContext,
  ): Promise<TargetRunner> {
    return new ScriptedRunner(
      Array.from({ length: this.turns }, () => ({
        delivery: "accepted" as const,
        evidence: "native_admission",
      })),
      Array.from({ length: this.turns }, (_, index) => ({
        turnId: `turn-${index + 1}`,
        status: "waiting_input" as const,
        confidence: "native" as const,
        observedAt: now,
        rawRefs: [],
      })),
    );
  }
}

export async function terminationOf(
  t: { after(fn: () => Promise<unknown>): void },
  overrides: {
    controller: ControllerPort;
    policy?: Partial<TaskPolicy>;
    turns?: number;
    agentConfig?: ReturnType<typeof input>["agentConfig"];
  },
): Promise<{ kind: string; code: string }> {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-experiment-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const result = await startExperiment({
    ...base,
    runtime: new MultiTurnRuntime(overrides.turns ?? 4),
    controller: overrides.controller,
    policy: { ...base.policy, ...overrides.policy },
    ...(overrides.agentConfig ? { agentConfig: overrides.agentConfig } : {}),
  }).result;
  return result.record.outcome.termination;
}

export type TaskPolicy = ReturnType<typeof input>["policy"];
export const repeatingSend: ControllerPort = {
  decide: async () => ({
    status: "completed",
    sessionId: "controller-1",
    value: { type: "send", message: "Keep going.", intent: "continue" },
  }),
};
export function sendingController(delayMs = 0): ControllerPort {
  let calls = 0;
  return {
    decide: async () => {
      calls += 1;
      if (delayMs)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      return {
        status: "completed",
        sessionId: "controller-1",
        value: {
          type: "send",
          message: `Continue with step ${calls}.`,
          intent: "continue",
        },
      };
    },
  };
}
export const patientPolicy = {
  maxTargetTurns: 8,
  maxModelCalls: 8,
  maxConsecutiveNoProgress: 8,
  wallClockMs: 60_000,
  turnTimeoutMs: 60_000,
};
