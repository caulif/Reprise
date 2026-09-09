import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHarnessAgents } from "../src/application/harness-agents.js";
import { PiModelCaller } from "../src/infrastructure/agent/model-caller.js";
import { readHarnessModelConfig } from "../src/infrastructure/harness-model-config.js";
import { packControllerEvalCase } from "../test/controller-eval-briefing.js";
import { familyRepresentativeCases, scoreControllerEval } from "../test/controller-eval-cases.js";

function publicFailureReason(message: string): string | undefined {
  if (message === "invalid JSON" || message === "unknown evidence reference") return message;
  if (message === "Agent session is closed.") return message;
  if (message.startsWith("schema validation failed")) return message.slice(0, 96);
  if (message.startsWith("message ") || message.startsWith("opening decision")) return message.slice(0, 96);
  if (/^(AbortError|TimeoutError|fetch failed)\b/.test(message)) return message.slice(0, 96);
  return undefined;
}

if (process.env.REPRISE_REAL_MODEL !== "1") {
  throw new Error("Set REPRISE_REAL_MODEL=1 to run the Controller capability lane.");
}
const dataDir = process.argv[2] ?? ".reprise";
const outPath = process.argv[3];
if (!outPath || !isAbsolute(outPath)) {
  throw new Error("Usage: evaluate:controller <dataDir> <absolute-report.json>");
}
const config = await readHarnessModelConfig(dataDir);
if (!config) throw new Error(`No harness model config in ${dataDir}.`);

const agents = createHarnessAgents(config, new PiModelCaller(config), { budget: { callTimeoutMs: 180_000, maxStructuredRepairAttempts: 1 } });
const rows: Array<{
  id: string;
  expectedType: string;
  actualType?: string;
  match: boolean;
  kind?: string;
  status: string;
  failureCode?: string;
  failureKind?: string;
  failureReason?: string;
}> = [];
const workspace = await mkdtemp(join(tmpdir(), "reprise-controller-eval-"));
for (const item of familyRepresentativeCases()) {
  const packed = await packControllerEvalCase(join(workspace, item.id), item);
  const result = await agents.controller.decide(packed.context, packed.tools);
  agents.controller.release?.(packed.context.runId);
  if (result.status !== "completed") {
    const reason = result.status === "failed" ? publicFailureReason(result.failure.message) : undefined;
    rows.push({
      id: item.id,
      expectedType: item.expected.type,
      match: false,
      status: result.status,
      ...(result.status === "failed"
        ? {
            failureCode: result.failure.code,
            ...(result.failure.kind ? { failureKind: result.failure.kind } : {}),
            ...(reason ? { failureReason: reason } : {}),
          }
        : {}),
    });
    continue;
  }
  const scored = scoreControllerEval(result.value, item.expected);
  rows.push({
    id: item.id,
    expectedType: item.expected.type,
    actualType: result.value.type,
    match: scored.match,
    kind: scored.kind,
    status: "completed",
  });
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(resolve(outPath), `${JSON.stringify({ schemaVersion: 2, lane: "capability", rows }, null, 2)}\n`, { flag: "wx" });
