import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { createHarnessAgents } from '../../src/application/harness-agents.js';
import { harnessConfigurationScope } from '../../src/application/harness-configuration.js';
import { PiModelCaller, HarnessProbeAuditError, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { EffectiveHarnessConfigurationSchema, HarnessConfigurationBoundSchema, HarnessProbeRequestedSchema, type RunAttempt, type RunManifest, type HarnessConfigurationReference } from '../../src/core/schema.js';
import { DEFAULT_RUN_POLICY } from '../../src/application/default-run-policy.js';
import { canonicalJson } from '../../src/core/task-case-identity.js';
import { sha256 } from '../../src/core/identity.js';
import { createHarnessWorkflow } from '../../src/application/experiment-workflow.js';
import { saveHarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import { createProductLookup } from '../../src/products/index.js';
import { codexProductPack } from '../../src/products/packs/codex/pack.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { startExperiment } from '../../src/application/experiment.js';
import { readLocalHistory } from '../../src/application/experiment-history-list.js';
import { readRunComparison } from '../../src/application/comparison-report-ownership.js';
import { renderHistoryDetail } from '../../src/tui/pages/history.js';
import { createTheme } from '../../src/tui/theme.js';

const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'fixture-provider' },
  providerId: 'fixture-provider', modelId: 'fixture-model', effort: 'high' as const,
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-private-credential', reasoning: true };

function fixtureCaller(complete: NonNullable<Partial<PiModels>['completeSimple']> = async () => ({
  stopReason: 'stop', content: [{ type: 'text', text: 'OK' }],
}) as never): PiModelCaller {
  const model = { id: config.modelId, name: 'fixture', provider: config.providerId, api: 'openai-completions',
    baseUrl: config.baseUrl, input: ['text'], reasoning: true, contextWindow: 256_000, maxTokens: 16_384,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, chatTemplateArgs: { secret: 'fixture-private-parameter' } } };
  const models = { getProviders: () => [], getModels: () => [model], getModel: () => model,
    getAuth: async () => ({ auth: { apiKey: config.apiKey } }), completeSimple: complete,
    streamSimple: () => { throw new Error('not a session fixture'); } } as unknown as PiModels;
  return new PiModelCaller(config, models);
}

async function fixtureStore(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-effective-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment-config');
  await store.acquireWriter();
  t.after(() => store.close());
  await store.commitAttempt({ schemaVersion: 1, experimentId: 'experiment-config', runId: 'run-config', caseId: 'case-config',
    candidate: { candidateId: 'candidate-config', productId: 'codex', requestedModel: 'target-model' }, policy: DEFAULT_RUN_POLICY,
    createdAt: '2026-10-15T00:00:00.000Z' });
  return { root, store, owner: { experimentId: 'experiment-config', runId: 'run-config', operation: 'run' as const } };
}

function fixtureManifest(f: Awaited<ReturnType<typeof fixtureStore>>, reference: HarnessConfigurationReference): RunManifest {
  const role = { providerId: config.providerId, requestedModel: config.modelId, budget: { callTimeoutMs: 5000, maxStructuredRepairAttempts: 1 } };
  return { schemaVersion: 1, attempt: f.store.events()[0]!.payload as RunAttempt,
    resolvedModel: { requested: 'target-model', resolved: 'target-model' }, runtime: { productId: 'codex', executable: 'fixture' },
    environment: { environmentId: 'env-config', workspacePath: join(f.root, 'workspace') },
    controller: { ...role, effectiveReference: reference }, comparison: role, startedAt: '2026-10-15T00:00:00.000Z' };
}

