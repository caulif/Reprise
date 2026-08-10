import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { CandidateRun } from '../dist/src/application/candidate-run.js';
import { comparePersistedFacts } from '../dist/src/application/comparison.js';
import { ControllerAgent } from '../dist/src/agents/controller-agent.js';
import { ComparisonAgent } from '../dist/src/agents/comparison-agent.js';
import { LocalWorkspaceProvider } from '../dist/src/environment/local-workspace-provider.js';
import { PiAgentHost } from '../dist/src/infrastructure/pi-agent-host.js';
import { ExperimentStore, writeImmutableJson } from '../dist/src/infrastructure/store/experiment-store.js';
import { CodexRuntimePort } from '../dist/src/products/codex/runtime-port.js';
import { CodexTextCaller, EXPERIMENT_APPLICATION_EFFORT, EXPERIMENT_APPLICATION_MODEL } from '../dist/src/products/codex/text-caller.js';
import { buildComparisonProjection, renderComparisonReport } from '../dist/src/report/comparison-report.js';
import { createHash } from 'node:crypto';

export const DEFAULT_EXPERIMENT_APPLICATION = {
  providerId: 'codex-app-server',
  requestedModel: EXPERIMENT_APPLICATION_MODEL,
  budget: { callTimeoutMs: 12 * 60_000, maxStructuredRepairAttempts: 1, maxProviderRetries: 0 },
};

