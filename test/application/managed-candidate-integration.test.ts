import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperimentWorkflow } from '../../src/application/experiment-workflow.js';
import { readCommittedRunEvents } from '../../src/application/experiment-run-history.js';
import type { HarnessAgents } from '../../src/application/harness-agents.js';
import type { ResolvedRuntime, TargetEventSink, TargetRunner } from '../../src/core/runtime.js';
import type { CandidateLaunchContext } from '../../src/core/schema.js';
import { record } from '../../src/core/json.js';
import { ScriptedRunner } from '../../src/infrastructure/scripted-runtime.js';
import { codexProductPack } from '../../src/products/packs/codex/pack.js';
import { input, now, VerifiedRuntime } from '../codex-experiment-support.js';

const sessionId = 'managed-first-turn-failure';

class FailingPersistentRuntime extends VerifiedRuntime {
  runner: ScriptedRunner | undefined;
  constructor(readonly nativeRoot: string) { super(); }

  override async createRunner(
    _runtime: ResolvedRuntime,
    environment: { environmentId: string; runId: string; root: string },
    sink: TargetEventSink,
    _launch: CandidateLaunchContext,
  ): Promise<TargetRunner> {
    this.created += 1;
    const nativeRoot = this.nativeRoot;
    const sourcePath = join(nativeRoot, `${sessionId}.jsonl`);
    const runner = new class extends ScriptedRunner {
      historySource() { return { root: nativeRoot, sourcePath }; }

      override async start(...args: Parameters<ScriptedRunner['start']>) {
        await mkdir(nativeRoot, { recursive: true });
        await writeFile(sourcePath, [
          { type: 'session_meta', timestamp: now, payload: { id: sessionId, cwd: environment.root } },
          { type: 'event_msg', timestamp: now, payload: { type: 'user_message', message: args[0].text } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        return super.start(...args);
      }

      override async close() {
        await super.close();
        await appendFile(sourcePath, JSON.stringify({ type: 'event_msg', timestamp: now, payload: { type: 'agent_message', message: 'Final native transcript flushed during close.' } }) + '\n');
      }
    }(
      [{ delivery: 'accepted', evidence: 'native_admission' }],
      [new Error('Fixture first turn failed after native session admission.')],
      undefined,
      { sessionId, workspaceRoot: environment.root, productId: 'codex', sink },
    );
    this.runner = runner;
    return runner;
  }
}

test('workflow binds a newly created native session before first-turn failure and archives flushed history for restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-managed-candidate-integration-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const nativeRoot = join(root, 'native');
  const runtime = new FailingPersistentRuntime(nativeRoot);
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), 'Offline fixture input.\n');
  const workflow = createExperimentWorkflow({
    dataDir: base.dataDir, runtime, pack: { ...codexProductPack, runtime }, now: () => now,
    defaults: { policy: { ...base.policy, wallClockMs: 60_000 } },
    agents: async () => ({
      controller: base.controller, comparison: base.comparison, recovery: {},
      config: { ...base.agentConfig, recoveryBudget: base.agentConfig.budget },
    }) as unknown as HarnessAgents,
  });
  const handle = await workflow.start({
    taskCase: base.taskCase, candidate: base.candidate, sourceRoot: base.sourceRoot,
    experimentId: base.experimentId, runId: base.runId, onEvent: () => {},
  });
  const result = await handle.result;
  assert.equal(runtime.created, 1);
  assert.equal(runtime.runner?.started.length, 1);
  assert.equal(runtime.runner?.sent.length, 0);
  assert.equal(runtime.runner?.closed, true);
  assert.equal(result.record.outcome.termination.kind, 'failed');
  const events = (await readCommittedRunEvents(result.experimentRoot)).events.filter(event => event.runId === base.runId);
  const bound = events.findIndex(event => event.type === 'candidate.history_bound');
  const archived = events.findIndex(event => event.type === 'candidate.history_archived');
  const started = events.findIndex(event => event.type === 'runtime.session_started');
  assert.ok(started >= 0 && bound > started && archived > bound);
  assert.equal(record(events[bound]?.payload).sessionId, sessionId);
  assert.equal(record(events[archived]?.payload).status, 'archived');
  await rm(nativeRoot, { recursive: true });
  const restarted = createExperimentWorkflow({
    dataDir: base.dataDir, pack: codexProductPack, now: () => now,
    agents: async () => { throw new Error('Browsing must not initialize models or agents.'); },
  });
  const page = await restarted.discoverSource('codex', { root: nativeRoot });
  assert.equal(page.items.length, 1);
  const summary = page.items[0]!;
  assert.equal(summary.sessionId, sessionId);
  assert.equal(summary.projectKey, 'reprise-managed:codex');
  assert.equal(summary.managed?.status, 'archived');
  assert.equal(summary.managed?.experimentId, base.experimentId);
  assert.equal(summary.managed?.runId, base.runId);
  assert.equal(page.projects?.find(project => project.key === summary.projectKey)?.label, 'Reprise');
  const inspection = await restarted.inspectSource(summary);
  assert.equal(inspection.transcript[0]?.text, base.taskCase.initialInput.text);
  assert.equal(inspection.transcript.at(-1)?.text, 'Final native transcript flushed during close.');
  assert.match(await readFile(summary.sourcePath, 'utf8'), /Final native transcript flushed during close/);
  assert.equal(runtime.created, 1);
});