test('effective configuration records enforced budgets and only allowlisted non-secret model fields', () => {
  const budget = { callTimeoutMs: 5000, maxStructuredRepairAttempts: 2, maxCalls: 2,
    comparisonResources: { maxElapsedMs: 20, investigationMs: 9, maxToolCalls: 4 } };
  const recoveryBudget = { callTimeoutMs: 7000, maxStructuredRepairAttempts: 0 };
  const agents = createHarnessAgents(config, fixtureCaller(), { budget, recoveryBudget });
  const effective = agents.config.effective!;
  assert.ok(Value.Check(EffectiveHarnessConfigurationSchema, effective));
  assert.deepEqual(effective.controller.singleCall, { kind: 'unlimited' });
  assert.equal(agents.controller.timeoutMs, 0);
  assert.equal(effective.controller.decisionLimit, 2);
  assert.equal(effective.controller.decisionLimitScope, 'candidate-controller-loop');
  assert.equal(agents.comparison.timeoutMs, 5000);
  assert.equal(agents.recovery.timeoutMs, 7000);
  assert.deepEqual(effective.recovery.operationTotal, { kind: 'finite', milliseconds: 7000 });
  assert.deepEqual(effective.comparison.operationTotal, { kind: 'finite', milliseconds: 20 });
  assert.deepEqual(effective.comparison.configuredCallCap, { kind: 'finite', milliseconds: 5000 });
  assert.equal(effective.comparison.requestDeadlineRule, 'min-remaining-operation-and-configured-call-cap');
  assert.equal(effective.comparison.requestedResources.investigationMs, 9);
  assert.equal(effective.comparison.enforcedResources.investigationMs, undefined);
  assert.equal(effective.comparison.enforcedResources.maxToolCalls, 4);
  assert.equal(effective.model.effort, 'high');
  assert.equal(effective.model.compat.supportsDeveloperRole, false);
  assert.deepEqual(effective.model.unrecordedCompat, ['chatTemplateArgs']);
  assert.match(effective.model.sdkVersion, /^\d+\./);
  assert.doesNotMatch(JSON.stringify(effective), /fixture-private|apiKey|keyRef|https:\/\/fixture/);
  budget.comparisonResources.maxElapsedMs = 1;
  recoveryBudget.callTimeoutMs = 1;
  assert.equal(agents.config.budget.comparisonResources?.maxElapsedMs, 20);
  assert.equal(effective.recovery.singleCall.kind === 'finite' && effective.recovery.singleCall.milliseconds, 7000);
  assert.equal(Object.isFrozen(effective.comparison.requestedResources), true);
});

test('empty Comparison overrides retain the default total deadline', () => {
  const agents = createHarnessAgents(config, fixtureCaller(), { budget: {
    callTimeoutMs: 86_400_000, maxStructuredRepairAttempts: 1, comparisonResources: {},
  } });
  assert.deepEqual(agents.config.effective!.comparison.operationTotal, { kind: 'finite', milliseconds: 86_400_000 });
});

test('factory snapshot pins private config and resolved model despite source object and registry mutation', async () => {
  const mutableConfig = { ...config, effort: 'high' as 'high' | 'low', compat: { supportsDeveloperRole: false } };
  const model = { id: config.modelId, name: 'fixture', provider: config.providerId, api: 'openai-completions',
    baseUrl: config.baseUrl, input: ['text'], reasoning: true, contextWindow: 256_000, maxTokens: 16_384,
    compat: { supportsDeveloperRole: false } };
  let currentModel = model;
  let requests = 0;
  const models = { getProviders: () => [], getModels: () => [currentModel], getModel: () => currentModel,
    getAuth: async () => ({ auth: { apiKey: config.apiKey } }),
    completeSimple: async (actual: typeof model, _context: unknown, options: { reasoning?: string }) => {
      requests++;
      assert.equal(actual.contextWindow, 256_000);
      assert.equal(actual.compat.supportsDeveloperRole, false);
      assert.deepEqual(actual.input, ['text']);
      assert.equal(options.reasoning, 'high');
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    }, streamSimple: () => { throw new Error('not a session fixture'); } } as unknown as PiModels;
  const caller = new PiModelCaller(mutableConfig, models);
  const agents = createHarnessAgents(mutableConfig, caller);
  const recorded = canonicalJson(agents.config.effective);
  mutableConfig.effort = 'low';
  mutableConfig.compat.supportsDeveloperRole = true;
  model.contextWindow = 1;
  model.compat.supportsDeveloperRole = true;
  model.input.push('image');
  currentModel = { ...model, contextWindow: 2 };
  await caller.validate();
  assert.equal(requests, 1);
  assert.equal(canonicalJson(agents.config.effective), recorded);
  assert.equal(canonicalJson(caller.effectiveModelConfiguration), canonicalJson(agents.config.effective!.model));
  assert.notEqual(new PiModelCaller(mutableConfig, models).executionFingerprint, caller.executionFingerprint);
});

