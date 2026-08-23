import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecoveryCandidate } from "../src/application/recovery-verifier.js";
import type { RecoveryCandidate, RecoveryFact } from "../src/core/schema.js";

const candidate: Pick<RecoveryCandidate, "factRefs"> = { factRefs: ["fact:evidence"] };

function fact(reliability: RecoveryFact["reliability"], pathScope = ["README.md"]): RecoveryFact {
  return {
    factId: "evidence",
    kind: "artifact",
    reliability,
    sourceRefs: ["artifact:case-evidence"],
    observedAt: "2026-08-18T00:00:00.000Z",
    pathScope,
    summary: "fixture evidence",
  };
}

test("weak-evidence candidate stays pending review even after a safe partial recovery", () => {
  assert.deepEqual(
    verifyRecoveryCandidate(candidate, [fact("weak")], ["README.md"], "partial"),
    { status: "pending_user_review", reasonCodes: ["weak_or_incomplete_evidence"] },
  );
});

test("complete strong path evidence permits a recovered candidate to be verified", () => {
  assert.deepEqual(
    verifyRecoveryCandidate(candidate, [fact("strong")], ["README.md"], "recovered"),
    { status: "verified", reasonCodes: ["strong_evidence_complete"] },
  );
});

test("contradictory evidence rejects a candidate before automatic acceptance", () => {
  assert.deepEqual(
    verifyRecoveryCandidate(candidate, [fact("contradicted")], ["README.md"], "recovered"),
    { status: "rejected", reasonCodes: ["contradictory_fact"] },
  );
});


test("rejects a recovered or partial claim with only delivery sinks", () => {
  const candidate = { factRefs: ["fact:strong"] };
  assert.deepEqual(
    verifyRecoveryCandidate(candidate, [fact("strong")], [], "recovered"),
    { status: "rejected", reasonCodes: ["no_task_path_outcome"] },
  );
  assert.deepEqual(
    verifyRecoveryCandidate(candidate, [fact("strong")], [], "partial"),
    { status: "rejected", reasonCodes: ["no_task_path_outcome"] },
  );
});
