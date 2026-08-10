import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { assertCodexSmokeAcceptanceRecord } from '../dist/src/products/codex/smoke-gate.js';
import { EXPERIMENT_APPLICATION_EFFORT, EXPERIMENT_APPLICATION_MODEL } from '../dist/src/products/codex/text-caller.js';
import { runCodexExperiment } from './codex-real-runner.mjs';

const CANDIDATE_MODEL = 'gpt-5.6-luna';
const CANDIDATE_EFFORT = 'high';
const SMOKE_PROMPT = 'This is a bounded Reprise protocol smoke test. Reply with exactly LUNA_VERTICAL_SMOKE_OK. Do not invoke tools or access files.';

async function main() {
  if (process.env.REPRISE_RUN_CODEX_SMOKE !== '1') throw new Error('Set REPRISE_RUN_CODEX_SMOKE=1 to run the real Codex smoke.');
  const dataDir = requiredDataDir(process.argv.slice(2));
  const now = new Date().toISOString();
  const suffix = hash(`${now}:${process.pid}`).slice(0, 16);
  const caseId = `case-smoke-${suffix}`;
  const experimentId = `experiment-smoke-${suffix}`;
  const runId = `run-smoke-${suffix}`;
  const sourceRoot = join(dataDir, 'smoke-source', caseId);
  await mkdir(sourceRoot, { recursive: true });
  const result = await runCodexExperiment({
    dataDir, caseId, experimentId, runId, sourceRoot, now,
    taskCase: taskFor(caseId, now),
    candidate: { candidateId: `codex-${CANDIDATE_MODEL}`, productId: 'codex', requestedModel: CANDIDATE_MODEL },
    candidateEffort: CANDIDATE_EFFORT,
    // ponytail: CandidateRun needs one unused turn of budget to return the second settlement to its controller.
    policy: { wallClockMs: 120_000, maxTargetTurns: 3, maxModelCalls: 2, turnTimeoutMs: 90_000, heartbeatTimeoutMs: 90_000, maxConsecutiveNoProgress: 1 },
    agentConfig: { providerId: 'codex-app-server', requestedModel: EXPERIMENT_APPLICATION_MODEL, budget: { callTimeoutMs: 90_000, maxStructuredRepairAttempts: 1, maxProviderRetries: 0 } },
    currentSummary: 'The bounded Luna smoke turn settled. No tool execution was approved.',
    createAcceptance: (run) => acceptanceRecord({ now, caseId, experimentId, runId, resolved: run.resolved, reportPath: run.reportPath, controllerFallback: run.decision.usedFallback, followupSubmission: run.followupSubmission }),
    assertAcceptance: assertCodexSmokeAcceptanceRecord,
    acceptanceFileName: 'codex-smoke-acceptance.json',
  });
  console.log(JSON.stringify({ caseId, experimentId, runId, candidate: { model: CANDIDATE_MODEL, effort: CANDIDATE_EFFORT }, experimentApplication: { model: EXPERIMENT_APPLICATION_MODEL, effort: EXPERIMENT_APPLICATION_EFFORT }, reportPath: result.reportPath, controllerUsedFallback: result.decision.usedFallback, comparisonUsedFallback: result.comparison.result.usedFallback }, null, 2));
}

function requiredDataDir(args) {
  const index = args.indexOf('--data-dir');
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || args.length !== 2 || !isAbsolute(value)) throw new Error('Usage: node scripts/codex-real-smoke.mjs --data-dir <absolute-directory>');
  return resolve(value);
}

function taskFor(caseId, now) {
  const sourceHash = hash(`${caseId}:${SMOKE_PROMPT}`);
  return {
    schemaVersion: 1, caseId, source: { productId: 'codex', sessionId: `reprise-smoke-${caseId}` },
    initialInput: { id: `message-${caseId}`, role: 'user', text: SMOKE_PROMPT },
    transcript: [{ id: `message-${caseId}`, role: 'user', text: SMOKE_PROMPT }], historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, environmentBaseline: { status: 'available', artifactRefs: [] },
    taskContext: { kind: 'protocol_smoke_nonhistorical', limitation: 'This verifies the Runtime and Experiment Application path; it is not a historical-task benchmark.' },
    provenance: { packVersion: 'reprise-real-smoke/v1', importedAt: now, sourceHash },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: hash(`${sourceHash}:reprise-real-smoke/v1`),
  };
}

function acceptanceRecord({ now, caseId, experimentId, runId, resolved, reportPath, controllerFallback, followupSubmission }) {
  return {
    schemaVersion: 1, status: 'passed', recordedAt: now, taskCaseId: caseId, experimentId, runId,
    executable: resolved.executable, ...(resolved.version ? { version: resolved.version } : {}), requestedModel: resolved.requestedModel, resolvedModel: resolved.resolvedModel,
    fidelity: 'partial', termination: 'completed', cleanup: 'released', reportPath,
    smokeSteps: { started: true, initialAdmission: true, firstTurnSettlement: true, followupSubmission, stopped: true },
    humanJudgment: {
      rawEvidence: 'The append-only trace contains the app-server lifecycle and native turn settlement.',
      artifacts: 'This protocol smoke intentionally has no candidate artifacts.',
      traceAndReport: 'The report was rendered from the persisted RunRecord and comparison result.',
      knownLimitations: `Non-historical protocol smoke; model resolution remains ${resolved.resolvedModel}; controller fallback=${controllerFallback}.`, conclusion: 'passed',
    },
  };
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

main().catch((error) => { console.error(`Real Codex smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });