import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessAgents } from '../../src/application/harness-agents.js';
import { startExperiment } from '../../src/application/experiment.js';
import { comparePersistedExperiment } from '../../src/application/experiment-compare-persisted.js';
import { comparisonFailureText } from '../../src/application/comparison-failure-text.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { input, patientPolicy, VerifiedRuntime } from '../codex-experiment-support.js';

test('comparison failure diagnostics traverse nested aggregates without looping or exposing secrets', () => {
  const nested = new AggregateError([new Error('\u001b[31mActual nested failure\u001b[0m token=fixture-secret')], 'Nested group');
  nested.errors.push(nested);
  const outer = new AggregateError([nested, nested, undefined], 'Outer group');
  assert.equal(comparisonFailureText(outer), 'Outer group | Nested group | Actual nested failure token=[REDACTED] | undefined');
});

for (const entry of ['start', 'persisted'] as const) {
  for (const mode of ['provider-and-cleanup', 'cancelled-and-cleanup', 'audit-only', 'cancelled-clean', 'provider-clean'] as const) {
    test(`${entry} persists actual autonomous finalization causes: ${mode}`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'reprise-finalization-'));
      t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      const base = input(root, new VerifiedRuntime());
      await mkdir(base.sourceRoot);
      const cleanup = mode.endsWith('cleanup');
      let closes = 0;
      const agents = createHarnessAgents({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' },
        providerId: 'fixture', modelId: 'fixture', effort: 'low' }, { createSession: () => ({
        append: async () => {
          if (mode.startsWith('cancelled')) throw new DOMException('Pi model request was aborted.', 'AbortError');
          if (mode.startsWith('provider')) throw Object.assign(new Error('Primary upstream failure token=fixture-primary'), { status: 503 });
          return '';
        },
        cancel() {
          closes++;
          if (cleanup) throw new AggregateError([new Error('Actual session close failure password=fixture-close')], 'Close aggregate');
        },
      }) });
      assert.equal(agents.comparison.workflow, 'autonomous');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- The audit fault injector calls this original with the actual Store below.
      const append = ExperimentStore.prototype.append;
      t.mock.method(ExperimentStore.prototype, 'append', async function(this: ExperimentStore, event: Parameters<typeof append>[0]) {
        if ((cleanup || mode === 'audit-only') && event.type === 'comparison.resources_completed') {
          throw new Error('Actual resource audit failure api_key=fixture-audit');
        }
        return append.call(this, event);
      });
      const handle = startExperiment({ ...base, policy: patientPolicy, comparison: agents.comparison,
        deferComparison: entry === 'start', compare: entry === 'start' });
      if (entry === 'start') { await handle.candidateFinished; await handle.runComparison(); }
      const first = await handle.result;
      const result = entry === 'start' ? first : await comparePersistedExperiment({ dataDir: base.dataDir,
        experimentId: base.experimentId, comparison: agents.comparison, agentConfig: base.agentConfig,
        policy: patientPolicy, now: base.now });
      assert.equal(closes, 1);
      assert.equal(result.comparison.result.status, mode === 'cancelled-clean' ? 'cancelled' : 'failed');
      const store = await ExperimentStore.open(result.experimentRoot, base.experimentId);
      t.after(() => store.close());
      const completed = store.events().filter(event => event.type === 'comparison.completed').at(-1);
      assert.ok(completed);
      const artifacts = [await readFile(join(result.experimentRoot, 'comparison.json'), 'utf8'),
        JSON.stringify(completed.payload), await readFile(join(result.experimentRoot, 'comparison-failure.html'), 'utf8')];
      for (const text of artifacts) {
        assert.doesNotMatch(text, /fixture-(?:primary|audit|close)/);
        if (mode.startsWith('provider')) assert.match(text, /Primary upstream failure/);
        if (mode === 'cancelled-and-cleanup') assert.match(text, /Comparison cancelled/);
        if (cleanup || mode === 'audit-only') assert.match(text, /Actual resource audit failure/);
        if (cleanup) assert.match(text, /Actual session close failure/);
        else assert.doesNotMatch(text, /Actual session close failure|Close aggregate/);
        if (mode === 'provider-clean' || mode === 'cancelled-clean') assert.doesNotMatch(text, /finalization failed|resource audit failure/);
      }
    });
  }
}
