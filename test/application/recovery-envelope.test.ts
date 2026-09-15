import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { RecoveryAgentEnvelopeSchema } from "../../src/core/schema.js";
import { RecoveryAgent, RECOVERY_TURN_PROMPTS, RECOVERY_FREEFORM_REQUEST_IDS, completedRecoveryFreeformTurns, type RecoveryContext } from "../../src/agents/recovery-agent.js";
import { PiAgentHost, type PiTextCaller } from "../../src/infrastructure/agent/host.js";

function caller(responses: string[]): PiTextCaller {
  return {
    createSession() {
      return {
        append: async () => responses.shift() ?? "",
        cancel() {},
      };
    },
  };
}

function recoveryContext(): RecoveryContext {
  return {
    task: {
      caseId: "case-1",
      initialInput: { id: "message-1", role: "user", text: "Recover it." },
    },
    session: { transcriptLength: 0, historicalEventCount: 0 },
    clues: {},
    playbook: { productId: "test", version: "test/v1", sha256: "a".repeat(64), text: "normal playbook" },
    staging: { fileCount: 0, totalBytes: 0 },
    budget: { timeoutMs: 50 },
    allowModelText: true,
    continuityKey: "case-1",
  };
}

const readyEnvelope = JSON.stringify({
  status: "ready",
  summary: "Ready for the original task.", unresolved: [],
});

test("Recovery uses three turns and only validates the final envelope", async () => {
  const appended: string[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async ({ content }) => {
          appended.push(content);
          if (appended.length < 3) return "working";
          return readyEnvelope;
        },
        cancel() {},
      }),
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await recovery.recover(recoveryContext(), []);
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.value.status, "ready");
  assert.equal(appended.length, 3);
  assert.match(appended[0] ?? "", /Turn 1: understand the task/);
  assert.match(appended[1] ?? "", new RegExp(RECOVERY_TURN_PROMPTS.restore.slice(0, 12)));
  assert.match(appended[2] ?? "", /Turn 3: check your work/);
  assert.doesNotMatch(appended[0] ?? "", /Return only JSON matching the contract|输出契约/);
});

test("Recovery accepts ready with unrelated unresolved gaps", async () => {
  const recovery = new RecoveryAgent({
    host: new PiAgentHost(
      caller(["ok", "ok", JSON.stringify({
        status: "ready",
        summary: "Ready for the original task.", unresolved: ["cache layout unknown"],
      })]),
    ),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await recovery.recover(recoveryContext(), []);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.value.status, "ready");
    assert.deepEqual(result.value.unresolved, ["cache layout unknown"]);
  }
});