/** Runs one isolated real-Codex candidate and leaves reviewable experiment facts on disk. */
export async function runCodexExperiment(input) {
  const { dataDir, caseId, experimentId, runId, sourceRoot, taskCase, candidate, candidateEffort, policy, now } = input;
  if (![dataDir, sourceRoot].every(isAbsolute)) throw new Error('Real Codex experiments require absolute data and source paths.');
  const experimentRoot = join(dataDir, 'experiments', experimentId);
  const workspaceRoot = join(experimentRoot, 'environment');
  const agentConfig = input.agentConfig ?? DEFAULT_EXPERIMENT_APPLICATION;
  const spec = { experimentId, taskCaseId: caseId, candidates: [candidate], controller: agentConfig, comparison: agentConfig, runPolicy: policy, outputRoot: experimentRoot };
  const runtime = new CodexRuntimePort({ effort: candidateEffort, ...(input.sandbox ? { sandbox: input.sandbox } : {}) });
  const resolved = await runtime.resolve({ productId: 'codex', requestedModel: candidate.requestedModel });
  const environmentProvider = new LocalWorkspaceProvider(workspaceRoot);
  const baseline = await environmentProvider.resolveBaseline({ caseId, sourceRoot: resolve(sourceRoot) }, [], {});
  const persistedTaskCase = typeof taskCase === 'function' ? taskCase(baseline) : taskCase;
  const environment = await environmentProvider.prepareRun(baseline, runId);
  const attempt = { schemaVersion: 1, runId, experimentId, caseId, candidate, policy, createdAt: now };
  const manifest = {
    schemaVersion: 1,
    attempt,
    resolvedModel: { requested: resolved.requestedModel, resolved: resolved.resolvedModel },
    runtime: { productId: resolved.productId, executable: resolved.executable, ...(resolved.version ? { version: resolved.version } : {}) },
    environment: { environmentId: environment.environmentId, workspacePath: environment.root },
    controller: resolvedAgentConfig(agentConfig),
    startedAt: now,
  };

  await mkdir(experimentRoot, { recursive: true });
  await writeImmutableJson(join(dataDir, 'cases', caseId, 'case.json'), persistedTaskCase);
  await writeImmutableJson(join(experimentRoot, 'experiment.json'), { spec, runIds: [runId] });

  const store = await ExperimentStore.open(experimentRoot, experimentId);
  const targetEvents = [];
  const artifactRefs = [];
  let run;
  let released = false;
  const release = async () => {
    released = true;
    return environmentProvider.release(environment);
  };
  try {
    await store.acquireWriter();
    const sink = {
      append: async (targetEvent) => {
        const event = await store.append({ type: targetEvent.type, runId, payload: targetEvent.payload, occurredAt: targetEvent.occurredAt });
        targetEvents.push(`event:${event.eventId}`);
      },
    };
    const runner = await runtime.createRunner(resolved, environment, sink);
    run = new CandidateRun({
      runner,
      policy: { turnTimeoutMs: policy.turnTimeoutMs, maxTargetTurns: policy.maxTargetTurns },
      release,
      persistence: { journal: store, attempt, manifest, artifactRefs },
    });
    const state = await run.start({ id: persistedTaskCase.initialInput.id, text: persistedTaskCase.initialInput.text }, { runId, turnIndex: 0, clientMessageId: `initial-${runId}` });
    if (state !== 'awaiting_controller') throw new Error(`Candidate did not reach controller handoff: ${state}.`);

    const host = new PiAgentHost(new CodexTextCaller());
    const controller = new ControllerAgent({ host, timeoutMs: agentConfig.budget.callTimeoutMs, maxRepairAttempts: agentConfig.budget.maxStructuredRepairAttempts });
    const decision = await controller.decide({
      runId,
      runState: state,
      task: persistedTaskCase,
      current: { summary: input.currentSummary ?? 'The candidate target turn settled in the isolated workspace.', evidenceRefs: targetEvents },
      trajectory: { summary: input.trajectorySummary ?? 'One candidate turn completed in an isolated harness workspace.', evidenceRefs: targetEvents },
      priorDecisions: [],
      budget: { targetTurnsUsed: 1, targetTurnsLimit: policy.maxTargetTurns },
      permissions: { requiresRealUserDecision: false },
    });
    await store.append({ type: 'controller.decision', runId, operationId: 'controller-decision-1', payload: decision.value });
    const followupSubmission = decision.value.type === 'send';
    if (followupSubmission) {
      // ponytail: this first vertical slice permits one controller-selected text follow-up; multi-turn orchestration is not built yet.
      const followupState = await run.submit({ id: `controller-${runId}`, text: decision.value.message }, { runId, turnIndex: 1, clientMessageId: `controller-1-${runId}` });
      if (followupState !== 'awaiting_controller') throw new Error(`Candidate did not settle after the controller follow-up: ${followupState}.`);
    }
    if (input.captureArtifacts) artifactRefs.push(...await input.captureArtifacts({ store, environment, workspaceProvider: environmentProvider, sourceRoot, experimentId, runId }));
    await run.complete();
    const record = run.result().record;
    if (!record) throw new Error('Candidate run did not produce a RunRecord.');

    const comparison = await comparePersistedFacts({
      taskCase: persistedTaskCase,
      runs: [record],
      agent: new ComparisonAgent({ host, timeoutMs: agentConfig.budget.callTimeoutMs, maxRepairAttempts: agentConfig.budget.maxStructuredRepairAttempts }),
    });
    await writeImmutableJson(join(experimentRoot, 'comparison.json'), comparison.result.value);
    const reportPath = join(experimentRoot, 'report.html');
    await writeFile(reportPath, renderComparisonReport(buildComparisonProjection({ taskCase: persistedTaskCase, runs: [record], comparison: comparison.result.value })), 'utf8');
    const result = { taskCase: persistedTaskCase, experimentRoot, reportPath, resolved, record, decision, comparison, followupSubmission, targetEvents };
    if (input.createAcceptance) {
      const acceptance = input.createAcceptance(result);
      if (input.assertAcceptance) input.assertAcceptance(acceptance);
      await writeImmutableJson(join(experimentRoot, 'runs', runId, input.acceptanceFileName ?? 'acceptance.json'), acceptance);
    }
    return result;
  } catch (error) {
    if (run?.states().at(-1) === 'awaiting_controller') await run.cancel();
    throw error;
  } finally {
    if (!released) await release();
    await store.close();
  }
}

function resolvedAgentConfig(config) {
  const configHash = hash(JSON.stringify(config));
  return { ...config, resolvedModel: config.requestedModel, optionsHash: configHash, promptHash: hash('reprise-controller-and-comparison-prompts-v1'), toolPolicyHash: hash('read-only-observation'), contextPolicyHash: hash('real-codex-runner-v1') };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}