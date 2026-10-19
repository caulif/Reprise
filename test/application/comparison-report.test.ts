import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertComparisonResult } from '../../src/agents/comparison-contract.js';
import { buildComparisonContext, comparePersistedFacts, type RunInspection } from '../../src/application/comparison.js';
import { fingerprintTree } from '../../src/environment/local-workspace-fs.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import type { ComparisonAgentPort } from '../../src/agents/comparison-contract.js';
import type { RunRecord, TaskCase } from '../../src/core/schema.js';
import { runAutonomousPublication } from '../support/autonomous-comparison.js';
import { Value } from '@sinclair/typebox/value';
import { ComparisonBriefingContextSchema } from '../../src/core/schema.js';
import { extractHostZoneSnapshot, hostZonesMismatch, renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';

const timestamp = '2026-08-15T00:00:00.000Z';

test('session dates use earliest valid history and run time in UTC and survive frozen facts', () => {
  const historical = taskCase();
  historical.historicalEvents = [
    { timestamp: '2026-10-13T12:00:00Z' },
    { timestamp: '2026-10-12T00:30:00+08:00' },
    { timestamp: '2026-02-30T00:00:00Z' },
    { timestamp: '2026-01-01T00:00:00' },
  ];
  const context = buildComparisonContext(historical, [runRecord()]);
  const frozen = JSON.parse(JSON.stringify(context)) as typeof context;
  assert.equal(Value.Check(ComparisonBriefingContextSchema, frozen), true);
  assert.deepEqual(frozen.reportFacts.sessionDates, { baseline: '2026-10-11', candidate: '2026-08-15' });
  const html = renderComparisonReportShell({ task: 'Dates', facts: frozen.reportFacts, metrics: {} });
  assert.match(html, /历史会话[^\n]*2026-10-11 UTC/);
  assert.match(html, /当前会话[^\n]*2026-08-15 UTC/);
  const snapshot = extractHostZoneSnapshot(html);
  assert.ok(snapshot);
  assert.equal(hostZonesMismatch(html.replaceAll('2026-10-11', '2026-10-10'), snapshot, {}), 'Host zone "header" was modified.');
  delete frozen.reportFacts.sessionDates;
  assert.equal(Value.Check(ComparisonBriefingContextSchema, frozen), true);
  const legacy = renderComparisonReportShell({ task: 'Dates', facts: frozen.reportFacts, metrics: {}, locale: 'en' });
  assert.equal(legacy.match(/Date unknown/g)?.length, 2);
});

test('session Agent names use injected product labels independently of model names and remain in frozen facts', () => {
  const historical = taskCase();
  historical.sourceRuntimeEvidence.model = 'shared-model';
  const run = runRecord();
  run.attempt.candidate.productId = 'claude-code';
  run.attempt.candidate.requestedModel = 'shared-model';
  const names = new Map([['codex', 'Scoped Codex'], ['claude-code', 'Scoped Claude']]);
  const options = { resolveProductName: (productId: string) => names.get(productId) ?? productId };
  const context = buildComparisonContext(historical, [run], [], options);
  assert.deepEqual(context.reportFacts.sessionAgents, { baseline: 'Scoped Codex', candidate: 'Scoped Claude' });
  const frozen: unknown = JSON.parse(JSON.stringify(context));
  assert.ok(Value.Check(ComparisonBriefingContextSchema, frozen));
  assert.deepEqual(frozen.reportFacts.sessionAgents, context.reportFacts.sessionAgents);
  run.attempt.candidate.productId = 'future-agent';
  assert.deepEqual(buildComparisonContext(historical, [run], [], options).reportFacts.sessionAgents, { baseline: 'Scoped Codex', candidate: 'future-agent' });
  assert.deepEqual(buildComparisonContext(historical, [], [], options).reportFacts.sessionAgents, { baseline: 'Scoped Codex' });
  assert.deepEqual(buildComparisonContext(historical, [run]).reportFacts.sessionAgents, { baseline: 'codex', candidate: 'future-agent' });
});

test('session dates retain history-only metadata without substituting import time', () => {
  const historical = taskCase();
  historical.taskContext = { historyStartedAt: '2026-10-10T23:30:00-04:00' };
  assert.deepEqual(buildComparisonContext(historical, []).reportFacts.sessionDates, { baseline: '2026-10-11' });
  historical.taskContext.historyStartedAt = 'invalid';
  const run = runRecord();
  run.attempt.createdAt = '2026-13-01T00:00:00Z';
  const facts = buildComparisonContext(historical, [run]).reportFacts;
  assert.deepEqual(facts.sessionDates, {});
  const html = renderComparisonReportShell({ task: 'Dates', facts, metrics: {} });
  assert.equal(html.match(/日期未知/g)?.length, 2);
});

test('session date prefers the manifest start over attempt creation', () => {
  const run = runRecord();
  const agent = { providerId: 'fixture', requestedModel: 'fixture', budget: { callTimeoutMs: 1000, maxStructuredRepairAttempts: 0 } };
  run.manifest = {
    schemaVersion: 1, attempt: run.attempt,
    resolvedModel: { requested: 'fixture', resolved: 'fixture' },
    runtime: { productId: 'codex', executable: 'fixture' },
    environment: { environmentId: 'env-1', workspacePath: 'fixture' },
    controller: agent, comparison: agent, startedAt: '2026-08-16T01:00:00Z',
  };
  assert.equal(buildComparisonContext(taskCase(), [run]).reportFacts.sessionDates?.candidate, '2026-08-16');
});
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: '修复报告。' }, transcript: [{ id: 'message-1', role: 'user', text: '修复报告。' }], historicalEvents: [], baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: ['event:baseline-1'] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function runRecord(): RunRecord { return { attempt: { schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-5.6' }, policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 }, createdAt: timestamp }, state: 'finished', stageReached: 'awaiting_controller', outcome: { task: { status: 'incomplete', evidenceRefs: [] }, termination: { kind: 'limit_reached', code: 'limit.turns', initiatedBy: 'harness' }, cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: [] } }, trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 1, lastSequence: 2 }, artifactRefs: [], warnings: [] }; }

test('comparison write tool writes report.html and refuses candidate paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-report-'));
  const candidate = join(root, 'isolation');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, 'kept.txt'), 'keep');
  const html = '<!doctype html><style>body{color:red}</style><svg><path /></svg><script>window.ok=true</script>';
  const tools = workspaceTools(root, {
    mounts: { candidate },
    allowWrite: (path) => path === 'report.html',
    completionPaths: new Set(['report.html']),
    denyDestructiveOnPrefix: ['candidate'],
    allowShell: true, managedExecution: true,
  });
  const write = tools.find((tool) => tool.name === 'write');
  assert.ok(write);
  const before = await fingerprintTree(candidate);
  await write.execute({ path: 'report.html', content: html }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), html);
  await assert.rejects(write.execute({ path: 'candidate/kept.txt', content: 'nope' }, new AbortController().signal), /write_denied/);
  const shellTool = tools.find((tool) => tool.name === 'exec_command');
  assert.ok(shellTool);
  assert.match(shellTool.description, /filesystem ACL|Read-only mounts/);
  await assert.rejects(
    shellTool.execute({ cmd: 'Remove-Item candidate/kept.txt' }, new AbortController().signal, { sessionId: 'test', invocationId: 'test' }),
    /write_denied/,
  );
  const after = await fingerprintTree(candidate);
  assert.equal(after.fingerprint.digest, before.fingerprint.digest);
  assert.equal(await readFile(join(candidate, 'kept.txt'), 'utf8'), 'keep');
});

