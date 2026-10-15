import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ComparisonReportModelSchema } from '../../src/core/schema.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { createHarnessAgents } from '../../src/application/harness-agents.js';
import { startExperiment } from '../../src/application/experiment.js';
import { inspectComparisonRecovery } from '../../src/application/comparison-recovery.js';
import { readCommittedExperimentHistory } from '../../src/application/experiment-history-read.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import type { ArtifactRenderer } from '../../src/infrastructure/artifact-renderer.js';
import type { HarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import { sha256 } from '../../src/core/identity.js';
import { captureHistoricalDelivery } from '../../src/application/historical-delivery.js';
import { input, patientPolicy, VerifiedRuntime } from '../codex-experiment-support.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture',
  baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config: HarnessModelConfig = { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' },
  providerId: 'fixture', modelId: 'fixture', effort: 'low' };
const submission = { boundary: 'Task quality remains unverified.', differences: ['Candidate delivers a focused change.'], status: 'completed', category: 'Delivery', headline: 'The candidate delivered a focused change', path: 'scratch/report.html' };
const original = '<p>The candidate produced a focused change. Task quality remains unverified.</p>';
const revised = '<p>The revised comparison retains the uncertainty about task quality.</p>';
type Step = { name: string; arguments: Record<string, unknown> };

for (const mode of ['published', 'missing-preview', 'stale-preview', 'repreviewed', 'cancelled', 'selected-delivery', 'git-delivery'] as const) {
  test(`default autonomous factory traverses production publication: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'reprise-autonomous-publication-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const base = input(root, new VerifiedRuntime());
    await mkdir(base.sourceRoot);
    await writeFile(join(base.sourceRoot, 'README.md'), '# frozen source\n');
    const abort = new AbortController();
    const steps: Step[] = [
      { name: 'write', arguments: { path: submission.path, content: mode === 'selected-delivery' || mode === 'git-delivery'
        ? `${original}<p>Chosen substitute, not the historical model's original delivery.</p><a href="finals/baseline.txt">Chosen baseline</a>` : original } },
      { name: 'submit_report', arguments: submission },
    ];
    if (mode === 'selected-delivery' || mode === 'git-delivery') steps.unshift({ name: 'read', arguments: { path: 'finals/manifest.json' } });
    if (mode !== 'missing-preview') steps.push({ name: 'preview_report', arguments: {} });
    if (mode === 'stale-preview' || mode === 'repreviewed') {
      steps.push({ name: 'write', arguments: { path: submission.path, content: revised } },
        { name: 'submit_report', arguments: submission });
    }
    if (mode === 'repreviewed') steps.push({ name: 'preview_report', arguments: {} });
    const actualInputs: Context['messages'][] = [];
    const models = { getModel: () => model, streamSimple: (_: unknown, context: Context) => {
      const index = actualInputs.length;
      actualInputs.push(structuredClone(context.messages));
      const previous = steps[index - 1];
      if (previous) {
        const receipt = context.messages.at(-1);
        assert.ok(receipt?.role === 'toolResult', 'The next generation must receive the actual tool result');
        assert.equal(receipt.toolName, previous.name);
        assert.equal(receipt.isError, false);
        if (previous.name === 'read') {
          const body = receipt.content.find(part => part.type === 'text');
          assert.ok(body?.type === 'text');
          assert.match(body.text, mode === 'git-delivery' ? /git_snapshot/ : /user_selected_substitute/);
        }
        if (previous.name === 'submit_report' || previous.name === 'preview_report') {
          const body = receipt.content.find(part => part.type === 'text');
          assert.ok(body?.type === 'text');
          const value = JSON.parse(body.text) as { status: string };
          assert.equal(value.status, previous.name === 'submit_report' ? 'accepted' : 'ok');
        }
      }
      assert.ok(index <= steps.length, 'No unplanned generation or workflow repair');
      const step = steps[index];
      if (step) assert.ok(context.tools?.some(tool => tool.name === step.name));
      if (!step && mode === 'cancelled') abort.abort();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: step ? 'toolUse' : 'stop',
        content: step ? [{ type: 'toolCall', id: `call-${index}`, name: step.name, arguments: step.arguments }]
          : [{ type: 'text', text: 'Finished the requested comparison.' }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: step ? 'toolUse' : 'stop', message });
      return stream;
    } } as unknown as PiModels;
    const agents = createHarnessAgents(config, new PiModelCaller(config, models));
    assert.equal(agents.comparison.workflow, 'autonomous');
    let renders = 0;
    const comparisonPreviewRenderer: ArtifactRenderer = async request => {
      const html = await readFile(join(request.bundleRoot, request.entryRelativePath), 'utf8');
      assert.ok(html.includes(renders++ === 0 ? original : revised));
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      await mkdir(request.outputRoot, { recursive: true });
      const pngPath = join(request.outputRoot, 'preview.png');
      await writeFile(pngPath, png);
      return { ok: true, frames: [{ sampleTimeMs: 0, actualTimeMs: 0, pngPath, byteLength: png.byteLength, contentHash: sha256(png) }],
        diagnostics: [], measured: { loadMs: 1, viewport: request.viewport, origin: 'fixture://preview' } };
    };
    const handle = startExperiment({ ...base, policy: patientPolicy, comparison: agents.comparison,
      comparisonPreviewRenderer, signal: abort.signal, deferComparison: true });
    const candidate = await handle.candidateFinished;
    if (mode === 'selected-delivery') {
      const sourcePath = join(root, 'baseline.txt');
      await writeFile(sourcePath, 'chosen baseline bytes');
      await captureHistoricalDelivery({ dataDir: base.dataDir, taskCase: base.taskCase, now: base.now, selectionBasis: 'Explicit user selection',
        source: { kind: 'user_selected_substitute', sourcePath, logicalPath: 'baseline.txt', expectedHash: sha256('chosen baseline bytes'), userInstruction: 'Use this substitute.' } });
      await rm(sourcePath);
    }
    if (mode === 'git-delivery') {
      const repository = join(root, 'history-repository'); await mkdir(repository);
      await writeFile(join(repository, 'baseline.txt'), 'chosen baseline bytes');
      await writeFile(join(repository, 'asset.html'), '<h1>Repository asset, not the task deliverable</h1>');
      const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args], { windowsHide: true });
      await git('init'); await git('add', '.');
      await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
      const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
      await captureHistoricalDelivery({ dataDir: base.dataDir, taskCase: base.taskCase, now: base.now, selectionBasis: 'Explicit endpoint', source: { kind: 'git_snapshot', repository, commit } });
    }
    await handle.runComparison();
    const result = await handle.result;
    assert.deepEqual(result.record.outcome, candidate.record.outcome);
    assert.equal(actualInputs.length, steps.length + 1, JSON.stringify(result.comparison));
    assert.equal(renders, mode === 'missing-preview' ? 0 : mode === 'repreviewed' ? 2 : 1);
    const published = mode === 'published' || mode === 'repreviewed' || mode === 'selected-delivery' || mode === 'git-delivery';
    assert.equal(result.comparison.result.status, published ? 'completed' : mode === 'cancelled' ? 'cancelled' : 'failed', JSON.stringify(result.comparison));
    const eventsPath = join(result.experimentRoot, 'events.jsonl');
    const before = await readFile(eventsPath);
    const store = await ExperimentStore.open(result.experimentRoot, base.experimentId);
    const events = store.events();
    await store.close();
    const request = events.find(event => event.type === 'comparison.requested');
    assert.ok(request && typeof request.payload === 'object' && request.payload !== null);
    const payload = request.payload as { attemptId: string; autonomousContractVersion: number; reviewInspectionContractVersion?: number };
    assert.equal(payload.autonomousContractVersion, 2);
    assert.equal(payload.reviewInspectionContractVersion, undefined);
    if (mode === 'git-delivery') {
      const media = JSON.parse(await readFile(join(result.experimentRoot, 'comparison-attempts', payload.attemptId, 'facts', 'media.json'), 'utf8')) as { side: string }[];
      assert.equal(media.filter(item => item.side === 'baseline').length, 0, 'Repository HTML assets must not trigger automatic delivery screenshots');
    }
    if (mode === 'selected-delivery') {
      assert.ok(events.some(event => event.type === 'comparison.historical_delivery_prepared'));
      const facts = JSON.parse(await readFile(join(result.experimentRoot, 'comparison-attempts', payload.attemptId, 'facts', 'context.json'), 'utf8')) as { reportFacts: { replay: { conditions: string[] } } };
      assert.ok(facts.reportFacts.replay.conditions.some(condition => /user-selected substitute|用户指定替代基准/.test(condition)));
      const report = await readFile(join(result.experimentRoot, 'report.html'), 'utf8');
      const href = report.match(/href="([^"]*published-finals[^"]*baseline\.txt)"/)?.[1];
      assert.ok(href);
      assert.equal(await readFile(join(result.experimentRoot, ...href.split('/')), 'utf8'), 'chosen baseline bytes');
      const nextPath = join(root, 'next.txt'); await writeFile(nextPath, 'next selection');
      await captureHistoricalDelivery({ dataDir: base.dataDir, taskCase: base.taskCase, now: base.now, selectionBasis: 'Later explicit selection',
        source: { kind: 'captured_file', sourcePath: nextPath, logicalPath: 'next.txt', expectedHash: sha256('next selection') } });
      assert.equal(await readFile(join(result.experimentRoot, ...href.split('/')), 'utf8'), 'chosen baseline bytes');
    }
    assert.equal(events.filter(event => event.type === 'agent.session_started'
      && (event.payload as { role?: string }).role === 'comparison').length, 1);
    const recovery = await inspectComparisonRecovery({ dataDir: base.dataDir, experimentId: base.experimentId, attemptId: payload.attemptId });
    assert.equal(recovery.ready, published, recovery.reason);
    const history = await readCommittedExperimentHistory(result.experimentRoot, base.experimentId);
    assert.equal(history.diagnosticCode, undefined);
    assert.equal(history.incompleteModelInput, false);
    assert.deepEqual(await readFile(eventsPath), before, 'Read-only recovery/history must not rewrite committed evidence');
    const reportPath = join(result.experimentRoot, 'report.html');
    if (published) {
      const html = await readFile(reportPath, 'utf8');
      assert.ok(html.includes(mode === 'repreviewed' ? revised : original));
      assert.match(html, /data-report-format="3"/);
      assert.doesNotMatch(html, /data-agent-zone="details"|data-host-zone="evidence"|data-host-limitation="hostLimitationShareCardPresentation"/);
      const model: unknown = JSON.parse(await readFile(join(result.experimentRoot, 'report-model.json'), 'utf8'));
      assert.ok(Value.Check(ComparisonReportModelSchema, model));
      assert.equal(model.formatVersion, 3);
      assert.equal(model.boundary, submission.boundary);
      assert.deepEqual(model.differences, submission.differences);
      assert.equal(recovery.model?.boundary, submission.boundary);
      assert.deepEqual(recovery.model?.differences, submission.differences);
    }
    else await assert.rejects(readFile(reportPath), { code: 'ENOENT' });
  });
}
