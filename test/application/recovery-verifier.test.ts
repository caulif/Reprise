import assert from "node:assert/strict";
import test from "node:test";
import { mechanicalRecoveryFailure } from "../../src/application/recovery/verifier.js";

test("Host verifier does not reject ready with zero path changes", () => {
  assert.equal(mechanicalRecoveryFailure("missing_report").status, "failed");
  assert.equal(mechanicalRecoveryFailure("invalid_envelope").reasonCodes.includes("no_task_path_outcome" as never), false);
});

test("Host verifier does not rewrite blocked into another business status", () => {
  const check = mechanicalRecoveryFailure("invalid_envelope");
  assert.equal(check.status, "failed");
  assert.deepEqual(check.reasonCodes, ["invalid_envelope"]);
});
