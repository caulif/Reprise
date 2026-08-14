import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ComparisonAgentPort } from '../src/agents/comparison-agent.js';
import type { ControllerPort } from '../src/agents/controller-agent.js';
import { recoverCodexExperiment, startCodexExperiment } from '../src/application/experiment.js';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import type { TaskCase } from '../src/core/schema.js';
import type { ResolvedRuntime, RuntimePort, TargetEventSink, TargetRunner } from '../src/core/runtime.js';
import type { HarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { ScriptedRunner } from '../src/infrastructure/scripted-runtime.js';

const git = promisify(execFile);
const now = new Date().toISOString();

async function main(): Promise<void> {
  if (process.env.REPRISE_RUN_CODEX_RECOVERY_SMOKE !== '1') {
    throw new Error('Set REPRISE_RUN_CODEX_RECOVERY_SMOKE=1 to run the real Recovery smoke.');
  }
  const config = modelConfig();
  const root = await mkdtemp(join(tmpdir(), 'reprise-real-recovery-'));
  const sourceRoot = join(root, 'source');
  const dataDir = join(root, 'data');
  // A unique temporary root already scopes this smoke; short IDs keep Windows child-process cwd paths below MAX_PATH.
  const caseId = 'case-smoke';
  const experimentId = 'experiment-smoke';
  const runId = 'run-smoke';
  await setupHistoricalSource(sourceRoot);
  const historicalCommit = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
  await writeFile(join(sourceRoot, 'README.md'), '# completed\n');
  const taskCase = makeTaskCase(caseId, historicalCommit);
  const agents = createHarnessAgents(config);
  const attempt = await recoverCodexExperiment({
    dataDir, caseId, experimentId, runId, sourceRoot, taskCase, recovery: agents.recovery,
    maxToolCalls: agents.config.recoveryBudget.maxToolCalls, now,
  });
  await assertRecovery(attempt, sourceRoot, dataDir, experimentId);
  const baseline = await attempt.accept?.();
  if (!baseline || baseline.match !== 'recovered') throw new Error('Recovery preview was not accepted as a recovered baseline.');
  const candidate = await startCodexExperiment({
    dataDir, caseId, experimentId, runId: `${runId}-scripted-candidate`, sourceRoot, taskCase,
    candidate: { candidateId: 'scripted-candidate', productId: 'codex', requestedModel: 'scripted' },
    policy: { wallClockMs: 30_000, maxTargetTurns: 2, maxModelCalls: 1, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 1 },
    agentConfig: agents.config, runtime: new ScriptedCandidateRuntime(), controller: scriptedController, comparison: scriptedComparison,
    environmentProvider: attempt.provider, preResolvedBaseline: baseline, now,
  }).result;
  if (candidate.record.outcome.termination.kind !== 'completed') throw new Error('Scripted Candidate orchestration did not complete.');
  await access(candidate.reportPath);
  const result = {
    status: 'passed', root, dataDir, experimentRoot: attempt.experimentRoot,
    recovery: { providerId: config.providerId, model: config.modelId, status: attempt.recovery.status, toolCalls: await auditToolCalls(attempt.experimentRoot) },
    candidate: { runtime: 'scripted', status: candidate.record.outcome.termination.kind, reportPath: candidate.reportPath },
    note: 'Only Recovery used the real configured Provider; Candidate and Comparison were scripted to verify orchestration without claiming a real Candidate run.',
  };
  await writeFile(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function modelConfig(): HarnessModelConfig {
  const baseUrl = process.env.REPRISE_RECOVERY_BASE_URL;
  const keyName = process.env.REPRISE_RECOVERY_API_KEY_ENV ?? 'OPENAI_API_KEY';
  if (!baseUrl) throw new Error('Set REPRISE_RECOVERY_BASE_URL to the OpenAI-compatible /v1 endpoint.');
  if (!process.env[keyName]) throw new Error(`Set ${keyName} in this shell; the smoke never reads credentials from disk.`);
  return {
    schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'recovery-smoke' }, providerId: 'recovery-smoke',
    modelId: process.env.REPRISE_RECOVERY_MODEL ?? 'gpt-5.6-luna', effort: 'medium', baseUrl, keyRef: `env:${keyName}`,
  };
}

async function setupHistoricalSource(sourceRoot: string): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, 'README.md'), '# task-start\n');
  await runGit(sourceRoot, ['init']);
  await runGit(sourceRoot, ['config', 'user.email', 'reprise-smoke@example.invalid']);
  await runGit(sourceRoot, ['config', 'user.name', 'Reprise Recovery Smoke']);
  await runGit(sourceRoot, ['add', 'README.md']);
  await runGit(sourceRoot, ['commit', '-m', 'task-start']);
}