test("Recovery investigation and mechanical feedback reuse one Pi session", async () => {
  let created = 0;
  const appended: string[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            return readyEnvelope;
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  await recovery.recover(context, []);
  await recovery.recover({ ...context, mechanicalFeedback: { facts: "recovery.md is missing" } }, []);
  assert.equal(created, 1);
  assert.equal(appended.length, 4);
  assert.match(appended[3] ?? "", /The Host's mechanical check failed|recovery.md is missing/);
  await recovery.releasePreparation("case-1");
});

test("model request failure keeps the Session and retries remaining turns", async () => {
  let created = 0;
  const appended: string[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (appended.length === 1) throw new Error("transient model failure");
            if (appended.length < 4) return "working";
            return readyEnvelope;
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  const first = await recovery.recover(context, []);
  assert.equal(first.status, "failed");
  const second = await recovery.recover(context, []);
  assert.equal(second.status, "completed");
  assert.equal(created, 1);
  assert.match(appended[0] ?? "", /Turn 1: understand the task/);
  assert.match(appended[1] ?? "", /Turn 1: understand the task/);
  assert.match(appended[2] ?? "", new RegExp(RECOVERY_TURN_PROMPTS.restore.slice(0, 12)));
  await recovery.releasePreparation("case-1");
});

test("failed envelope keeps the Session and does not replay completed freeform turns", async () => {
  let created = 0;
  const appended: string[] = [];
  const auditEvents: { type: string; role?: string; payload?: unknown }[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (appended.length < 3) return "working";
            if (appended.length === 3) return "{";
            return readyEnvelope;
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  const audit = { append: async (event: (typeof auditEvents)[number]) => { auditEvents.push(event); } };
  const first = await recovery.recover(context, [], audit);
  assert.equal(first.status, "failed");
  const second = await recovery.recover({
    ...context,
    completedFreeformTurns: completedRecoveryFreeformTurns(auditEvents),
  }, [], audit);
  assert.equal(second.status, "completed");
  assert.equal(created, 1);
  assert.equal(appended.filter((item) => item.includes("Turn 1: understand the task")).length, 1);
  await recovery.releasePreparation("case-1");
});

test("completedRecoveryFreeformTurns counts request ids and resets after workspace damage", () => {
  assert.equal(completedRecoveryFreeformTurns([]), 0);
  assert.equal(completedRecoveryFreeformTurns([
    { type: "agent.invocation_completed", role: "recovery", payload: { requestId: RECOVERY_FREEFORM_REQUEST_IDS.understand } },
  ]), 1);
  assert.equal(completedRecoveryFreeformTurns([
    { type: "agent.invocation_completed", payload: { role: "recovery", requestId: RECOVERY_FREEFORM_REQUEST_IDS.understand } },
    { type: "agent.invocation_completed", payload: { role: "recovery", requestId: RECOVERY_FREEFORM_REQUEST_IDS.restore } },
  ]), 2);
  assert.equal(completedRecoveryFreeformTurns([
    { type: "agent.invocation_completed", payload: { role: "recovery", requestId: RECOVERY_FREEFORM_REQUEST_IDS.understand } },
    { type: "recovery.model_retry", payload: { previousFailure: "workspace_damaged" } },
  ]), 0);
});

test("Recovery envelope rejects empty, overlong, and multiline summaries", () => {
  const base = { status: "ready" as const, reportPath: "recovery.md" as const, unresolved: [] };
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, { ...base, summary: "Ready for the original task." }), true);
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, { ...base, summary: "" }), false);
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, { ...base, summary: "x".repeat(241) }), false);
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, { ...base, summary: "question-1/README.md and sop-001.html are present." }), true);
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, { ...base, summary: "One sentence.\nSecond sentence." }), false);
  assert.equal(Value.Check(RecoveryAgentEnvelopeSchema, {
    status: "blocked",
    summary: "Ready for the original task.", unresolved: [],
  }), false);
});

test("Recovery investigation restart after releasePreparation begins at the understand turn", async () => {
  let created = 0;
  const appended: string[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (appended.length % 3 !== 0) return "working";
            return readyEnvelope;
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  await recovery.recover(context, []);
  await recovery.releasePreparation("case-1");
  await recovery.recover(context, []);
  assert.equal(created, 2);
  assert.equal(appended.filter((item) => item.includes("Turn 1: understand the task")).length, 2);
  await recovery.releasePreparation("case-1");
});

test("invalid summary fails the last turn without rewriting Host text", async () => {
  const recovery = new RecoveryAgent({
    host: new PiAgentHost(caller(["ok", "ok", JSON.stringify({
      status: "ready",
      summary: "Too long. And two sentences.",
      reportPath: "recovery.md",
      unresolved: [],
    })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await recovery.recover(recoveryContext(), []);
  assert.equal(result.status, "failed");
});

test("new Session after two completed freeform turns prepends the recovery briefing", async () => {
  let created = 0;
  const appended: string[] = [];
  const auditEvents: { type: string; role?: string; payload?: unknown }[] = [];
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (created === 1 && appended.length < 3) return "working";
            return readyEnvelope;
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  const audit = { append: async (event: (typeof auditEvents)[number]) => { auditEvents.push(event); } };
  await recovery.recover(context, [], audit);
  await recovery.releasePreparation("case-1");
  const second = await recovery.recover({
    ...context,
    completedFreeformTurns: completedRecoveryFreeformTurns(auditEvents),
  }, [], audit);
  assert.equal(second.status, "completed");
  assert.equal(created, 2);
  assert.equal(completedRecoveryFreeformTurns(auditEvents), 2);
  assert.match(appended[3] ?? "", /# Recovery briefing/);
  assert.match(appended[3] ?? "", /Turn 3: check your work/);
  await recovery.releasePreparation("case-1");
});