test('persistence schema rejects nested credentials and unknown options instead of silently retaining them', async t => {
  const f = await fixtureStore(t);
  const effective = createHarnessAgents(config, fixtureCaller()).config.effective!;
  const paths = ['model', 'model.compat', 'model.compatScalarOptions', 'controller', 'controller.singleCall',
    'recovery', 'comparison', 'comparison.requestedResources', 'comparison.enforcedResources', 'probe'];
  for (const path of paths) {
    const invalid = structuredClone(effective);
    const target = path.split('.').reduce((value, key) => value[key] as Record<string, unknown>, invalid as unknown as Record<string, unknown>);
    target.apiKey = 'fixture-private-credential';
    assert.equal(Value.Check(EffectiveHarnessConfigurationSchema, invalid), false, path);
    await assert.rejects(harnessConfigurationScope(f.store, f.owner).bind(invalid), /Invalid effective/);
  }
  assert.equal(f.store.events().some(event => event.type === 'artifact.created'), false);
});

test('configuration and exact probe input commit before sending, and rebind per operation', async t => {
  const f = await fixtureStore(t);
  let calls = 0;
  const caller = fixtureCaller(async (_model, context, options) => {
    calls++;
    const requested = f.store.events().at(-1)!;
    assert.equal(requested.type, 'harness.probe_requested');
    assert.ok(Value.Check(HarnessProbeRequestedSchema, requested.payload));
    assert.equal(context.systemPrompt, requested.payload.systemPrompt);
    assert.deepEqual(context.messages, [{ role: 'user', content: requested.payload.userText, timestamp: requested.payload.timestamp }]);
    assert.equal(options?.maxRetries, 3);
    return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] } as never;
  });
  const effective = createHarnessAgents(config, caller).config.effective!;
  const first = await harnessConfigurationScope(f.store, f.owner).bind(effective);
  await caller.validate(undefined, first.probeAudit);
  const second = await harnessConfigurationScope(f.store, f.owner).bind(effective);
  assert.notEqual(first.reference.configurationId, second.reference.configurationId);
  assert.equal(first.reference.contentHash, second.reference.contentHash);
  assert.equal(calls, 1);
  const bound = f.store.events().filter(event => event.type === 'harness.configuration_bound');
  assert.equal(bound.length, 2);
  assert.ok(Value.Check(HarnessConfigurationBoundSchema, bound[0]!.payload));
  assert.equal(sha256(canonicalJson(bound[0]!.payload.configuration)), first.reference.contentHash);
  const artifact = await f.store.readArtifact({ experimentId: f.owner.experimentId, runId: f.owner.runId, artifactId: first.reference.artifactId });
  assert.equal(Buffer.from(artifact).toString(), canonicalJson(effective));
  assert.doesNotMatch(await readFile(join(f.root, 'events.jsonl'), 'utf8'), /fixture-private|apiKey|keyRef/);
  await f.store.close();
  const reopened = await ExperimentStore.open(f.root, f.owner.experimentId);
  assert.equal(reopened.events().filter(event => event.type === 'harness.configuration_bound').length, 2);
});