test('comparison write policy uses the first path segment, not a string prefix', async (t) => {
  const { comparisonAttemptWriteAllowed } = await import('../../src/application/experiment-report.js');
  assert.equal(comparisonAttemptWriteAllowed('scratch/notes.md'), true);
  assert.equal(comparisonAttemptWriteAllowed('scratch-evil/notes.md'), false);
  assert.equal(comparisonAttemptWriteAllowed('work/comparison-plan.md'), true);
  assert.equal(comparisonAttemptWriteAllowed('report.html'), false);
  const root = await mkdtemp(join(tmpdir(), 'reprise-scratch-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = workspaceTools(root, {
    allowWrite: comparisonAttemptWriteAllowed,
  }).find((tool) => tool.name === 'write');
  assert.ok(write);
  await write.execute({ path: 'scratch/ok.txt', content: 'ok' }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'scratch', 'ok.txt'), 'utf8'), 'ok');
  await assert.rejects(write.execute({ path: 'report.html', content: 'nope' }, new AbortController().signal), /write_denied/);
  await assert.rejects(
    write.execute({ path: 'scratch-evil/pwn.txt', content: 'nope' }, new AbortController().signal),
    /write_denied/,
  );
});


test('comparison envelope accepts only report.html', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, context));
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: 'Same files, fewer turns.' }, context));
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'other.html', evidenceRefs: [] }, context), /schema validation failed/);
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: 'x'.repeat(281) }, context), /schema validation failed/);
});

