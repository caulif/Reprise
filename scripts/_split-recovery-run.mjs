import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/application/experiment-recovery-run.ts"), "utf8");
const lines = src.split(/\n/);

const IDENTIFIERS = new Set([
  "input",
  "maxModelAttempts",
  "experimentRoot",
  "provider",
  "store",
  "unsubscribe",
  "staging",
  "recovery",
  "candidateCreated",
  "recoveredPaths",
  "verification",
  "forensicsCompleted",
  "evidenceSourcesAttempted",
  "evidenceSourcesAvailable",
  "hypothesisCount",
  "candidateCount",
  "verifierRejectionReasons",
  "providerFailureRetryable",
  "pathBoundaryRejected",
  "readinessResult",
  "taskOutcome",
  "automaticallyAcceptedBaseline",
  "writerAcquired",
  "toolFailureByTool",
  "lastToolFailureCategory",
  "controlledWriteEntries",
  "recoveryOrchestrator",
  "modelAttempts",
  "attemptMode",
  "preflightOperation",
  "failureStage",
  "pack",
  "playbook",
  "activeStaging",
  "audit",
  "facts",
  "investigation",
  "candidateRecipeDigests",
  "candidateStagings",
  "remainingSearchBudget",
  "executionCandidate",
  "context",
  "tools",
  "readinessContext",
  "readinessSignature",
  "noProgressTurns",
  "graphCandidates",
  "candidateReviews",
  "candidateGraphArtifactId",
  "activeProviderPreview",
  "lifecycleState",
  "moveRecoveryState",
  "recordRecoveryAttempt",
]);

function prefixSession(text) {
  let out = "";
  let i = 0;
  let mode = "code";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        const end = text.indexOf("\n", i);
        out += text.slice(i, end === -1 ? text.length : end);
        i = end === -1 ? text.length : end;
        continue;
      }
      if (c === "/" && n === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = c;
        out += c;
        i += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
        const id = text.slice(i, j);
        const prev = out.match(/[\w.$]+$/)?.[0] ?? "";
        const dotted = prev.endsWith(".");
        if (!dotted && IDENTIFIERS.has(id)) out += `session.${id}`;
        else out += id;
        i = j;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === "`" && c === "\\") {
      out += c + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "\\" && (mode === '"' || mode === "'")) {
      out += c + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === mode) mode = "code";
    out += c;
    i += 1;
  }
  return out;
}

function sliceLines(start, end) {
  return prefixSession(lines.slice(start - 1, end).join("\n"));
}

const header = `import type { RecoveryAttempt } from "./experiment-recovery-types.js";
import type { RecoveryRunSession } from "./experiment-recovery-session.js";
`;

const chunks = [
  ["experiment-recovery-run-preflight.ts", `import { resolve } from "node:path";
import { findProductPack } from "../products/index.js";
import { completeHostCheckpointRecovery } from "./experiment-recovery-checkpoint.js";
import { retryRecoveryPreflight } from "./experiment-recovery-support.js";
import { moveRecoveryState, type RecoveryRunSession } from "./experiment-recovery-session.js";
import type { RecoveryAttempt } from "./experiment-recovery-types.js";
import type { AgentAuditEvent, AgentAuditSink } from "../infrastructure/pi-agent-host.js";

export function createRecoveryAuditSink(session: RecoveryRunSession): AgentAuditSink {
  return {
    append: async (event: AgentAuditEvent): Promise<void> => {
      if (event.type === "agent.tool_failed") {
        const tool = typeof event.payload.tool === "string" ? event.payload.tool : "unknown";
        session.toolFailureByTool.set(tool, (session.toolFailureByTool.get(tool) ?? 0) + 1);
        session.lastToolFailureCategory =
          typeof event.payload.category === "string" ? event.payload.category : "tool_execution_failed";
      }
      await session.store.append({
        type: event.type,
        runId: session.input.runId,
        payload: { role: event.role, sessionId: event.sessionId, ...event.payload },
      });
    },
  };
}

export async function beginRecoveryStaging(session: RecoveryRunSession): Promise<void> {
${sliceLines(153, 215)}
}

export async function tryHostCheckpointRecovery(session: RecoveryRunSession): Promise<RecoveryAttempt | undefined> {
  if (!session.staging || !session.activeStaging) throw new Error("Recovery staging was not prepared.");
  return completeHostCheckpointRecovery({
    input: session.input,
    staging: session.staging,
    experimentRoot: session.experimentRoot,
    store: session.store,
    provider: session.provider,
    activeStaging: session.activeStaging,
    recoveryOrchestrator: session.recoveryOrchestrator,
    readinessResult: session.readinessResult,
    forensicsCompleted: session.forensicsCompleted,
    evidenceSourcesAttempted: session.evidenceSourcesAttempted,
    evidenceSourcesAvailable: session.evidenceSourcesAvailable,
    hypothesisCount: session.hypothesisCount,
    candidateCount: session.candidateCount,
    verifierRejectionReasons: session.verifierRejectionReasons,
    providerFailureRetryable: session.providerFailureRetryable,
    pathBoundaryRejected: session.pathBoundaryRejected,
  });
}
`],
];

void chunks;
void header;
void sliceLines;
void writeFileSync;

console.log("try-block first line 153:", JSON.stringify(lines[152]?.slice(0, 80)));
console.log("line 235:", JSON.stringify(lines[234]?.slice(0, 80)));
console.log("total lines", lines.length);
console.log("sample prefix", prefixSession("staging = await retryRecoveryPreflight(\n  \"begin_recovery_staging\""));
