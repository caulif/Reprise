import test from "node:test";
import assert from "node:assert/strict";
import { RecoveryAgent, type RecoveryContext } from "../src/agents/recovery-agent.js";
import { PiAgentHost, type PiTextCaller } from "../src/infrastructure/pi-agent-host.js";

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
    resolved: { patches: [], preimages: [], evidenceRefs: ["event:transcript-7-8ea74b73785ba41a"] },
    playbook: { productId: "test", version: "test/v1", sha256: "a".repeat(64), text: "normal playbook" },
    staging: { fileCount: 0, totalBytes: 0 },
    budget: { timeoutMs: 50 },
    allowModelText: true,
    continuityKey: "case-1",
  };
}

test("Recovery remaps recovered output that still has unresolved facts to partial", async () => {
  const recovery = new RecoveryAgent({
    host: new PiAgentHost(
      caller([
        JSON.stringify({
          status: "recovered",
          reportPath: "recovery.md",
          unresolved: ["uncertain starting state"],
          evidenceRefs: ["event:transcript-7-8ea74b73785ba41a"],
        }),
      ]),
    ),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await recovery.recover(recoveryContext(), []);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.value.status, "partial");
    assert.deepEqual(result.value.unresolved, ["uncertain starting state"]);
  }
});

test("Recovery keeps recovered when unresolved is empty", async () => {
  const recovery = new RecoveryAgent({
    host: new PiAgentHost(
      caller([
        JSON.stringify({
          status: "recovered",
          reportPath: "recovery.md",
          unresolved: [],
          evidenceRefs: ["event:transcript-7-8ea74b73785ba41a"],
        }),
      ]),
    ),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await recovery.recover(recoveryContext(), []);
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.value.status, "recovered");
});

test("Recovery investigation and feedback reuse one Pi session", async () => {
  let created = 0;
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession() {
        created += 1;
        return {
          append: async () =>
            JSON.stringify({
              status: "partial",
              reportPath: "recovery.md",
              unresolved: ["still checking"],
              evidenceRefs: ["event:transcript-7-8ea74b73785ba41a"],
            }),
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const context = recoveryContext();
  await recovery.recover(context, []);
  await recovery.recover({ ...context, readinessFeedback: { status: "not_ready", feedback: "gap", missingPaths: ["a"] } }, []);
  assert.equal(created, 1);
  recovery.releasePreparation("case-1");
});