test('probe cannot send after request audit failure and preserves transport plus completion audit errors', async () => {
  let calls = 0;
  const transport = new Error('transport failed');
  const auditFailure = new Error('audit disk failed');
  const caller = fixtureCaller(async () => { calls++; throw transport; });
  await assert.rejects(caller.validate(undefined, { requested: async () => { throw auditFailure; }, completed: async () => undefined }),
    error => error instanceof HarnessProbeAuditError && error.cause === auditFailure);
  assert.equal(calls, 0);
  await assert.rejects(caller.validate(undefined, { requested: async () => undefined, completed: async () => { throw auditFailure; } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [transport, auditFailure]);
    return true;
  });
  assert.equal(calls, 1);
  const successful = fixtureCaller();
  await assert.rejects(successful.validate(undefined, { requested: async () => undefined, completed: async () => { throw auditFailure; } }),
    error => error instanceof HarnessProbeAuditError && error.cause === auditFailure);
});

test('uncommitted configuration files and foreign probe refs cannot authenticate a model request', async t => {
  const f = await fixtureStore(t);
  const effective = createHarnessAgents(config, fixtureCaller()).config.effective!;
  const reference = { ...f.owner, configurationId: 'config-orphan', artifactId: 'config-orphan.json', contentHash: sha256(canonicalJson(effective)) };
  await assert.rejects(f.store.append({ type: 'harness.configuration_bound', runId: f.owner.runId,
    payload: { schemaVersion: 1, reference, configuration: effective } }), /committed artifact/);
  const valid = await harnessConfigurationScope(f.store, f.owner).bind(effective);
  await assert.rejects(f.store.append({ type: 'harness.probe_requested', runId: 'foreign-run', payload: { schemaVersion: 1,
    reference: valid.reference, requestId: 'probe-orphan', outerAttempt: 1, template: 'reprise-connection-check-v1', timestamp: 1,
    systemPrompt: 'Reprise connection check. Reply with exactly OK.', userText: 'Reply with exactly OK.', sdkRetries: 'managed-by-pi-sdk' } }), /prior configuration/);
});

test('manifest cannot publish a configuration reference without the exact committed owner', async t => {
  const f = await fixtureStore(t);
  const effective = createHarnessAgents(config, fixtureCaller()).config.effective!;
  const valid = await harnessConfigurationScope(f.store, f.owner).bind(effective);
  const manifest = fixtureManifest(f, { ...valid.reference, configurationId: 'config-foreign', artifactId: 'config-foreign.json' });
  await assert.rejects(f.store.commitManifest(manifest), /committed operation binding/);
  await assert.rejects(readFile(join(f.root, 'runs', f.owner.runId, 'manifest.json')), { code: 'ENOENT' });
  manifest.controller.effectiveReference = valid.reference;
  await f.store.commitManifest(manifest);
  assert.equal(f.store.events().filter(event => event.type === 'run.manifest_created').length, 1);
});

test('same-run configuration cannot be substituted between run, Recovery, or Comparison attempts', async t => {
  const f = await fixtureStore(t);
  const effective = createHarnessAgents(config, fixtureCaller()).config.effective!;
  const run = await harnessConfigurationScope(f.store, f.owner).bind(effective);
  const recoveryStart = { schemaVersion: 2, attemptId: 'recovery-init-config', phase: 'staging', operation: 'initialize',
    attemptNumber: 1, result: 'started', durationMs: 0, recordedAt: '2026-10-15T00:00:00.000Z' };
  await f.store.append({ type: 'recovery.attempt', runId: f.owner.runId, payload: recoveryStart });
  const recovery = await harnessConfigurationScope(f.store, { ...f.owner, operation: 'recovery' }).bind(effective);
  await f.store.append({ type: 'comparison.started', runId: f.owner.runId, payload: { attemptId: 'comparison-current' } });
  const comparison = await harnessConfigurationScope(f.store, { ...f.owner, operation: 'comparison', comparisonAttemptId: 'comparison-current' }).bind(effective);
  for (const binding of [recovery, comparison]) {
    await assert.rejects(f.store.commitManifest(fixtureManifest(f, binding.reference)), /different operation/);
  }
  await assert.rejects(f.store.append({ type: 'recovery.attempt', runId: f.owner.runId,
    payload: { ...recoveryStart, result: 'succeeded', effectiveReference: run.reference } }), /different operation/);
  await assert.rejects(f.store.append({ type: 'comparison.started', runId: f.owner.runId,
    payload: { attemptId: 'comparison-other', effectiveReference: comparison.reference } }), /different operation/);
  await f.store.commitManifest(fixtureManifest(f, run.reference));
  await f.store.append({ type: 'comparison.started', runId: f.owner.runId,
    payload: { attemptId: 'comparison-inline', effectiveReference: run.reference } });
});

