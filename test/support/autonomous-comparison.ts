import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { createHarnessAgents } from '../../src/application/harness-agents.js';
import { startExperiment } from '../../src/application/experiment.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import type { ArtifactRenderer } from '../../src/infrastructure/artifact-renderer.js';
import type { HarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import type { AgentBudget } from '../../src/core/schema.js';
import { sha256 } from '../../src/core/identity.js';
import { parseCommittedEventLog } from '../../src/infrastructure/agent/model-input.js';
import { input, patientPolicy, VerifiedRuntime } from '../codex-experiment-support.js';

export const comparisonFixtureModel: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
  reasoning: false, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const config: HarnessModelConfig = { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' },
  providerId: 'fixture', modelId: 'fixture', effort: 'low' };
export type ComparisonStep = { name: string; arguments: Record<string, unknown>; error?: boolean };
export const comparisonSubmission = { status: 'completed', category: 'Delivery', headline: 'Quality remains unverified', path: 'scratch/report.html' };
export const comparisonFragment = '<p>Neither final output is confirmed usable. Final quality could reverse the choice.</p>';
export function publicationSteps(fragment = comparisonFragment): ComparisonStep[] {
  return [{ name: 'write', arguments: { path: comparisonSubmission.path, content: fragment } },
    { name: 'submit_report', arguments: comparisonSubmission }, { name: 'preview_report', arguments: {} }];
}

export function scriptedComparison(steps: readonly ComparisonStep[], options: {
  onGeneration?: (context: Context, index: number) => void;
  budget?: AgentBudget;
} = {}) {
  const contexts: Context[] = [];
  let stepIndex = 0;
  const models = { getModel: () => comparisonFixtureModel, streamSimple: (_: unknown, context: Context) => {
    const index = stepIndex;
    contexts.push({ ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
      messages: structuredClone(context.messages), ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}) });
    assert.ok(index <= steps.length, 'No unplanned generation or hidden repair');
    const previous = steps[index - 1];
    if (previous) {
      const receipt = context.messages.at(-1);
      assert.ok(receipt?.role === 'toolResult', 'A subsequent real generation must receive the actual tool result');
      assert.equal(receipt.toolName, previous.name);
      assert.equal(receipt.isError, previous.error ?? false);
    }
    options.onGeneration?.(context, index);
    stepIndex++;
    const step = steps[index];
    if (step) assert.ok(context.tools?.some(tool => tool.name === step.name), `Tool is advertised: ${step.name}`);
    const message: AssistantMessage = { role: 'assistant', api: comparisonFixtureModel.api,
      provider: comparisonFixtureModel.provider, model: comparisonFixtureModel.id, timestamp: Date.now(),
      stopReason: step ? 'toolUse' : 'stop',
      content: step ? [{ type: 'toolCall', id: `call-${index}`, name: step.name, arguments: step.arguments }]
        : [{ type: 'text', text: '' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: step ? 'toolUse' : 'stop', message });
    return stream;
  } } as unknown as PiModels;
  const agents = createHarnessAgents(config, new PiModelCaller(config, models), options.budget ? { budget: options.budget } : {});
  assert.equal(agents.comparison.workflow, 'autonomous');
  return { agents, contexts };
}

export const comparisonFixtureRenderer: ArtifactRenderer = async request => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await mkdir(request.outputRoot, { recursive: true });
  const pngPath = join(request.outputRoot, 'preview.png');
  await writeFile(pngPath, png);
  return { ok: true, frames: [{ sampleTimeMs: 0, actualTimeMs: 0, pngPath, byteLength: png.byteLength, contentHash: sha256(png) }],
    diagnostics: [], measured: { loadMs: 1, viewport: request.viewport, origin: 'fixture://preview' } };
};

export async function runAutonomousPublication(t: { after(fn: () => Promise<void>): void }, options: {
  steps?: readonly ComparisonStep[];
  onGeneration?: (context: Context, index: number) => void;
  render?: ArtifactRenderer;
  signal?: AbortSignal;
  budget?: AgentBudget;
  allowImages?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-autonomous-migration-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  if (options.allowImages) base.taskCase.privacy = { ...base.taskCase.privacy, allowBinary: true };
  await mkdir(base.sourceRoot);
  await writeFile(join(base.sourceRoot, 'README.md'), '# frozen source\n');
  const scripted = scriptedComparison(options.steps ?? publicationSteps(), options);
  let renders = 0;
  const result = await startExperiment({ ...base, policy: patientPolicy, comparison: scripted.agents.comparison,
    agentConfig: scripted.agents.config,
    ...(options.signal ? { signal: options.signal } : {}),
    comparisonPreviewRenderer: request => { renders++; return (options.render ?? comparisonFixtureRenderer)(request); },
  }).result;
  const { events, diagnostic } = parseCommittedEventLog(await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8'));
  assert.equal(diagnostic, undefined);
  const requested = events.find(event => event.type === 'comparison.requested');
  assert.ok(requested && typeof requested.payload === 'object' && requested.payload !== null && 'attemptId' in requested.payload);
  const objectEvents = events.map(event => {
    assert.ok(typeof event.payload === 'object' && event.payload !== null);
    return { ...event, payload: event.payload as Record<string, unknown> };
  });
  return { root, base, result, events: objectEvents, renders, contexts: scripted.contexts,
    attemptRoot: join(result.experimentRoot, 'comparison-attempts', String(requested.payload.attemptId)) };
}
