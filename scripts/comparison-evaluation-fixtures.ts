import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startExperiment } from '../src/application/experiment.js';
import { sha256 } from '../src/core/identity.js';
import type { RunPolicy } from '../src/core/schema.js';
import type { ComparisonEvaluationCase } from '../src/core/comparison-evaluation-schema.js';
import type { ProductRuntime, ResolvedRuntime, TargetEventSink } from '../src/core/runtime.js';
import { ScriptedRunner } from '../src/infrastructure/scripted-runtime.js';
import { publishFrozenCase } from '../src/products/shared/freeze.js';
import type { ControllerPort } from '../src/agents/controller-agent.js';
import { comparisonEvaluationTask } from './comparison-evaluation-task.js';
import { captureComparisonEvaluationInputs } from './comparison-evaluation-inputs.js';

export const EVALUATION_POLICY: RunPolicy = { wallClockMs: 60_000, maxTargetTurns: 2, maxModelCalls: 2,
  turnTimeoutMs: 30_000, maxConsecutiveNoProgress: 1 };
const FIXTURE_TIME = '2026-10-04T00:00:00.000Z';

class FrozenFixtureRuntime implements ProductRuntime {
  readonly id = 'comparison-evaluation-fixture';
  constructor(readonly item: ComparisonEvaluationCase) {}
  async inspectAvailable() { return [{ productId: 'codex', executable: this.id, version: 'synthetic-v1' }]; }
  async inspectAvailability() { return [{ productId: 'codex', executable: this.id, status: 'available' as const, observedAt: FIXTURE_TIME }]; }
  async resolve(request: { productId: string; requestedModel: string }): Promise<ResolvedRuntime> {
    return { ...request, executable: this.id, version: 'synthetic-v1', resolvedModel: request.requestedModel };
  }
  async validateCandidate(request: { productId: string; requestedModel: string }) { return this.resolve(request); }
  async listCatalog() { return [{ value: this.item.candidate.model, displayName: this.item.candidate.model }]; }
  recoveryCapabilities() { return { sessionHistory: 'available' as const, localArtifacts: true,
    workspaceHistory: false, externalSideEffects: 'unobserved' as const }; }
  async createRunner(runtime: ResolvedRuntime, environment: { root: string }, sink: TargetEventSink) {
    if (this.item.candidate.content !== undefined) await writeFile(join(environment.root, this.item.candidate.file), this.item.candidate.content);
    await sink.append({ type: 'runtime.session_started', occurredAt: FIXTURE_TIME,
      payload: { sessionId: 'fixture-session', productId: 'codex' } });
    await sink.append({ type: 'runtime.tool_finished', occurredAt: FIXTURE_TIME,
      payload: { item: { type: 'commandExecution', command: 'synthetic frozen observation (not a live check)',
        aggregated_output: this.item.candidate.process.join('\n') } } });
    await sink.append({ type: 'runtime.visible_output', occurredAt: FIXTURE_TIME,
      payload: { item: { type: 'agentMessage', text: this.item.candidate.finalMessage } } });
    return new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fixture-turn' }], [{
      turnId: 'fixture-turn', status: 'waiting_input', confidence: 'native', observedAt: FIXTURE_TIME, rawRefs: [],
    }], undefined, { sessionId: 'fixture-session', workspaceRoot: environment.root, productId: runtime.productId,
      requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel });
  }
}

const fixtureController: ControllerPort = {
  decide: async context => ({ status: 'completed', sessionId: 'offline-fixture-controller', value:
    context.phase === 'opening' || context.runState === 'created'
      ? { type: 'send', message: context.task.initialInput.text, intent: 'continue' }
      : { type: 'done', reason: 'satisfied' } }),
};

/** Materializes frozen synthetic inputs; never calls a model or external Runtime. */
export async function prepareComparisonEvaluationFixture(root: string, item: ComparisonEvaluationCase) {
  const dataDir = join(root, 'data');
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, 'README.md'), 'Synthetic Comparison evaluation. No candidate model was executed.\n');
  const caseId = `case-${item.id}`;
  const sourceHash = sha256(JSON.stringify(item));
  const task = comparisonEvaluationTask(item);
  const baselineFiles = item.baseline.content === undefined ? [] : [{
    relativePath: 'baseline-artifacts/manifest.json', content: JSON.stringify({ schemaVersion: 1,
      sourceHash, extractorVersion: 'comparison-evaluation-v1', artifacts: [{ artifactId: 'fixture-final',
        logicalPath: item.baseline.file, bundleId: 'fixture-bundle',
        contentHash: sha256(item.baseline.content), byteLength: Buffer.byteLength(item.baseline.content),
        origin: 'reconstructed_from_history', sourceRefs: ['message:historical-artifact'], finality: 'final' }], issues: [] }),
  }, { relativePath: `baseline-artifacts/files/fixture-bundle/${item.baseline.file}`, content: item.baseline.content }];
  await publishFrozenCase({ taskCase: task, casesRoot: join(dataDir, 'cases'), files: baselineFiles });
  const result = await startExperiment({ dataDir, caseId, experimentId: `eval-${item.id}`, runId: 'fixture-run',
    sourceRoot, taskCase: task, candidate: { candidateId: 'fixture-candidate', productId: 'codex', requestedModel: item.candidate.model },
    policy: EVALUATION_POLICY, agentConfig: { providerId: 'offline-fixture', requestedModel: 'offline-fixture',
      budget: { callTimeoutMs: 30_000, maxStructuredRepairAttempts: 0 } },
    runtime: new FrozenFixtureRuntime(item), controller: fixtureController,
    comparison: { compare: async () => { throw new Error('Offline fixture preparation must not invoke Comparison.'); }, cancel: async () => {} },
    compare: false, now: FIXTURE_TIME,
  }).result;
  if (result.comparison.result.status !== 'skipped' || result.record.outcome.termination.kind !== 'completed') throw new Error(`Offline fixture preparation failed: ${JSON.stringify(result.record.outcome)}.`);
  const inputIdentityHash = await captureComparisonEvaluationInputs(root, item);
  return { dataDir, experimentId: `eval-${item.id}`, runId: 'fixture-run', inputIdentityHash };
}
