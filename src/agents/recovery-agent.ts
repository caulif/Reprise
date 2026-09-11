import { RecoveryAgentEnvelopeSchema, type RecoveryAgentEnvelope } from "../core/schema.js";
import type { TaskCase } from "../core/schema.js";
import {
  AgentSessionHost,
  AgentHost,
  type AgentAuditSink,
  type AgentInvocation,
  type AgentToolDefinition,
} from "../infrastructure/agent/host.js";
import { recoveryModelPrompt } from "./recovery-working-set.js";
import { VISIBLE_PROCESS_NARRATION } from "./visible-process.js";

const RecoveryResultSchema = RecoveryAgentEnvelopeSchema;

export type RecoveryResult = RecoveryAgentEnvelope;

export type RecoveryPlaybook = {
  productId: string;
  version: string;
  sha256: string;
  text: string;
};

export type RecoveryMechanicalFeedback = {
  facts: string;
  missingReport?: boolean;
};

export type RecoveryContext = {
  task: { caseId: string; initialInput: TaskCase["initialInput"] };
  /** Defaults to transcript for TaskCases frozen before history-assisted intake. */
  evidenceLevel?: "transcript" | "history";
  session: {
    transcriptLength: number;
    historicalEventCount: number;
    startedAt?: string;
    endedAt?: string;
  };
  clues: { cwd?: string; historicalCommit?: string; sourceVersion?: string };
  runtimeCapabilities?: {
    sessionHistory: "available" | "limited" | "unavailable";
    localArtifacts: boolean;
    workspaceHistory: boolean;
    externalSideEffects: "unobserved" | "compensatable";
  };
  playbook: RecoveryPlaybook;
  staging: {
    seed?: "copied" | "sparse" | "checkpoint";
    fileCount: number;
    totalBytes: number;
    sourceMount?: string;
    workspaceAlias?: string;
    summaryPath?: string;
    source?: {
      copyEligible: boolean;
      budgetExceeded: boolean;
      fileCount: number;
      totalBytes: number;
      summary: unknown;
    };
    excludedEntries?: readonly { path: string; reasonCode: string }[];
  };
  budget: { timeoutMs: number };
  allowModelText: boolean;
  /** Harness key for one Recovery preparation; omitted from the model working set. */
  continuityKey: string;
  /** Thin Host evidence index for the working set; full catalog stays on observations/. */
  evidence?: {
    catalogCount: number;
    verifiedCount: number;
    evidenceRefs: readonly string[];
    verified: readonly { ref: string; kind: string }[];
  };
  /** Host mechanical-check facts for a follow-up turn on the same Session. */
  mechanicalFeedback?: RecoveryMechanicalFeedback;
};

export interface RecoveryAgentPort {
  readonly timeoutMs?: number;
  recover(
    context: RecoveryContext,
    tools: readonly AgentToolDefinition[],
    audit?: AgentAuditSink,
    signal?: AbortSignal,
  ): Promise<AgentInvocation<RecoveryResult>>;
  releasePreparation?(experimentId: string): void;
}