test('production factory reuses connection validation but resolves changed budgets and binds every run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new VerifiedRuntime();
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  await mkdir(base.dataDir, { recursive: true });
  await saveHarnessModelConfig(base.dataDir, config);
  let validations = 0;
  t.mock.method(PiModelCaller.prototype, 'validate', async () => { validations++; return {}; });
  t.mock.method(runtime, 'validateCandidate', async () => { throw new Error('stop after initialization'); });
  const budget = { callTimeoutMs: 5000, maxStructuredRepairAttempts: 1 };
  const recoveryBudget = { callTimeoutMs: 7000, maxStructuredRepairAttempts: 1 };
  const workflow = createHarnessWorkflow({ dataDir: base.dataDir, lookup: createProductLookup([{ ...codexProductPack, runtime }]),
    now: () => base.now, defaults: { candidate: base.candidate, policy: base.policy }, budget, recoveryBudget });
  for (const runId of ['run-cache-1', 'run-cache-2', 'run-cache-3']) {
    if (runId === 'run-cache-2') { budget.callTimeoutMs = 9000; recoveryBudget.callTimeoutMs = 11000; }
    if (runId === 'run-cache-3') await saveHarnessModelConfig(base.dataDir, { ...config, apiKey: 'fixture-rotated-credential' });
    const handle = await workflow.start({ taskCase: base.taskCase, sourceRoot: base.sourceRoot,
      experimentId: base.experimentId, runId, onEvent: () => undefined });
    await assert.rejects(handle.result, /stop after initialization/);
  }
  assert.equal(validations, 2);
  const store = await ExperimentStore.open(join(base.dataDir, 'experiments', base.experimentId), base.experimentId);
  const bindings = store.events().filter(event => event.type === 'harness.configuration_bound');
  assert.equal(bindings.length, 3);
  const configs = bindings.map(event => {
    assert.ok(Value.Check(HarnessConfigurationBoundSchema, event.payload));
    return event.payload;
  });
  assert.equal(new Set(configs.map(value => value.reference.configurationId)).size, 3);
  assert.deepEqual(configs.map(value => value.configuration.comparison.configuredCallCap.milliseconds), [5000, 9000, 9000]);
  assert.deepEqual(configs.map(value => value.configuration.recovery.singleCall.kind === 'finite' && value.configuration.recovery.singleCall.milliseconds), [7000, 11000, 11000]);
  assert.doesNotMatch(await readFile(join(base.dataDir, 'experiments', base.experimentId, 'events.jsonl'), 'utf8'), /fixture-private|fixture-rotated|apiKey|keyRef/);
});

