import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { startExperiment } from '../../src/application/experiment.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

test('application publishes a submitted and previewed draft after an empty final message', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-flow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: ({ tools }) => ({
      append: async ({ signal }) => {
        turns++;
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          const accepted = await submit.execute({
            status: 'completed', category: 'Results', headline: 'The candidate produced a usable result.',
            comparisonHtml: '<p>The candidate produced a usable result from the same starting task.</p>',
          }, signal);
          assert.match(accepted.content, /status=accepted/);
        }
        if (turns === 3) {
          const preview = tools?.find((tool) => tool.name === 'preview_report');
          assert.ok(preview);
          const result = await preview.execute({}, signal);
          assert.equal((JSON.parse(result.content) as { status: string }).status, 'ok');
        }
        return '';
      },
      cancel() {},
    }) }),
    timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(turns, 3);
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /usable result/);
  const events = await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8');
  assert.match(events, /comparison.phase_completed/);
});

test('application refuses to publish an accepted draft without preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-unpreviewed-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: ({ tools }) => ({
      append: async ({ signal }) => {
        turns++;
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          assert.match((await submit.execute({
            status: 'completed', category: 'Results', headline: 'A difference.',
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        return '';
      }, cancel() {},
    }) }), timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'failed');
  if (result.comparison.result.status === 'failed') assert.equal(result.comparison.result.failure.code, 'preview_failed');
  await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});

test('a provider failure after preview does not publish the draft', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-provider-failed-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: ({ tools }) => ({
      append: async ({ signal }) => {
        turns++;
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          assert.match((await submit.execute({
            status: 'completed', category: 'Results', headline: 'A difference.',
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        if (turns === 3) {
          const preview = tools?.find((tool) => tool.name === 'preview_report');
          assert.ok(preview);
          assert.equal((JSON.parse((await preview.execute({}, signal)).content) as { status: string }).status, 'ok');
          throw Object.assign(new Error('Provider unavailable during review'), { status: 503 });
        }
        return '';
      }, cancel() {},
    }) }), timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'failed');
  if (result.comparison.result.status === 'failed') {
    assert.equal(result.comparison.result.failure.code, 'provider_failure');
    assert.equal(result.comparison.result.failure.kind, 'transient_upstream');
  }
  await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});