function makeTaskCase(caseId: string, historicalCommit: string): TaskCase {
  return {
    schemaVersion: 1, caseId, source: { productId: 'codex', sessionId: 'recovery-smoke' },
    initialInput: { id: 'message-1', role: 'user', text: 'Restore README.md to the task-start state.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Restore README.md to the task-start state.' }], historicalEvents: [],
    baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    taskContext: { historicalCommit, historicalBehavior: { touchedPaths: ['README.md'] } },
    provenance: { packVersion: 'recovery-smoke', importedAt: now, sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64),
  };
}

async function assertRecovery(attempt: Awaited<ReturnType<typeof recoverCodexExperiment>>, sourceRoot: string, dataDir: string, experimentId: string): Promise<void> {
  if (attempt.recovery.status !== 'completed' || attempt.recovery.value.status !== 'recovered' || attempt.baseline.match !== 'recovered') {
    throw new Error(`Real Recovery did not produce a recovered baseline: ${JSON.stringify(attempt.recovery)}.`);
  }
  if (!attempt.providerPreview?.reportText?.trim()) throw new Error('Recovery preview is missing recovery.md.');
  if (!attempt.staging || !/^# task-start\r?\n$/.test(await readFile(join(attempt.staging.root, 'README.md'), 'utf8'))) throw new Error('Recovery staging did not restore README.md.');
  if ((await readFile(join(sourceRoot, 'README.md'), 'utf8')) !== '# completed\n') throw new Error('Recovery modified the source workspace.');
  await access(join(dataDir, 'experiments', experimentId, 'recovery.json'));
  await access(join(dataDir, 'experiments', experimentId, 'artifacts', 'recovery-md'));
}

async function auditToolCalls(experimentRoot: string): Promise<number> {
  const contents = await readFile(join(experimentRoot, 'events.jsonl'), 'utf8');
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type?: unknown })
    .filter((event) => event.type === 'agent.tool_called').length;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await git('git', args, { cwd, windowsHide: true })).stdout.trim();
}

class ScriptedCandidateRuntime implements RuntimePort {
  readonly id = 'scripted-recovery-smoke';
  async inspectAvailable() { return [{ productId: 'codex', executable: 'scripted-recovery-smoke', version: 'fixture' }] as const; }
  async inspectAvailability() { return [{ productId: 'codex', executable: 'scripted-recovery-smoke', observedVersion: 'fixture', status: 'available' as const, observedAt: now }]; }
  async resolve(request: { productId: string; requestedModel: string }): Promise<ResolvedRuntime> { return { productId: request.productId, executable: 'scripted-recovery-smoke', version: 'fixture', requestedModel: request.requestedModel, resolvedModel: request.requestedModel }; }
  async validateCandidate(request: { productId: string; requestedModel: string }): Promise<ResolvedRuntime> { return this.resolve(request); }
  async createRunner(_runtime: ResolvedRuntime, _environment: { environmentId: string; runId: string; root: string }, sink: TargetEventSink): Promise<TargetRunner> {
    await sink.append({ type: 'codex.item_completed', occurredAt: now, payload: { item: { type: 'agentMessage', text: 'Scripted Candidate completed orchestration smoke.' } } });
    return new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [{ turnId: 'scripted-turn', status: 'waiting_input', confidence: 'native', observedAt: now, rawRefs: [] }]);
  }
}

const scriptedController: ControllerPort = { decide: async () => ({ status: 'completed', sessionId: 'scripted-controller', value: { type: 'done', reason: 'satisfied' } }) };
const scriptedComparison: ComparisonAgentPort = { compare: async (_context, tools = []) => {
  const report = tools.find((tool) => tool.name === 'write_comparison_report');
  await report?.execute({ content: '# Comparison\n\nScripted Candidate orchestration completed after the accepted Recovery baseline.' }, new AbortController().signal);
  return { status: 'completed', sessionId: 'scripted-comparison', value: { status: 'completed', reportPath: 'comparison.md', evidenceRefs: [] } };
} };

main().catch((error: unknown) => {
  console.error(`Real Recovery smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