for (const origin of ['probe', 'binding'] as const) {
test(`production re-comparison ${origin} failure owns the current attempt and preserves the previous report`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compare-probe-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new VerifiedRuntime();
  const base = input(root, runtime);
  await mkdir(base.sourceRoot, { recursive: true });
  const first = await startExperiment(base).result;
  const previousBytes = await readFile(first.reportPath);
  await saveHarnessModelConfig(base.dataDir, config);
  const failingCaller = fixtureCaller(async () => { throw new Error('fixture network unavailable'); });
  const validate = PiModelCaller.prototype.validate.bind(failingCaller);
  let validations = 0;
  t.mock.method(PiModelCaller.prototype, 'validate', (...args: Parameters<PiModelCaller['validate']>) => { validations++; return validate(...args); });
  if (origin === 'binding') {
    t.mock.method(ExperimentStore.prototype, 'commitArtifact', (artifact: Parameters<ExperimentStore['commitArtifact']>[0]) => {
      assert.equal(artifact.kind, 'harness_effective_configuration');
      throw new Error('fixture configuration disk failed');
    });
  }
  const workflow = createHarnessWorkflow({ dataDir: base.dataDir, lookup: createProductLookup([{ ...codexProductPack, runtime }]),
    now: () => base.now, defaults: { candidate: base.candidate, policy: base.policy } });
  await assert.rejects(workflow.comparePersisted(base.experimentId, undefined, undefined, base.runId),
    origin === 'probe' ? /connection probe failed/ : /configuration disk failed/);
  assert.equal(validations, origin === 'probe' ? 1 : 0);
  const store = await ExperimentStore.open(first.experimentRoot, base.experimentId);
  const events = store.events(base.runId);
  const started = events.filter(event => event.type === 'comparison.started');
  assert.equal(started.length, 2);
  const currentAttemptId = (started.at(-1)!.payload as { attemptId: string }).attemptId;
  const configuration = events.find(event => event.type === 'harness.configuration_bound');
  const request = events.find(event => event.type === 'harness.probe_requested');
  if (origin === 'probe') {
    assert.ok(configuration && Value.Check(HarnessConfigurationBoundSchema, configuration.payload));
    assert.equal(configuration.payload.reference.comparisonAttemptId, currentAttemptId);
    assert.ok(configuration.sequence > started.at(-1)!.sequence);
    assert.ok(request && request.sequence > configuration.sequence);
  } else {
    assert.equal(configuration, undefined);
    assert.equal(request, undefined);
  }
  assert.equal(events.filter(event => event.type === 'comparison.operation_failed').length, 1);
  assert.equal(events.some(event => event.type === 'run.startup_failed'), false);
  const selected = await readRunComparison({ experimentRoot: first.experimentRoot, experimentId: base.experimentId, runId: base.runId, events });
  assert.equal(selected.comparison?.status, 'failed');
  if (selected.comparison?.status === 'failed') assert.equal(selected.comparison.failure.code, origin === 'probe' ? 'provider_failure' : 'agent_failure');
  assert.equal(selected.reportPath, undefined);
  assert.equal(selected.previousReportPath, first.reportPath);
  const history = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(history.comparisonStatus, 'failed');
  assert.equal(history.comparisonFailureStage, 'agents');
  assert.match(history.comparisonFailureMessage!, origin === 'probe' ? /connection probe failed/ : /configuration disk failed/);
  const detail = renderHistoryDetail(createTheme(140, false), 140, history, 'zh').join('\n');
  assert.match(detail, /比较失败阶段.*agents/);
  assert.match(detail, origin === 'probe' ? /connection probe failed/ : /configuration disk failed/);
  assert.equal(history.reportPath, undefined);
  assert.equal(history.previousReportPath, first.reportPath);
  assert.deepEqual(await readFile(first.reportPath), previousBytes);
  await store.acquireWriter();
  await store.append({ type: 'comparison.started', runId: base.runId, payload: { attemptId: currentAttemptId, phase: 'preparation' } });
  await store.close();
  const reused = await readRunComparison({ experimentRoot: first.experimentRoot, experimentId: base.experimentId, runId: base.runId,
    events: store.events(base.runId) });
  assert.equal(reused.comparison, undefined);
  assert.equal(reused.comparisonFailureStage, undefined);
  assert.equal(reused.comparisonFailureMessage, undefined);
});
}