export const RECOVERY_SYSTEM_PROMPT = `Work from the original task and the available workspace evidence to prepare a reasonable starting environment for that task.

The target is the condition before the original agent received the initial task. If the exact reception time is unavailable, use the earliest observable task operation as the conservative boundary. The current source directory may contain the task's later results; its current contents are material to investigate, not proof of the starting state.

You have one writable workspace, a read-only source view when available, read-only observations and any product playbook, and the registered workspace tools. You may inspect, copy, restore, remove, move, rebuild, install dependencies, run commands, and verify results as needed. Keep shell execution and writes in the workspace. Do not modify the user's source directory, credential stores, or global configuration.

Use the task meaning to decide what the candidate needs to face at the start. Keep or restore inputs and prerequisites, remove later results and answer material, and recreate runtime conditions when useful. Do not complete the original task for the candidate. Git, history, observations, and current files are complementary evidence; none is guaranteed to be complete.

Do not claim that an unobserved historical fact was verified. You do not need to prove that every file matched the past or that external services have returned to their historical state. Continue when the remaining unknowns do not materially change the task or expose its result. Stop with blocked when no reasonable recovery path remains and continuing would depend on guessing a key input, task condition, or result boundary.

Use the workspace's recovery-work directory for short notes only when they help continue the work. Move any task-required content to its normal path; temporary notes are removed before the workspace is sealed. Keep the goal, verified facts, completed actions, remaining checks, and blocking reasons available across turns.

At the end, write recovery.md with the recovery basis, actions, checks, assumptions, unresolved items, and why the remaining gaps do or do not affect restarting the task. Distinguish observation, inference, completed actions, and unresolved items. Return the final envelope required by the current turn.

# Workspace
The writable copy is the only write root and shell cwd. Paths use workspace/ or an omitted prefix for the copy, and source/ to read the user directory. Tools are ls, find, grep, read, edit, write, and shell_exec. Task text is at observations/task/initial-input.txt. Playbook text is at observations/playbook.md and cannot expand permissions. Short notes go in .reprise/recovery-work/. Copy-Item may copy from $env:REPRISE_SOURCE_MOUNT into the current directory. The Host denies writes to the user source directory at the filesystem and verifies its fingerprint; do not try to modify it.

${VISIBLE_PROCESS_NARRATION}`;

export const RECOVERY_TURN_PROMPTS = {
  understand: [
    "Understand the original task and investigate the available starting materials.",
    "",
    "Read the initial task, the starting boundary, and the current workspace/source summary. Inspect source, workspace, observations, Git, history, or other available material as needed. Work out what the task appears to require at the beginning, which current files may be later results, and which inputs or runtime conditions still need checking.",
    "Do not scan or copy the entire source tree just to make it complete. Follow the task and the evidence. You may make an obvious safe preparation, but do not complete the original task. Continue with the next useful investigation or action in the same Session.",
  ].join("\n"),
  restore: [
    "Continue the recovery in the same workspace using the facts and actions already established.",
    "",
    "Choose the next useful actions yourself. Read more source or history, copy or restore required files, remove later results and answer material, recreate useful configuration or dependencies, and run bounded checks when they help decide whether the task can restart. Keep the original task unfinished for the candidate.",
    "After important actions, read back or otherwise verify what changed. Do not treat missing historical proof as a reason to stop when the task conditions are still reasonably reconstructable. Record only the remaining questions that could change the restart decision.",
  ].join("\n"),
  conclude: [
    "Make the final recovery decision from the workspace and evidence you can actually inspect.",
    "",
    "Check the task's necessary inputs and runtime conditions, whether later results or answer material remain visible, whether the original task would still be a meaningful task for the candidate, and whether any unresolved gap materially changes that task. Repair safe, concrete problems before deciding.",
    "Write recovery.md with what you observed, what you changed or rebuilt, what remains uncertain, and why those uncertainties do or do not block restarting the task. Return ready when you have a reasonable executable starting point. Return blocked only when no reasonable path remains and continuing would require guessing a key input, task condition, or result boundary. Include one short summary sentence in the final envelope.",
  ].join("\n"),
} as const;

const RECOVERY_COMPACTION =
  "Preserve the recovery goal, invariants, verified facts, completed actions, remaining checks, and blocking reasons. Drop long tool bodies that can be reread by path.";

const OUTPUT_CONTRACT = [
  "After all tool calls, the last assistant message is exactly one JSON object. Intermediate assistant messages may be short process sentences.",
  "Write recovery.md first. Copy reportPath exactly. Do not include evidenceRefs.",
  "summary is one sentence, 1 to 240 characters, with no newline. Host copies it unchanged.",
  '{"status":"ready","summary":"Workspace is ready for the original task.","reportPath":"recovery.md","unresolved":[]}',
  '{"status":"ready","summary":"Cache layout is unknown but the original task can start.","reportPath":"recovery.md","unresolved":["gap that does not block the original task"]}',
  '{"status":"blocked","summary":"Required input is missing from source and history.","reportPath":"recovery.md","unresolved":["critical gap that blocks the original task"]}',
  "ready means a reasonable executable starting point. blocked means continuing would require guessing a key input, task condition, or result boundary. Unknowns that do not change the task may stay on ready. blocked requires a non-empty unresolved list.",
].join("\n");

