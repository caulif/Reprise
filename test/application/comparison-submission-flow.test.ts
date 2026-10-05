import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { startExperiment } from '../../src/application/experiment.js';
import { AgentHost, type ProviderAdapter } from '../../src/infrastructure/agent/host.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { sha256 } from '../../src/core/identity.js';

function fixtureContext(input: Parameters<ProviderAdapter['createSession']>[0], recordActual = true) {
  const messages: unknown[] = [];
  let toolSequence = 0;
  const tools = input.tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    const toolCallId = `fixture-${++toolSequence}`;
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: tool.name, arguments: structuredClone(params) }] });
    const result = await tool.execute(params, signal);
    messages.push({ role: 'toolResult', toolCallId, toolName: tool.name,
      content: structuredClone(result.contentBlocks ?? [{ type: 'text', text: result.content }]) });
    return result;
  } }));
  return { tools, request: async (content: string) => {
    messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
    const context = { systemPrompt: input.systemPrompt, messages: structuredClone(messages),
      tools: input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) };
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(JSON.stringify(context)),
      messageCount: messages.length, images: [], ...(recordActual ? { generationContext: context } : {}) });
  } };
}

for (const repairable of [true, false]) test(`review revision ${repairable ? 'is previewed by a continuation' : 'cannot extend review indefinitely'}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-review-revision-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({ host: new AgentHost({ createSession: (sessionInput) => {
    const { tools, request } = fixtureContext(sessionInput);
    return {
    append: async ({ content, signal }) => {
      turns++;
      await request(content);
      const submit = tools.find((tool) => tool.name === 'submit_comparison_draft')!;
      const preview = tools.find((tool) => tool.name === 'preview_report')!;
      const draft = (headline: string) => ({ status: 'completed', decisionShape: 'single_difference', category: 'Results', headline, comparisonHtml: `<p>${headline}</p>` });
      if (turns === 2) await submit.execute(draft('Draft A'), signal);
      if (turns === 4) {
        assert.equal((JSON.parse((await preview.execute({}, signal)).content) as { status: string }).status, 'ok');
        const revised = await submit.execute(draft('Draft B'), signal);
        assert.match(revised.content, /currentPhase=review/);
        assert.doesNotMatch(revised.content, /currentPhase=compose/);
      }
      if (turns > 4) {
        assert.match(content, /Continue the current review turn/);
        if (repairable && turns === 5) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
          await preview.execute({}, signal);
        }
        else if (!repairable) await submit.execute(draft(`Draft ${turns}`), signal);
      }
      return '';
    }, cancel() {},
    };
  } }), timeoutMs: 0, maxRepairAttempts: 0 });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(turns, 6);
  assert.equal(result.comparison.result.status, repairable ? 'completed' : 'failed');
  if (repairable) assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Draft B/);
  else await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});

for (const recordActual of [true, false]) test(`application ${recordActual ? 'publishes' : 'rejects legacy projection of'} a submitted and previewed draft after an empty final message`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-flow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: (sessionInput) => {
      const { tools, request } = fixtureContext(sessionInput, recordActual);
      return {
      append: async ({ content, signal }) => {
        turns++;
        await request(content);
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          const accepted = await submit.execute({
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'The candidate produced a usable result.',
            comparisonHtml: '<p>The candidate produced a usable result from the same starting task.</p>',
          }, signal);
          assert.match(accepted.content, /status=accepted/);
        }
        if (turns === 4) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
          const preview = tools?.find((tool) => tool.name === 'preview_report');
          assert.ok(preview);
          const result = await preview.execute({}, signal);
          assert.equal((JSON.parse(result.content) as { status: string }).status, 'ok');
        }
        return '';
      },
      cancel() {},
      };
    } }),
    timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  if (!recordActual) {
    assert.equal(result.comparison.result.status, 'failed');
    const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft'));
    assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report'));
    const requests = events.filter(event => event.type === 'agent.model_request');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(event => !('generationInput' in event.payload)), 'digest-only requests cannot certify delivered inspection');
    await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
    return;
  }
  assert.equal(turns, 5);
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  assert.deepEqual(result.facts.comparisonActivity, { modelRequests: 5, toolCalls: 3, compactions: 0 });
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
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'A difference.',
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        if (turns === 4) await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
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
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'A difference.',
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        if (turns === 4) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
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
