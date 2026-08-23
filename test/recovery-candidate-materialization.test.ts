import test from "node:test";
import assert from "node:assert/strict";
import { materializeRecoveryCandidates } from "../src/application/recovery-candidate-materialization.js";

test("Recovery candidate materialization is serial, de-duplicates recipes, and retries EBUSY once", async () => {
  const active: string[] = [];
  const order: string[] = [];
  const attempts = new Map<string, number>();
  const retries: string[] = [];
  const result = await materializeRecoveryCandidates([
    { candidateId: "candidate-a", hypothesisId: "h-a", operations: [] },
    { candidateId: "candidate-b", hypothesisId: "h-b", operations: [] },
    { candidateId: "candidate-c", hypothesisId: "h-c", operations: [{ operation: "modify", path: "x", rationale: "test" }] },
  ], {
    create: async (candidate) => {
      assert.equal(active.length, 0, "candidate copies must not overlap");
      active.push(candidate.candidateId);
      order.push(candidate.candidateId);
      const attempt = (attempts.get(candidate.candidateId) ?? 0) + 1;
      attempts.set(candidate.candidateId, attempt);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active.pop();
      if (candidate.candidateId === "candidate-a" && attempt === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      return candidate.candidateId;
    },
    onRetry: async ({ candidateId, reasonCode }) => { retries.push(`${candidateId}:${reasonCode}`); },
  });
  assert.deepEqual(result, ["candidate-a", "candidate-c"]);
  assert.deepEqual(order, ["candidate-a", "candidate-a", "candidate-c"]);
  assert.deepEqual(retries, ["candidate-a:EBUSY"]);
});

test("Recovery candidate materialization does not retry permanent failures", async () => {
  let calls = 0;
  await assert.rejects(materializeRecoveryCandidates([{ candidateId: "candidate-a", hypothesisId: "h-a", operations: [] }], { create: async () => { calls += 1; throw Object.assign(new Error("bad"), { code: "EINVAL" }); } }), /bad/);
  assert.equal(calls, 1);
});



test("Recovery candidate materialization keeps identical operations from distinct baselines", async () => {
  const created: string[] = [];
  await materializeRecoveryCandidates([
    { candidateId: "candidate-a", hypothesisId: "h-a", baseDigest: "base-a", operations: [] },
    { candidateId: "candidate-b", hypothesisId: "h-b", baseDigest: "base-b", operations: [] },
  ], { create: async ({ candidateId }) => { created.push(candidateId); return candidateId; } });
  assert.deepEqual(created, ["candidate-a", "candidate-b"]);
});