test('reportFacts preserve missing measurements and project known run facts', () => {
  const inspection: RunInspection = { runId: 'run-1', changedPaths: ['src/a.ts'], runtimeGeneratedPaths: [], commands: ['npm test'], rejectedApprovals: 1, turns: 2, replayConditions: ['sourceRootKind=stand_in'] };
  const facts = buildComparisonContext(taskCase(), [runRecord()], [inspection]).reportFacts;
  assert.equal(facts.run.terminationCode, 'limit.turns');
  assert.equal(facts.run.candidateElapsedMs, undefined);
  assert.equal(facts.activity.candidateTurns, 2);
  assert.equal(facts.limits.triggered[0], 'limit.turns');
  assert.deepEqual(facts.delivery.changedPaths, ['src/a.ts']);
  assert.equal(facts.replay.baselineEvidence, 'verifiable');
  assert.equal(facts.metrics?.candidate?.usageStatus, 'not_collected');
  assert.equal(facts.metrics?.baseline?.usageStatus, 'not_collected');
  assert.equal(facts.metrics?.candidate?.toolCostsIncluded, false);
  assert.equal(facts.metrics?.candidate?.tokens, undefined);
});

test('reportFacts mark untotalable tokenUsage as unknown', () => {
  const facts = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, tokenUsage: {},
  }]).reportFacts;
  assert.equal(facts.metrics?.candidate?.usageStatus, 'unknown');
  assert.equal(facts.metrics?.candidate?.pricingStatus, 'unknown');
  assert.equal(facts.metrics?.candidate?.tokens, undefined);
});

test('reportFacts mark cost without token totals as unknown', () => {
  const facts = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, costUsd: 0.12,
  }]).reportFacts;
  assert.equal(facts.metrics?.candidate?.usageStatus, 'unknown');
  assert.equal(facts.metrics?.candidate?.tokens, undefined);
  assert.equal(facts.metrics?.candidate?.costUsd, 0.12);
  assert.equal(facts.metrics?.candidate?.pricingStatus, 'unknown');
});

test('reportFacts project collected token parts without inventing speed or cost', () => {
  const totalOnly = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, tokenUsage: { total: 256 },
  }]).reportFacts;
  assert.deepEqual(totalOnly.metrics?.candidate?.tokens, { total: 256 });
  assert.equal(totalOnly.metrics?.candidate?.usageStatus, 'collected');
  assert.equal(totalOnly.metrics?.candidate?.toolCostsIncluded, false);
  assert.equal(totalOnly.metrics?.candidate?.costUsd, undefined);
  assert.equal(totalOnly.metrics?.candidate?.pricingStatus, 'pricing_unavailable');
  assert.equal(totalOnly.metrics?.baseline?.usageStatus, 'not_collected');
  assert.equal(totalOnly.metrics?.baseline?.pricingStatus, 'not_collected');
  const withClock = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 4_000, tokenUsage: { total: 256 },
  }]).reportFacts;
  assert.equal(withClock.metrics?.candidate?.elapsedMs, 4_000);
});

test('comparison envelope keeps valid short refs when no allowlist is provided', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-01'] }, context));
});

