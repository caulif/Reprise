import test from "node:test";
import assert from "node:assert/strict";
import { RecoveryAgent, RECOVERY_TURN_PROMPTS, type RecoveryContext } from "../../src/agents/recovery-agent.js";
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
  reportPath: "recovery.md",
  unresolved: [],
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
  assert.match(appended[0] ?? "", /先理解任务/);
  assert.match(appended[1] ?? "", new RegExp(RECOVERY_TURN_PROMPTS.restore.slice(0, 12)));
  assert.match(appended[2] ?? "", /ready 或 blocked/);
  assert.doesNotMatch(appended[0] ?? "", /Return only JSON matching the contract|输出契约/);
});

test("Recovery accepts ready with unrelated unresolved gaps", async () => {
  const recovery = new RecoveryAgent({
    host: new PiAgentHost(
      caller(["ok", "ok", JSON.stringify({
        status: "ready",
        reportPath: "recovery.md",
        unresolved: ["cache layout unknown"],
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
  assert.match(appended[3] ?? "", /mechanical check failed|recovery.md is missing/i);
  recovery.releasePreparation("case-1");
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
  assert.match(appended[0] ?? "", /先理解任务/);
  assert.match(appended[1] ?? "", /先理解任务/);
  assert.match(appended[2] ?? "", new RegExp(RECOVERY_TURN_PROMPTS.restore.slice(0, 12)));
  recovery.releasePreparation("case-1");
});

test("failed envelope keeps the Session and does not replay completed freeform turns", async () => {
  let created = 0;
  const appended: string[] = [];
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
  const first = await recovery.recover(context, []);
  assert.equal(first.status, "failed");
  const second = await recovery.recover(context, []);
  assert.equal(second.status, "completed");
  assert.equal(created, 1);
  assert.equal(appended.filter((item) => item.includes("先理解任务")).length, 1);
  recovery.releasePreparation("case-1");
});
