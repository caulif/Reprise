import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertComparisonResult, COMPARISON_SYSTEM_PROMPT, COMPARISON_TURN_PROMPTS, ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { buildComparisonContext, comparePersistedFacts, type RunInspection } from '../../src/application/comparison.js';
import { fingerprintTree } from '../../src/environment/local-workspace-fs.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { startExperiment } from '../../src/application/experiment.js';
import { comparisonHtmlWithHostShell, input, VerifiedRuntime } from '../codex-experiment-support.js';
import type { ComparisonAgentPort } from '../../src/agents/comparison-agent.js';
import type { RunRecord, TaskCase } from '../../src/core/schema.js';

const timestamp = '2026-08-15T00:00:00.000Z';
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
    allowShell: true,
  });
  const write = tools.find((tool) => tool.name === 'write');
  assert.ok(write);
  const before = await fingerprintTree(candidate);
  await write.execute({ path: 'report.html', content: html }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), html);
  await assert.rejects(write.execute({ path: 'candidate/kept.txt', content: 'nope' }, new AbortController().signal), /write_denied/);
  const shellTool = tools.find((tool) => tool.name === 'shell_exec');
  assert.ok(shellTool);
  assert.match(shellTool.description, /filesystem ACL|Read-only mounts/);
  await assert.rejects(
    shellTool.execute({ command: 'Remove-Item candidate/kept.txt' }, new AbortController().signal),
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
  assert.equal(comparisonAttemptWriteAllowed('report.html'), true);
  const root = await mkdtemp(join(tmpdir(), 'reprise-scratch-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = workspaceTools(root, {
    allowWrite: comparisonAttemptWriteAllowed,
  }).find((tool) => tool.name === 'write');
  assert.ok(write);
  await write.execute({ path: 'scratch/ok.txt', content: 'ok' }, new AbortController().signal);
  assert.equal(await readFile(join(root, 'scratch', 'ok.txt'), 'utf8'), 'ok');
  await assert.rejects(
    write.execute({ path: 'scratch-evil/pwn.txt', content: 'nope' }, new AbortController().signal),
    /write_denied/,
  );
});


test('comparison envelope accepts only report.html', () => {
  const context = buildComparisonContext(taskCase(), [runRecord()]);
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, context));
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', evidenceRefs: [], headline: 'Same files, fewer turns.' }, context));
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

test('comparison prompt points workspace tools at the sealed snapshot mount', () => {
  assert.match(COMPARISON_SYSTEM_PROMPT, /candidate\/ is the sealed read-only/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /finals\//);
  assert.match(COMPARISON_SYSTEM_PROMPT, /render_artifact/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /register_evidence/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /preview_report/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /Need screenshots or page views only through render_artifact and preview_report/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /Do not run Chrome, Edge, or Firefox binaries/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /--version/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /--dump-dom/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /user browser profile/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /If a render tool fails, record the limitation/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /do not retry via equivalent browser shell commands/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /In this session you will receive, in order/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /最后一轮不能使用工具/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /read_observation/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /live isolated replica/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /comparison-sandbox\/candidate/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /pair-pages/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /at most three bullets/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /msedge\.exe --version/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /npx playwright/);
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
  assert.match(prompt, /Navigation for the attempt root is in INDEX\.md below/);
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
  assert.match(html, /white-space:nowrap/);
  assert.doesNotMatch(html, /\.task \{[^}]*white-space:nowrap/);
  assert.doesNotMatch(html, /data-host="status"/);
  assert.match(html, /data-agent-slot="headline"/);
  assert.match(html, /data-agent-zone="comparison"/);
  assert.match(html, /data-host-zone="metrics"/);
  assert.equal(hostMetricsMismatch(html, facts.metrics ?? {}), undefined);
  assert.match(html, /2<span class="unit">min<\/span>/);
  assert.match(html, /13<span class="unit">min<\/span>/);
  assert.match(html, /0\.49<span class="unit">\$/);
  assert.match(html, /钉住的价格快照/);
  assert.match(html, /\.num\.miss \{[^}]*white-space:nowrap/);
  assert.match(html, /2026-09-19-cc-switch-seed/);
  assert.match(html, /cacheRead /);
  assert.match(html, /cacheCreation /);
  assert.equal(facts.models.baseline, 'gpt-5');
  assert.match(html, /<div class="who">gpt-5<\/div>/);
  assert.match(html, /<div class="who">请求 gpt-5\.6 · 解析未确认<\/div>/);
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

test('compose and review prompts require autonomous zones and real preview', () => {
  assert.match(COMPARISON_TURN_PROMPTS.compose, /headline/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-agent-zone="comparison"/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-agent-zone="details"/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-claim="verified"/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-claim="visual"/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /Do not claim visual inspection/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /pair-pages/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /at most three bullets/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /leave empty when there are no paired images/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /If only one side has images, leave this zone empty/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /before key-differences/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /最重要的 2–4 个差异/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /Similar results are a valid finding/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /single frame does not prove motion/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /do not make visual-quality claims/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /harness limit or missing historical evidence/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /hidden by CSS and must not be copied onto the card face/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /Images belong on the card only when both sides have a comparable final/);
  assert.doesNotMatch(COMPARISON_SYSTEM_PROMPT, /The left side is the historical session/);
  assert.match(COMPARISON_TURN_PROMPTS.review, /preview_report/);
  assert.match(COMPARISON_TURN_PROMPTS.review, /Recheck if the draft changes/);
  assert.match(COMPARISON_TURN_PROMPTS.review, /specific\s+review limitation/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.review, /visual-evidence still immediately after the headline/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.review, /reopen report\.html and review/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.review, /已禁用工具/);
  assert.match(COMPARISON_TURN_PROMPTS.understand, /work\/comparison-plan\.md/);
  assert.match(COMPARISON_TURN_PROMPTS.investigate, /registered tools/);
  assert.match(COMPARISON_TURN_PROMPTS.investigate, /Stop investigating when additional work/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.investigate, /changedPathsOmitted/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.investigate, /最多四个候选差异/);
});

test('invalid comparison JSON keeps the already written report.html', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-invalid-envelope-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, 'source'), { recursive: true });
  await writeFile(join(root, 'source', 'README.md'), '# source\n');
  let round = 0;
  const comparison = new ComparisonAgent({
    timeoutMs: 0,
    maxRepairAttempts: 0,
    host: new AgentHost({
      createSession: (session) => ({
        append: async () => {
          round += 1;
          if (round === 3) {
            const read = session.tools?.find((tool) => tool.name === 'read');
            const write = session.tools?.find((tool) => tool.name === 'write');
            const page = await read?.execute({ path: 'report.html' }, new AbortController().signal);
            await write?.execute({
              path: 'report.html',
              content: comparisonHtmlWithHostShell(
                page?.content ? { reportShellHtml: page.content } : {},
                '<p>kept-page</p>',
              ),
            }, new AbortController().signal);
          }
          if (round < 4) return 'working';
          return 'not-json';
        },
        cancel() {},
      }),
    }),
  });
  const result = await startExperiment({ ...input(root, new VerifiedRuntime()), comparison }).result;
  assert.equal(result.comparison.result.status, 'failed');
  assert.equal(result.comparison.result.status === 'failed' ? result.comparison.result.failure.code : undefined, 'invalid_envelope');
  const attempts = join(result.experimentRoot, 'comparison-attempts');
  const dirs = await readdir(attempts);
  const draft = await readFile(join(attempts, dirs[0] ?? '', 'report.html'), 'utf8');
  assert.match(draft, /kept-page/);
});