test('comparison envelope accepts short evidence refs and rejects long event ids', () => {
  const context = {
    ...buildComparisonContext(taskCase(), [runRecord()]),
    shortEvidenceRefs: ['ev-01'],
  };
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-01'] }, context));
  assert.throws(
    () => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['event:foreign-1'] }, context),
    /schema validation failed/,
  );
  assert.throws(
    () => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-99'] }, context),
    /unknown evidence refs: ev-99/,
  );
});

test('comparison envelope reads live getEvidenceCatalog over a stale shortEvidenceRefs snapshot', () => {
  const context = {
    ...buildComparisonContext(taskCase(), [runRecord()]),
    shortEvidenceRefs: ['ev-01'],
  };
  assert.doesNotThrow(() => assertComparisonResult(
    { status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-02'] },
    context,
    () => ({
      links: [
        { side: 'candidate', inspectPath: 'candidate/a', shortRef: 'ev-01' },
        { side: 'candidate', inspectPath: 'candidate/b', shortRef: 'ev-02' },
      ],
      media: [],
    }),
  ));
});

test('comparison orchestration rejects long event ids in the envelope', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: ['event:foreign-1'] } }), cancel: async () => {} };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent, attemptId: 'attempt-1' }), /schema validation failed/);
});

test('comparePersistedFacts requires an explicit attemptId', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [] } }), cancel: async () => {} };
  await assert.rejects(
    comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent, attemptId: '' }),
    /Comparison attemptId is required/,
  );
});

test('comparison orientation does not inline the initial task and points at user-inputs', async () => {
  const { comparisonOrientation } = await import('../../src/application/comparison-briefing.js');
  const prompt = comparisonOrientation({
    briefingRoot: 'C:/tmp/briefing',
    indexMarkdown: '- observations/user-inputs/INDEX.tsv — demand index\n',
    baselineAvailable: true,
    candidateAvailable: true,
  });
  assert.doesNotMatch(prompt, /initialTask=/);
  assert.doesNotMatch(prompt, /修复报告/);
  assert.match(prompt, /observations\/user-inputs\/INDEX\.tsv/);
  assert.match(prompt, /Inspect the actual deliveries below before expanding into process history/);
  assert.doesNotMatch(prompt, /briefingRoot=/);
  assert.doesNotMatch(prompt, /every user turn in index order/);
});

test('comparison briefing names incomplete and unknown snapshots', async () => {
  const { comparisonSnapshotLabel } = await import('../../src/application/comparison-briefing.js');
  assert.equal(comparisonSnapshotLabel('missing'), 'unknown');
  assert.equal(comparisonSnapshotLabel('incomplete'), 'incomplete');
});

test('comparison short refs and path facts stay bounded and ignore workspace internals', async () => {
  const { Value } = await import('@sinclair/typebox/value');
  const { ComparisonLinksSchema } = await import('../../src/core/schema.js');
  const { isComparisonChangedPath } = await import('../../src/application/controller-queries.js');
  assert.equal(isComparisonChangedPath('.git/objects/abc'), false);
  assert.equal(isComparisonChangedPath('.pytest_cache/state'), false);
  assert.equal(isComparisonChangedPath('pkg/.git/objects/abc'), false);
  assert.equal(isComparisonChangedPath('src/__pycache__/mod.pyc'), false);
  assert.equal(isComparisonChangedPath('app/.venv/lib/site.py'), false);
  assert.equal(isComparisonChangedPath('src/report.md'), true);
  assert.equal(Value.Check(ComparisonLinksSchema, [{ side: 'candidate', inspectPath: 'candidate/x', shortRef: 'ev-100' }]), true);
  assert.equal(Value.Check(ComparisonLinksSchema, [{ side: 'candidate', inspectPath: 'candidate/x', shortRef: 'ev-999999' }]), true);
  assert.equal(Value.Check(ComparisonLinksSchema, [{ side: 'candidate', inspectPath: 'candidate/x', shortRef: 'ev-1' }]), false);
});