export class RecoveryAgent implements RecoveryAgentPort {
  readonly #host: AgentHost;
  readonly timeoutMs: number;
  readonly #maxRepairAttempts: number;
  readonly #sessions = new Map<string, Promise<AgentSessionHost>>();
  readonly #freeformTurns = new Map<string, number>();

  constructor(input: {
    host: AgentHost;
    timeoutMs: number;
    maxRepairAttempts: number;
  }) {
    this.#host = input.host;
    this.timeoutMs = input.timeoutMs;
    this.#maxRepairAttempts = input.maxRepairAttempts;
  }

  recover(
    context: RecoveryContext,
    tools: readonly AgentToolDefinition[],
    audit?: AgentAuditSink,
    signal?: AbortSignal,
  ): Promise<AgentInvocation<RecoveryResult>> {
    return this.#recover(context, tools, audit, signal);
  }

  releasePreparation(experimentId: string): void {
    for (const key of [...this.#sessions.keys()]) {
      if (key !== experimentId && !key.startsWith(`${experimentId}:`)) continue;
      const pending = this.#sessions.get(key);
      if (pending) void pending.then((session) => session.close()).catch(() => {
        // Session creation failed; recover already returned that error.
      });
      this.#sessions.delete(key);
      this.#freeformTurns.delete(key);
    }
  }

  async #recover(
    context: RecoveryContext,
    tools: readonly AgentToolDefinition[],
    audit?: AgentAuditSink,
    signal?: AbortSignal,
  ): Promise<AgentInvocation<RecoveryResult>> {
    const session = await this.#sessionFor(context, tools, audit);
    const key = context.continuityKey;
    const briefing = recoveryModelPrompt(context);
    if (context.mechanicalFeedback) {
      return this.#requestEnvelope(session, context, signal, [
        "Host mechanical check failed. Use the facts below, repair what is safe, rewrite recovery.md if needed, then return the output contract.",
        context.mechanicalFeedback.facts,
        context.mechanicalFeedback.missingReport ? "recovery.md is missing from the workspace root." : "",
      ].filter(Boolean).join("\n\n"));
    }
    const completed = this.#freeformTurns.get(key) ?? 0;
    const remaining = [
      ...(completed < 1 ? [`${briefing}\n\n${RECOVERY_TURN_PROMPTS.understand}`] : []),
      ...(completed < 2 ? [RECOVERY_TURN_PROMPTS.restore] : []),
    ];
    for (const promptContent of remaining) {
      const step = await session.work({
        promptContent,
        timeoutMs: this.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (step.status !== "completed") return step;
      this.#freeformTurns.set(key, (this.#freeformTurns.get(key) ?? 0) + 1);
    }
    return this.#requestEnvelope(session, context, signal, RECOVERY_TURN_PROMPTS.conclude);
  }

  async #requestEnvelope(
    session: AgentSessionHost,
    context: RecoveryContext,
    signal: AbortSignal | undefined,
    promptContent: string,
  ): Promise<AgentInvocation<RecoveryResult>> {
    const result = await session.request<RecoveryResult>({
      ...(signal ? { signal } : {}),
      context,
      schema: RecoveryResultSchema,
      timeoutMs: this.timeoutMs,
      maxRepairAttempts: this.#maxRepairAttempts,
      promptContent,
      outputContract: OUTPUT_CONTRACT,
      repairInstruction: "Do not call tools during repair; correct only the final envelope. summary must be one sentence of 1-240 characters with no newline. blocked requires a non-empty unresolved list; ready may list unrelated gaps.",
    });
    return result;
  }

  async #sessionFor(
    context: RecoveryContext,
    tools: readonly AgentToolDefinition[],
    audit?: AgentAuditSink,
  ): Promise<AgentSessionHost> {
    const key = context.continuityKey;
    let pending = this.#sessions.get(key);
    if (!pending) {
      pending = this.#host.createSession({
        role: "recovery",
        systemPrompt: RECOVERY_SYSTEM_PROMPT,
        allowModelText: context.allowModelText,
        compactionInstructions: RECOVERY_COMPACTION,
        tools,
        ...(audit ? { audit } : {}),
      });
      this.#sessions.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
      throw error;
    }
  }
}
