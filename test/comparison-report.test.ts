import test from 'node:test';
import assert from 'node:assert/strict';
import { assertComparisonResult, type ComparisonAgentPort, type ComparisonResult } from '../src/agents/comparison-agent.js';
import { comparePersistedFacts, buildComparisonContext } from '../src/application/comparison.js';
import type { RunRecord, TaskCase } from '../src/core/schema.js';
import { hostReplayConditions } from '../src/application/replay-conditions.js';
import { buildComparisonProjection, renderComparisonReport } from '../src/report/comparison-report.js';

const timestamp = '2026-08-10T00:00:00.000Z';
function taskCase(): TaskCase { return { schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' }, initialInput: { id: 'message-1', role: 'user', text: 'Create <strong>report</strong> at C:\\secret\\input.txt.' }, transcript: [{ id: 'message-1', role: 'user', text: 'Create report.' }], historicalEvents: [], baseline: { status: 'available', finalMessage: 'Baseline finished /private/baseline.txt.', artifactRefs: [{ artifactId: 'baseline-1', caseId: 'case-1' }], evidenceRefs: ['event:baseline-1'] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, taskContext: { historicalCommit: 'a'.repeat(40), historicalEnvironment: { cwd: { git: { head: 'b'.repeat(40), dirty: true } } }, historicalBehavior: { commands: ['npm test'], touchedPaths: ['src/historical.ts'] } }, provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64) }; }
function runRecord(): RunRecord { return { attempt: { schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1', candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'test-model' }, policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 2, turnTimeoutMs: 1000000, maxConsecutiveNoProgress: 1 }, createdAt: timestamp }, state: 'finished', stageReached: 'awaiting_controller', outcome: { task: { status: 'apparently_completed', decidedBy: 'controller', evidenceRefs: ['event:task-1'] }, termination: { kind: 'completed', code: 'completed.controller_satisfied', initiatedBy: 'controller' }, cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: ['event:cleanup-1'] } }, trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 3, lastSequence: 8 }, artifactRefs: [{ artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }], warnings: [{ code: 'notice', message: 'See /private/trace.log.', evidenceRefs: ['event:warning-1'] }] }; }
function comparison(): ComparisonResult { return { status: 'completed', reportPath: 'comparison.md', evidenceRefs: ['artifact:output-1'], limitationCodes: ['No browser verification.'] }; }

test('report wraps the agent narrative in a deterministic shell of identity, metrics and file entries', () => {
  const html = renderComparisonReport(buildComparisonProjection({ taskCase: taskCase(), runs: [runRecord()], comparison: comparison(), comparisonNarrative: '# Summary\nAgent-authored body <script>alert(1)</script>.', inspections: [{ runId: 'run-1', finalMessage: 'Candidate finished.', changedPaths: ['src/report.ts'], runtimeGeneratedPaths: [], commands: ['npm test'], rejectedApprovals: 1, turns: 2, wallClockMs: 42, tokenCount: 128 }], artifacts: [{ ref: { artifactId: 'output-1', experimentId: 'experiment-1', runId: 'run-1' }, kind: 'image', mediaType: 'image/png', byteLength: 12 }] }));
  assert.match(html, /Reprise comparison · case-1 · run-1/);
  assert.match(html, /test-model · started 2026-08-10T00:00:00\.000Z/);
  assert.match(html, /Turns: 2 · Wall-clock: 42 ms · Changed files: 1 · Tokens: 128/);
  assert.match(html, /Single run; results are affected by randomness\. This report is not a ranking\./);
  assert.match(html, /<h1>Create /);
  assert.doesNotMatch(html, /<h1>case-1<\/h1>/);
  assert.match(html, /<h1>Summary<\/h1>/);
  assert.match(html, /Agent-authored body/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="comparison\.md"/);
  assert.match(html, /href="\.\/runs\/run-1\/artifacts\/output-1"/);
  assert.match(html, /side baseline/);
  assert.match(html, /side candidate/);
  assert.match(html, /workspace files were not captured/);
  assert.match(html, /1 changed path recorded: src\/report\.ts/);
  assert.match(html, /src\/report\.ts/);
  assert.ok(html.indexOf('class="narrative"') < html.indexOf('class="compare"'));
});

test('report header shows resolved model and Host-verified replay conditions', () => {
  const run = {
    ...runRecord(),
    attempt: { ...runRecord().attempt, candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' } },
    manifest: {
      schemaVersion: 1,
      attempt: { ...runRecord().attempt, candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' } },
      resolvedModel: { requested: 'sonnet', resolved: 'deepseek-v4-flash' },
      runtime: { productId: 'claude-code', executable: 'claude' },
      environment: { environmentId: 'environment-1', workspacePath: 'C:\\tmp\\run' },
      controller: { providerId: 'pi', requestedModel: 'harness', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 1 } },
      comparison: { providerId: 'pi', requestedModel: 'harness', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 1 } },
      startedAt: timestamp,
    },
  } as RunRecord;
  const html = renderComparisonReport(buildComparisonProjection({
    taskCase: taskCase(),
    runs: [run],
    inspections: [{
      runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1,
      replayConditions: [
        'Requested model sonnet resolved to deepseek-v4-flash; the alias is not a different model.',
        'The CLI catalog listed this model, and this run produced a native turn result. Listing is not the same as a successful call.',
        'permissionMode=bypassPermissions',
        'Isolation: --no-session-persistence; disallowed CronCreate, CronDelete, ScheduleWakeup, SendMessage.',
      ],
    }],
  }));
  assert.match(html, /sonnet → deepseek-v4-flash/);
  assert.match(html, /Listing is not the same as a successful call/);
  assert.match(html, /permissionMode=bypassPermissions/);
  assert.match(html, /CronCreate/);
  assert.match(html, /Controller judged the task complete/);
  assert.match(html, /<details class="limits">/);
  assert.match(html, /Replay limits/);
});

test('Chinese initialInput localizes Host chrome, stop label, and replay limits', () => {
  const task = { ...taskCase(), initialInput: { ...taskCase().initialInput, text: '请把论文要点整理成笔记。' } };
  const html = renderComparisonReport(buildComparisonProjection({
    taskCase: task,
    runs: [runRecord()],
    inspections: [{
      runId: 'run-1', changedPaths: ['notes.md'], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1,
      replayConditions: hostReplayConditions({
        sourceRootKind: 'historical_start',
        requestedModel: 'sonnet',
        resolvedModel: 'deepseek-v4-flash',
        record: runRecord(),
        settledTurns: 1,
        lang: 'zh',
      }),
    }],
  }));
  assert.match(html, /lang="zh"/);
  assert.match(html, /Reprise 比较 · case-1 · run-1/);
  assert.match(html, /开始于 2026-08-10T00:00:00\.000Z/);
  assert.match(html, /单次运行；结果受随机性影响。本报告不是排名。/);
  assert.match(html, /宿主对照/);
  assert.match(html, /仅有终稿；未采集工作区文件。/);
  assert.match(html, /冻结的历史会话/);
  assert.match(html, /回放限制/);
  assert.match(html, /判定任务已完成/);
  assert.match(html, /列入目录不等于调用成功/);
  assert.match(html, /sourceRootKind=historical_start/);
  assert.doesNotMatch(html, /Host contrast/);
  assert.doesNotMatch(html, /Replay limits/);
});

test('report header distinguishes satisfied, other controller stop, and safety-limit stop', () => {
  const htmlOf = (termination: RunRecord['outcome']['termination']) => renderComparisonReport(buildComparisonProjection({
    taskCase: taskCase(),
    runs: [{ ...runRecord(), outcome: { ...runRecord().outcome, termination } }],
  }));
  assert.match(htmlOf({ kind: 'completed', code: 'completed.controller_satisfied', initiatedBy: 'controller' }), /Controller judged the task complete/);
  assert.match(htmlOf({ kind: 'completed', code: 'completed.controller_no_further_value', initiatedBy: 'controller' }), /Controller stopped the run/);
  assert.doesNotMatch(htmlOf({ kind: 'completed', code: 'completed.controller_no_further_value', initiatedBy: 'controller' }), /judged the task complete/);
  assert.match(htmlOf({ kind: 'limit_reached', code: 'limit.controller_calls', initiatedBy: 'harness' }), /Safety limit stopped the run/);
});

test('host replay conditions distinguish alias, catalog listing, isolation, and stop kind', () => {
  const run = {
    ...runRecord(),
    attempt: { ...runRecord().attempt, candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' } },
    manifest: {
      schemaVersion: 1,
      attempt: { ...runRecord().attempt, candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' } },
      resolvedModel: { requested: 'sonnet', resolved: 'deepseek-v4-flash' },
      runtime: { productId: 'claude-code', executable: 'claude' },
      environment: { environmentId: 'environment-1', workspacePath: 'C:\\tmp\\run' },
      controller: { providerId: 'pi', requestedModel: 'harness', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 1 } },
      comparison: { providerId: 'pi', requestedModel: 'harness', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 1 } },
      startedAt: timestamp,
    },
    outcome: { ...runRecord().outcome, termination: { kind: 'completed', code: 'completed.controller_satisfied', initiatedBy: 'controller' } },
  } as RunRecord;
  const notes = hostReplayConditions({
    sourceRootKind: 'stand_in',
    requestedModel: 'sonnet',
    resolvedModel: 'deepseek-v4-flash',
    record: run,
    events: [{
      schemaVersion: 1, eventId: 'event-1', sequence: 1, type: 'claude-code.system_init',
      occurredAt: timestamp, checksum: 'a'.repeat(64), payload: { permissionMode: 'bypassPermissions' },
    }],
    settledTurns: 1,
    productId: 'claude-code',
  });
  assert.match(notes.join('\n'), /Requested model sonnet resolved to deepseek-v4-flash/);
  assert.match(notes.join('\n'), /Listing is not the same as a successful call/);
  assert.match(notes.join('\n'), /permissionMode=bypassPermissions/);
  assert.match(notes.join('\n'), /CronCreate/);
  assert.match(notes.join('\n'), /sourceRootKind=stand_in/);
  assert.match(notes.join('\n'), /Controller judged the task complete/);
  assert.match(notes.join('\n'), /isolated replica/);
  const zh = hostReplayConditions({
    sourceRootKind: 'stand_in',
    requestedModel: 'sonnet',
    resolvedModel: 'deepseek-v4-flash',
    record: run,
    settledTurns: 1,
    productId: 'claude-code',
    lang: 'zh',
  });
  assert.match(zh.join('\n'), /解析为 deepseek-v4-flash/);
  assert.match(zh.join('\n'), /列入目录不等于调用成功/);
  assert.match(zh.join('\n'), /隔离副本/);
});

test('report renders markdown headings, bold, tables and rewrites catalog artifact links', () => {
  const html = renderComparisonReport(buildComparisonProjection({
    taskCase: taskCase(),
    runs: [runRecord()],
    comparison: comparison(),
    comparisonNarrative: '# 对比结论\n**交付位置不同**\n\n| 维度 | 基线 | 候选 | 是否影响使用 |\n| --- | --- | --- | --- |\n| 落点 | 原库 | 隔离区 | 不影响 |\n\n[scope](artifact:output-1)\n\nSee [bad](javascript:alert(1)) and [ok](./runs/run-1/artifacts/output-1).',
  }));
  assert.match(html, /<h1>对比结论<\/h1>/);
  assert.match(html, /<strong>交付位置不同<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /是否影响使用/);
  assert.match(html, /href="\.\/runs\/run-1\/artifacts\/output-1"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /lang="en"/);
});

test('report keeps local paths readable and never leaks them into markup', () => {
  const html = renderComparisonReport(buildComparisonProjection({ taskCase: taskCase(), runs: [runRecord()], comparison: comparison(), comparisonNarrative: 'Wrote C:\\secret\\input.txt and /private/candidate.txt.' }));
  assert.match(html, /C:\\secret\\input\.txt/);
  assert.match(html, /\/private\/candidate\.txt/);
  assert.doesNotMatch(html, /path redacted/);
});

test('report falls back to a complete shell without an Agent narrative and re-renders deterministically', () => {
  const input = { taskCase: taskCase(), runs: [runRecord()] };
  const html = renderComparisonReport(buildComparisonProjection(input));
  assert.match(html, /No validated comparison narrative is available/);
  assert.match(html, /Changed files: 0|Trace events 3-8/);
  assert.match(html, /output-1/);
  assert.equal(html, renderComparisonReport(buildComparisonProjection(input)));
});

test('comparison envelope validation rejects missing and invalid schema fields', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.throws(() => assertComparisonResult({ status: 'completed', evidenceRefs: ['artifact:output-1'] }, context), /schema validation failed/);
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'comparison.md', evidenceRefs: ['not-a-ref'] }, context), /schema validation failed/);
});

test('comparison orchestration rejects envelope citations outside persisted facts', async () => {
  const agent: ComparisonAgentPort = { compare: async () => ({ status: 'completed', sessionId: 'comparison-1', value: { ...comparison(), evidenceRefs: ['event:foreign-1'] } }) };
  await assert.rejects(comparePersistedFacts({ taskCase: taskCase(), runs: [runRecord()], agent }), /unknown evidence reference/);
});

test('comparison briefing separates frozen historical evidence from this candidate replay', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: 'run-1', changedPaths: ['src/a.ts'], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1,
    replayConditions: ['sourceRootKind=stand_in. The candidate did not see the historical working tree.'],
  }]);
  assert.match(context.replayScope.historical, /frozen original session/);
  assert.match(context.replayScope.candidate, /this replay is only/i);
  assert.match(context.replayScope.candidate, /session start/);
  assert.doesNotMatch(context.replayScope.candidate, /transcript/);
  assert.equal(context.hostReplay?.sourceRootKind, 'stand_in');
  assert.equal(context.hostReplay?.stopKind, 'completed.controller_satisfied');
});
