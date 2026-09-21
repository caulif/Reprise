import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryAgentPort } from "../../src/agents/recovery-agent.js";
import { recoverExperiment } from "../../src/application/recovery/recover.js";
import { failureExplanationKey, recoveryFailureDecision } from "../../src/application/recovery/fail.js";
import { recoveryViewFromAttempt } from "../../src/application/recovery/view.js";
import { createTheme } from "../../src/tui/theme.js";
import { renderConfirmation } from "../../src/tui/pages/run.js";
import { now, VerifiedRuntime, input } from "../codex-experiment-support.js";

test("blocked Recovery TUI sentence equals the Agent summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-blocked-summary-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const summary = "The original spreadsheet is missing from source.";
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nBlocked.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "blocked-summary",
        value: { status: "blocked", summary, unresolved: ["workbook.xlsx"] },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-blocked-summary",
    runId: "recovery-blocked-summary-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.recovery.status, "completed");
  if (attempt.recovery.status === "completed") assert.equal(attempt.recovery.value.summary, summary);
  assert.equal(attempt.baseline.recovery?.summary, summary);
  const view = recoveryViewFromAttempt(attempt);
  const text = renderConfirmation(createTheme(120, false), 120, {
    candidate: { candidateId: "candidate-test", productId: "codex", requestedModel: "gpt-5" },
    step: 3,
    sourceRoot: base.sourceRoot,
    effort: "high",
    harnessModel: "gpt-5",
    harnessAuthOk: true,
    productLabel: "Codex",
    locale: "en",
    recovery: {
      status: "blocked",
      summary: view.baseline.recovery?.summary,
      unresolved: view.baseline.recovery?.unresolved ?? [],
      changedPathCount: 0,
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: "unavailable", resolved: { executable: "codex", resolvedModel: "gpt-5" }, limitations: [], comparisonClass: "observational" },
  } as never).join("\n");
  assert.match(text, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("failureExplanationKey maps Host failures to TUI keys", () => {
  assert.equal(failureExplanationKey("source_tripwire_failed").key, "recoverySourceChanged");
  assert.equal(failureExplanationKey("provider_validation_failed", { message: "recovery.md is missing from staging" }).key, "recoveryReportMissing");
  assert.equal(failureExplanationKey("provider_validation_failed").key, "recoveryStagingInvalid");
  assert.equal(failureExplanationKey("preflight_failed").key, "recoveryPreflightFailed");
  assert.equal(failureExplanationKey("agent_invalid_output").key, "harnessProtocol");
  assert.equal(failureExplanationKey("runner_crashed").key, "harnessFailure");
  assert.equal(failureExplanationKey("agent_model_failed", { kind: "authentication" }).key, "harnessAuthentication");
  assert.equal(failureExplanationKey("agent_model_failed", { kind: "timeout" }).key, "harnessTransient");
  assert.equal(failureExplanationKey("agent_model_failed", { kind: "protocol" }).key, "harnessProtocol");
});

test("recovery failure decisions expose only user actions", () => {
  assert.deepEqual(recoveryFailureDecision("agent_model_failed", { kind: "timeout" }), { category: "transient", retryable: true, action: "retry" });
  assert.deepEqual(recoveryFailureDecision("agent_model_failed", { kind: "authentication" }), { category: "authentication", retryable: false, action: "config" });
  assert.deepEqual(recoveryFailureDecision("source_tripwire_failed"), { category: "source_changed", retryable: false, action: "refreeze" });
  assert.deepEqual(recoveryFailureDecision("agent_invalid_output", { kind: "protocol" }), { category: "protocol", retryable: true, action: "diagnose" });
});
