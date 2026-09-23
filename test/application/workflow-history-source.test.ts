import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentWorkflow } from "../../src/application/experiment-workflow.js";
import type { HarnessAgents } from "../../src/application/harness-agents.js";
import { createProductLookup } from "../../src/products/index.js";
import { codexProductPack } from "../../src/products/packs/codex/pack.js";
import { claudeCodeProductPack } from "../../src/products/packs/claude-code/pack.js";
import { input, VerifiedRuntime } from "../codex-experiment-support.js";

function historicalPatchEvents() {
  const patch = "*** Begin Patch\n*** Add File: pelican_bike.html\n+<!doctype html>\n+<html>bike</html>\n*** End Patch";
  return [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call", call_id: "write", name: "exec",
        input: `const patch = ${JSON.stringify(patch)}; const r = await tools.apply_patch(patch); text(r);`,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output", call_id: "write",
        output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: "{}" }],
      },
    },
  ];
}

test("live and persisted comparison extract Codex history when the candidate is Claude Code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-workflow-history-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtime = new VerifiedRuntime();
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "fixture\n");
  const workflow = createExperimentWorkflow({
    dataDir: base.dataDir,
    runtime,
    lookup: createProductLookup([codexProductPack, claudeCodeProductPack]),
    agents: async () => ({
      controller: base.controller, comparison: base.comparison, recovery: {},
      config: { ...base.agentConfig, recoveryBudget: base.agentConfig.budget },
    }) as unknown as HarnessAgents,
    now: () => base.now,
    defaults: { policy: base.policy },
  });
  const taskCase = { ...base.taskCase, historicalEvents: historicalPatchEvents() };
  const candidate = { ...base.candidate, productId: "claude-code" };
  const handle = await workflow.start({
    taskCase, candidate, sourceRoot: base.sourceRoot, compare: true,
    experimentId: "cross-product-history", runId: "run-cross", onEvent: () => {},
  });
  const result = await handle.result;
  assert.equal(runtime.created, 1);
  const attemptsRoot = join(result.experimentRoot, "comparison-attempts");
  const firstAttempt = (await readdir(attemptsRoot))[0];
  assert.ok(firstAttempt);
  const first = JSON.parse(await readFile(join(attemptsRoot, firstAttempt, "derived-history", "manifest.json"), "utf8")) as {
    extractorVersion: string; artifacts: Array<{ logicalPath: string }>;
  };
  assert.equal(first.extractorVersion, "codex-historical-artifacts/v1");
  assert.equal(first.artifacts[0]?.logicalPath, "pelican_bike.html");

  await workflow.comparePersisted("cross-product-history", undefined, undefined, "run-cross");
  const attempts = await readdir(attemptsRoot);
  assert.equal(attempts.length, 2);
  const secondAttempt = attempts.find((name) => name !== firstAttempt);
  assert.ok(secondAttempt);
  const second = JSON.parse(await readFile(join(attemptsRoot, secondAttempt, "derived-history", "manifest.json"), "utf8")) as typeof first;
  assert.equal(second.extractorVersion, first.extractorVersion);
  assert.deepEqual(second.artifacts, first.artifacts);
});
