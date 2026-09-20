import test from "node:test";
import assert from "node:assert/strict";
import { ComparisonAgent, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { AgentHost } from "../../src/infrastructure/agent/host.js";

function context(attemptId = "attempt-timeout-1"): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId,
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [],
    telemetry: [],
    artifactRefs: [],
    allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: {
      run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
      models: { candidate: "fixture" },
      activity: {},
      limits: { triggered: [] },
      runtime: { productId: "codex" },
      delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" },
      replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" },
    },
  };
}

test("Comparison timeout maps to agent_timeout and stops further model rounds", async () => {
  let prompts = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => {
          prompts += 1;
          return new Promise<string>(() => {});
        },
        cancel() {},
      }),
    }),
    timeoutMs: 20,
    maxRepairAttempts: 0,
  });
  const result = await comparison.compare(context());
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failure.code, "agent_timeout");
    assert.equal(result.failure.kind, "timeout");
  }
  assert.equal(prompts, 1);
});

test("Comparison user cancel beats timeout and does not retry", async () => {
  let prompts = 0;
  let resolveAppend!: (value: string) => void;
  const abort = new AbortController();
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async (input) => {
          prompts += 1;
          abort.abort();
          return new Promise<string>((resolve) => {
            resolveAppend = resolve;
            input.signal?.addEventListener(
              "abort",
              () => {
                /* provider observes cancel; late text must not complete */
              },
              { once: true },
            );
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 1,
  });
  const pending = comparison.compare(context("attempt-cancel-1"), [], undefined, abort.signal);
  await new Promise((done) => setImmediate(done));
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(prompts, 1);
  resolveAppend?.(JSON.stringify({ status: "completed", evidenceRefs: [] }));
  assert.equal((await pending).status, "cancelled");
});

test("Comparison cancel after hang does not start envelope repair", async () => {
  let prompts = 0;
  const abort = new AbortController();
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => {
          prompts += 1;
          if (prompts === 1) {
            queueMicrotask(() => abort.abort());
            return new Promise<string>(() => {});
          }
          throw new Error("must not request after cancel");
        },
        cancel() {},
      }),
    }),
    timeoutMs: 30_000,
    maxRepairAttempts: 2,
  });
  const result = await comparison.compare(context("attempt-cancel-2"), [], undefined, abort.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(prompts, 1);
});