test('Host metrics shell matches the projected fingerprint and fails when numbers change', async () => {
  const { hostMetricsMismatch, renderComparisonReportShell } = await import('../../src/application/comparison-report-shell.js');
  const historical = taskCase();
  historical.historicalEvents = [
    { timestamp: '2026-09-11T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-09-11T00:02:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    { timestamp: '2026-09-11T00:02:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 } } } },
  ];
  historical.sourceRuntimeEvidence.model = 'gpt-5';
  const facts = buildComparisonContext(historical, [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 13 * 60_000, tokenUsage: { total: 256 }, costUsd: 0.49,
  }]).reportFacts;
  const html = renderComparisonReportShell({
    task: historical.initialInput.text,
    facts,
    metrics: facts.metrics ?? {},
  });
  assert.doesNotMatch(html, /\.task \{[^}]*white-space:nowrap/);
  assert.doesNotMatch(html, /data-host="status"/);
  assert.match(html, /data-agent-slot="headline"/);
  assert.match(html, /data-agent-zone="comparison"/);
  assert.match(html, /data-host-zone="metrics"/);
  assert.equal(hostMetricsMismatch(html, facts.metrics ?? {}), undefined);
  assert.match(html, /2:00<span class="unit">分:秒<\/span>/);
  assert.match(html, /13:00<span class="unit">分:秒<\/span>/);
  assert.match(html, /0\.49<span class="unit">\$/);
  assert.match(html, /钉住的价格快照/);
  assert.doesNotMatch(html, /\.num\.miss \{[^}]*white-space:nowrap/);
  assert.match(html, /2026-10-15-static-pricing/);
  assert.match(html, /cacheRead /);
  assert.match(html, /cacheCreation /);
  assert.equal(facts.models.baseline, 'gpt-5');
  assert.match(html, /<span>历史会话 · gpt-5 ·/);
  assert.match(html, /<span>当前会话 · 未记录 ·/);
  assert.doesNotMatch(html, />Baseline</);
  const tampered = html.replace('0.49', '9.99');
  assert.equal(hostMetricsMismatch(tampered, facts.metrics ?? {}), 'Host metrics numbers were modified.');
  assert.equal(hostMetricsMismatch('<html></html>', facts.metrics ?? {}), 'Host metrics block is missing.');
});

test('cost card distinguishes missing usage from missing prices', async () => {
  const { renderComparisonReportShell, formatCost } = await import('../../src/application/comparison-report-shell.js');
  assert.equal(formatCost({ pricingStatus: 'not_collected' }).text, '未采集');
  assert.equal(formatCost({ tokens: { total: 10 }, pricingStatus: 'pricing_unavailable' }).text, '价格未配置');
  assert.equal(formatCost({ pricingStatus: 'unknown' }).text, '不可计算');
  assert.equal(formatCost({ costUsd: 0.42, pricingStatus: 'collected' }).text, '0.42');
  assert.equal(formatCost({ pricingStatus: 'not_collected' }, 'en').text, 'not collected');
  assert.equal(formatCost({ tokens: { total: 10 }, pricingStatus: 'pricing_unavailable' }, 'en').text, 'no price configured');
  const facts = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, tokenUsage: { total: 256 },
  }]).reportFacts;
  const html = renderComparisonReportShell({ task: '修复报告。', facts, metrics: facts.metrics ?? {} });
  assert.match(html, /价格未配置/);
});

test('direct full-page edits cannot publish through the current autonomous factory', async t => {
  const f = await runAutonomousPublication(t, { steps: [{ name: 'write', arguments: { path: 'report.html', content: '<p>kept-page</p>' }, error: true }] });
  assert.equal(f.result.comparison.result.status, 'failed');
  assert.equal(f.renders, 0);
  const draft = await readFile(join(f.attemptRoot, 'report.html'), 'utf8');
  assert.doesNotMatch(draft, /kept-page/);
  assert.ok(f.events.some(event => event.type === 'agent.tool_failed' && event.payload.tool === 'write' && event.payload.message === 'write_denied: path is outside the Host write policy.'));
  assert.equal(f.events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'write' && !event.payload.nativeHook), false);
  await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
});
