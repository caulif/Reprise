import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComparisonAgentPort } from '../src/agents/comparison-agent.js';
import type { ControllerPort } from '../src/agents/controller-agent.js';
import { preflightCodexExperiment, startCodexExperiment } from '../src/application/codex-experiment.js';
import { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';
import type { ResolvedRuntime, RuntimePort, TargetEventSink, TargetRunner } from '../src/core/runtime.js';
import type { TaskCase } from '../src/core/schema.js';
import { ScriptedRunner } from './support/scripted-runtime.js';

const now = '2026-08-11T12:00:00.000Z';
class VerifiedRuntime implements RuntimePort { readonly id = 'verified-test'; created = 0; async inspectAvailable() { return [{ productId: 'codex', executable: 'verified-test', version: 'fixture' }] as const; } async resolve(request: { productId: string; requestedModel: string }): Promise<ResolvedRuntime> { return { productId: request.productId, executable: 'verified-test', version: 'fixture', requestedModel: request.requestedModel, resolvedModel: request.requestedModel }; } async validateCandidate(request: { productId: string; requestedModel: string }) { return this.resolve(request); } async createRunner(_runtime: ResolvedRuntime, _environment: { environmentId: string; runId: string; root: string }, sink: TargetEventSink): Promise<TargetRunner> { this.created += 1; await sink.append({ type: 'codex.item_completed', occurredAt: now, payload: { item: { type: 'commandExecution', command: 'npm test' } } }); await sink.append({ type: 'codex.item_completed', occurredAt: now, payload: { item: { type: 'agentMessage', text: 'Focused change completed.' } } }); return new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [{ turnId: 'turn-1', status: 'waiting_input', confidence: 'native', observedAt: now, rawRefs: [] }]); } }
const controller: ControllerPort = { decide: async () => ({ status: 'completed', sessionId: 'controller-1', value: { type: 'done', reason: 'satisfied' } }) };
const comparison: ComparisonAgentPort = { compare: async (_context, tools = []) => { const writer = tools.find((tool) => tool.name === 'write_comparison_report'); await writer?.execute({ content: '# Comparison\n\nEvidence-based narrative.' }, new AbortController().signal); return { status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'comparison.md', evidenceRefs: [] } }; } };
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-experiment-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: 'Make the focused change.' }, transcript: [{ id: 'message-1', role: 'user', text: 'Make the focused change.' }], historicalEvents: [], baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, taskContext: { historicalBehavior: { commands: ['npm test'], touchedPaths: ['src/example.ts'] } }, provenance: { packVersion: 'test', importedAt: now, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function input(root: string, runtime: VerifiedRuntime) { const dataDir = join(root, 'data'); return { dataDir, caseId: 'case-experiment-1', experimentId: 'experiment-1', runId: 'run-1', sourceRoot: join(root, 'source'), taskCase: taskCase(), candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'test-model' }, policy: { wallClockMs: 1_000, maxTargetTurns: 2, maxModelCalls: 2, turnTimeoutMs: 1_000, maxConsecutiveNoProgress: 1 }, agentConfig: { providerId: 'test', requestedModel: 'test-model', budget: { callTimeoutMs: 1_000, maxStructuredRepairAttempts: 0 } }, runtime, controller, comparison, now }; }

test('preflight is read-only and successful comparison writes a persisted narrative plus Host evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-codex-experiment-')); t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source')); await writeFile(join(root, 'source', 'README.md'), '# source\n');
  const runtime = new VerifiedRuntime(); const experiment = input(root, runtime);
  const preflight = await preflightCodexExperiment(experiment); assert.equal(preflight.sourceBaseline, 'available'); assert.equal(runtime.created, 0);
  const result = await startCodexExperiment({ ...experiment, experimentId: 'experiment-2', runId: 'run-2' }).result;
  assert.equal(runtime.created, 1);
  assert.match(await readFile(join(result.experimentRoot, 'comparison.md'), 'utf8'), /Evidence-based narrative/);
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /href="comparison\.md"/);
  assert.match(report, /this report is not a ranking/i);
  assert.match(report, /Evidence-based narrative/);
  assert.match(report, /Wall-clock: \d+ ms/);
  assert.match(report, /host-trace\.json/);
  assert.doesNotMatch(report, /unknown/);
  assert.ok(result.record.artifactRefs.some((ref) => ref.artifactId === 'candidate-workspace-scope.json'));
  assert.ok(result.record.artifactRefs.some((ref) => ref.artifactId === 'host-trace.json'));
  const persistedExperiment = JSON.parse(await readFile(join(result.experimentRoot, 'experiment.json'), 'utf8'));
  assert.equal(persistedExperiment.spec.controller.requestedModel, 'test-model');
  assert.equal(persistedExperiment.spec.comparison.requestedModel, 'test-model');
  const manifest = JSON.parse(await readFile(join(result.experimentRoot, 'runs', 'run-2', 'manifest.json'), 'utf8'));
  assert.equal(manifest.controller.requestedModel, 'test-model');
  assert.equal(manifest.comparison.requestedModel, 'test-model');
  const store = await ExperimentStore.open(result.experimentRoot, 'experiment-2'); try { assert.match(JSON.stringify(store.replay('run-2').finishedPayload), /"state":"finished"/); } finally { await store.close(); }
});

test('a completed comparison without comparison.md is recorded as an Agent failure, not a fallback narrative', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-codex-experiment-')); t.after(async () => rm(root, { recursive: true, force: true })); await mkdir(join(root, 'source'));
  const runtime = new VerifiedRuntime();
  const silent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'comparison.md', evidenceRefs: [] } }) };
  const result = await startCodexExperiment({ ...input(root, runtime), comparison: silent }).result;
  assert.equal(result.comparison.result.status, 'failed');
  assert.match(await readFile(result.reportPath, 'utf8'), /No validated comparison narrative/);
});
