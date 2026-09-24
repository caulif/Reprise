import { mkdir, mkdtemp, readdir, writeFile, rm, cp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { IntakeTui } from '../dist/src/tui/intake-app.js';
import { visibleConfigItems } from '../dist/src/tui/config-input.js';
import { defaultHarnessModelConfig, saveHarnessModelConfig } from '../dist/src/infrastructure/harness-model-config.js';
import { canonicalizeAuditFrame, compareFrames, mockTui, pageHtml, selfTestCompareFrames, shouldCompareAuditFrames, toLf, waitFor } from '../dist/scripts/tui-audit-lib.js';
import {
  createScriptedSyntheticWorkflow,
  syntheticExperimentResult,
} from '../dist/test/tui/fixtures/synthetic-flow.js';

Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
process.env.TERM = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
process.env.FORCE_COLOR = '0';
delete process.env.NO_COLOR;

/** Neutral Windows cwd so frames do not bake in a developer home directory. */
const DISPLAY_CWD = 'C:\\reprise';

const checkMode = process.argv.includes('--check');
const outDir = join(process.cwd(), 'docs', 'tui-audit');
const baselineDir = join(outDir, 'frames');
const framesGeneratedDir = join(outDir, 'frames-generated');
const generatedRoot = checkMode ? await mkdtemp(join(tmpdir(), 'reprise-tui-check-')) : outDir;
const framesDir = checkMode ? join(generatedRoot, 'frames') : join(outDir, 'frames');
const htmlDir = checkMode ? join(generatedRoot, 'html') : join(outDir, 'html');
let stabilize = (text) => text;

function enterCommand(app, command) {
  app.handleInput(command);
  app.handleInput('\r');
}

function replaceField(app, value) {
  app.handleInput('\u0015');
  app.handleInput(value);
  app.handleInput('\r');
}

function editField(app, field) {
  const fields = visibleConfigItems(app.configDraft.kind, app.configAdvanced);
  const index = fields.indexOf(field);
  assert.ok(index >= 0, `Configuration field is visible: ${field}`);
  for (let step = 0; app.configSelected !== index && step < fields.length; step += 1) {
    app.handleInput(app.configSelected < index ? '\u001b[B' : '\u001b[A');
  }
  assert.equal(app.configSelected, index);
  app.handleInput('\r');
}

async function waitPage(app, page, frame, layer) {
  await waitFor(() => {
    assert.notEqual(app.page, 'error', app.message);
    return app.page === page && (layer === undefined || app.intakeLevel === layer);
  }, { describe: `${page}${layer ? `/${layer}` : ''}`, frame });
}

async function capture(name, width, frame) {
  const normalized = toLf(stabilize(frame));
  await writeFile(join(framesDir, `${name}.txt`), normalized, 'utf8');
  await writeFile(join(htmlDir, `${name}.html`), toLf(pageHtml(name, width, frame)), 'utf8');
  const issues = [];
  const lines = frame.split('\n');
  if (width < 78 && width >= 32 && /[┌┐└┘│─❯●✓…]/.test(frame)) {
    issues.push('compact frame still contains wide glyphs');
  }
  return { name, width, rows: lines.length, issues };
}

async function dumpGeneratedFrames(sourceDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  for (const name of await readdir(sourceDir)) {
    if (!name.endsWith('.txt')) continue;
    await cp(join(sourceDir, name), join(targetDir, name));
  }
  console.log(`audit:tui:check: wrote generated frames to ${targetDir}`);
}

async function main() {
  // Only regenerated artifacts are cleared; screenshots under outDir are captured evidence, not build output.
  await rm(framesDir, { recursive: true, force: true });
  await rm(htmlDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-audit-'));
  const sessionsRoot = join(root, 'sessions');
  const claudeSessionsRoot = join(root, 'claude-sessions');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(claudeSessionsRoot, { recursive: true });
  const tuiOptions = (dataDir, extra = {}) => ({
    dataDir, sessionsRoot, sessionsRoots: { codex: sessionsRoot, 'claude-code': claudeSessionsRoot },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    nowMs: () => 0,
    displayCwd: DISPLAY_CWD,
    autoCompare: true,
    ...extra,
  });

  const posix = root.replaceAll('\\', '/');
  const win = root.replaceAll('/', '\\');
  const cwd = process.cwd();
  const userHome = homedir();
  stabilize = (text) => canonicalizeAuditFrame(
    text
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split(pathToFileURL(root).href).join('file:///TMP')
      .split(win).join('TMP')
      .split(posix).join('TMP')
      .split(cwd.replaceAll('/', '\\')).join(DISPLAY_CWD)
      .split(cwd.replaceAll('\\', '/')).join(DISPLAY_CWD)
      .split(userHome.replaceAll('/', '\\')).join('C:\\user')
      .split(userHome.replaceAll('\\', '/')).join('C:/user')
      .replace(/reprise-tui-audit-[A-Za-z0-9]+/g, 'reprise-tui-audit-TMP'),
    [[root, 'TMP'], [cwd, DISPLAY_CWD], [userHome, 'C:\\user']],
  );
  await saveHarnessModelConfig(join(root, 'data'), defaultHarnessModelConfig());
  await writeFile(join(sessionsRoot, 'rollout-session-1.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: 'C:/source', cli_version: '0.1.0' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed it.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:04.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Verify the regression.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  await writeFile(join(sessionsRoot, 'rollout-session-cjk.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-10T21:40:00.000Z', type: 'session_meta', payload: { id: 'session-cjk', cwd: 'C:/中文路径/reprise', cli_version: '0.1.0' } }),
    JSON.stringify({ timestamp: '2026-08-10T21:40:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '修复这个回归缺陷并验证测试全部通过' } }),
    JSON.stringify({ timestamp: '2026-08-10T21:40:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '已修复，并补了回归测试。' } }),
    JSON.stringify({ timestamp: '2026-08-10T21:40:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');

  const claudeSessionId = '22222222-3333-4444-8555-666666666666';
  const claudeProject = join(claudeSessionsRoot, 'C--claude-audit');
  await mkdir(claudeProject, { recursive: true });
  await writeFile(join(claudeProject, `${claudeSessionId}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId: claudeSessionId, timestamp: '2026-08-11T00:00:00.000Z', cwd: 'C:/claude-audit', message: { role: 'user', content: 'Review the product intake flow.' } }),
    JSON.stringify({ type: 'assistant', sessionId: claudeSessionId, timestamp: '2026-08-11T00:00:01.000Z', cwd: 'C:/claude-audit', message: { role: 'assistant', model: 'claude-audit', content: [{ type: 'text', text: 'Reviewed the flow.' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n');
  const captures = [];
  const push = async (name, width, frame) => {
    captures.push(await capture(name, width, frame));
  };

  const home = mockTui();
  const homeApp = new IntakeTui(tuiOptions(join(root, 'data'), { tui: home.tui }));
  await homeApp.start();
  await push('01-home-wide', 120, home.render(120));
  await push('02-home-compact', 60, home.render(60));
  await push('03-home-minimum', 31, home.render(31));
  homeApp.handleInput('/');
  await push('04-home-suggestions', 120, home.render(120));
  homeApp.handleInput('\u001b');
  homeApp.handleInput('?');
  await push('05-home-help', 120, home.render(120));

  const config = mockTui();
  const configApp = new IntakeTui(tuiOptions(join(root, 'data-config'), { tui: config.tui }));
  await configApp.start();
  enterCommand(configApp, '/config');
  await waitPage(configApp, 'config', () => config.render(120));
  assert.match(config.render(120), /Reprise model settings|Reprise 模型设置/);
  editField(configApp, 'provider type');
  await push('06-config-catalog', 120, config.render(120));
  configApp.handleInput('\r');
  await push('07-config-openai-empty', 120, config.render(120));
  editField(configApp, 'provider label');
  replaceField(configApp, 'private-gateway');
  editField(configApp, 'base URL');
  replaceField(configApp, 'not-a-url');
  editField(configApp, 'model');
  replaceField(configApp, 'model-private');
  editField(configApp, 'API key');
  replaceField(configApp, 'not-a-key');
  await push('08-config-invalid', 120, config.render(120));
  await push('08b-config-invalid-compact', 60, config.render(60));

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  await saveHarnessModelConfig(join(root, 'data-env'), {
    schemaVersion: 2,
    provider: { kind: 'openai-compatible', id: 'dzzzz-openai' },
    providerId: 'dzzzz-openai',
    modelId: 'gpt-5.6-terra',
    effort: 'medium',
    baseUrl: 'https://api.dzzzz.cf',
    keyRef: 'env:OPENAI_API_KEY',
  });
  const envHome = mockTui();
  const envApp = new IntakeTui(tuiOptions(join(root, 'data-env'), { tui: envHome.tui }));
  await envApp.start();
  await push('01b-home-env-unset', 120, envHome.render(120));
  enterCommand(envApp, '/config');
  await waitPage(envApp, 'config', () => envHome.render(120));
  await push('06b-config-status-env-unset', 120, envHome.render(120));
  editField(envApp, 'API key');
  await push('07b-config-editing-prefill', 120, envHome.render(120));
  envApp.handleInput('\u0015');
  await push('07c-config-editing-empty', 120, envHome.render(120));
  envApp.handleInput('e');
  await push('07d-config-editing-partial-keyref', 120, envHome.render(120));
  envApp.handleInput('nv:OPENAI_API_KEY');
  await push('07e-config-editing-valid-keyref', 120, envHome.render(120));
  envApp.handleInput('\u0015');
  envApp.handleInput('sk-abc-not-a-real-secret-value-xxxxx');
  envApp.handleInput('\r');
  await push('07f-config-editing-secret', 120, envHome.render(120));
  if (previousOpenAiKey !== undefined) process.env.OPENAI_API_KEY = previousOpenAiKey;

  const intake = mockTui();
  const intakeNow = '2026-08-11T00:10:00.000Z';
  const intakeRenderNow = '2026-08-15T00:10:00.000Z';
  const intakeApp = new IntakeTui(tuiOptions(join(root, 'data'), {
    tui: intake.tui, now: () => intakeNow, nowMs: () => Date.parse(intakeRenderNow),
  }));
  await intakeApp.start();
  enterCommand(intakeApp, '/intake');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'products', 'product list');
  await push('08c-products-wide', 120, intake.render(120));
  await push('08d-products-compact', 60, intake.render(60));
  intakeApp.handleInput('\u001b[B');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'projects', 'Claude project list');
  await push('08e-claude-projects-wide', 120, intake.render(120));
  intakeApp.handleInput('\r');
  await waitFor(() => /Review the product intake flow/.test(intake.render(120)), 'Claude session list');
  await push('08f-claude-sessions-wide', 120, intake.render(120));
  intakeApp.handleInput('\b');
  intakeApp.handleInput('\b');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'products', 'product list after Claude');
  intakeApp.handleInput('\u001b[A');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'projects', 'Codex project list');
  intakeApp.handleInput('\u001b[B');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'sessions', 'CJK session list');
  await push('09-sessions-wide', 120, intake.render(120));
  await push('10-sessions-compact', 60, intake.render(60));
  await push('11-sessions-cjk-selected', 120, intake.render(120));
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'inspection', 'CJK inspection');
  await push('11b-inspection-review', 120, intake.render(120));
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'home' && Boolean(intakeApp.taskCase), { describe: 'home after CJK freeze', timeoutMs: 30_000, frame: () => intake.render(120) });
  await push('12-home-after-cjk-freeze', 120, intake.render(120));
  enterCommand(intakeApp, '/intake');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'products', 'product list after freeze');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel !== 'products', 'intake after freeze');
  if (intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'sessions') intakeApp.handleInput('\u001b');
  await waitFor(() => intakeApp.page === 'sessions' && intakeApp.intakeLevel === 'projects', 'project list after freeze');
  intakeApp.handleInput('\u001b[A');
  intakeApp.handleInput('\r');
  await waitFor(() => /Fix the bug/.test(intake.render(120)), 'English session list');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'inspection', 'English inspection');
  intakeApp.handleInput('\r');
  await waitFor(() => intakeApp.page === 'home' && Boolean(intakeApp.taskCase), { describe: 'home after English freeze', timeoutMs: 30_000, frame: () => intake.render(120) });
  await push('13-home-after-freeze', 120, intake.render(120));
  await push('18-home-with-taskcase', 120, intake.render(120));

  const historyRoot = join(root, 'history-data');
  const casesRoot = join(historyRoot, 'cases', 'case-history');
  const experimentsRoot = join(historyRoot, 'experiments', 'exp-history');
  await mkdir(casesRoot, { recursive: true });
  await mkdir(join(experimentsRoot, 'runs', 'run-history'), { recursive: true });
  const taskCase = {
    schemaVersion: 1, caseId: 'case-history', source: { productId: 'codex', sessionId: 'session-history' },
    initialInput: { id: 'input-history', role: 'user', text: 'Inspect a focused regression.' },
    transcript: [{ id: 'input-history', role: 'user', text: 'Inspect a focused regression.' }],
    historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    provenance: { packVersion: '1', importedAt: '2026-08-11T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64),
  };
  await writeFile(join(casesRoot, 'case.json'), JSON.stringify(taskCase));
  await writeFile(join(casesRoot, 'case.complete'), '');
  await writeFile(join(experimentsRoot, 'experiment.json'), JSON.stringify({ spec: {
    experimentId: 'exp-history', taskCaseId: 'case-history',
    candidates: [{ candidateId: 'codex-history', productId: 'codex', requestedModel: 'gpt-history' }],
    recovery: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 },
    outputRoot: experimentsRoot,
  }, runIds: ['run-history'] }));
  await writeFile(join(experimentsRoot, 'runs', 'run-history', 'record.json'), JSON.stringify({
    schemaVersion: 1,
    attempt: { schemaVersion: 1, runId: 'run-history', experimentId: 'exp-history', caseId: 'case-history', candidate: { candidateId: 'codex-history', productId: 'codex', requestedModel: 'gpt-history' }, policy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, createdAt: '2026-08-11T01:00:00.000Z' },
    outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
  }));
  const history = mockTui();
  const historyApp = new IntakeTui(tuiOptions(historyRoot, { tui: history.tui }));
  await historyApp.start();
  enterCommand(historyApp, '/history');
  await waitFor(() => historyApp.page === 'history' && historyApp.historyExperiments.length === 1);
  await push('15-history-runs', 120, history.render(120));
  historyApp.handleInput('\t');
  await push('16-history-cases', 120, history.render(120));
  historyApp.handleInput('\r');
  await push('17-history-detail', 120, history.render(120));

  const { workflow: scripted, handles } = createScriptedSyntheticWorkflow({
    longMessageLines: 40,
    commandListingLines: 24,
    commandCwd: String.raw`C:\reprise`,
    multiLineLive: false,
    includeOutcomeEvent: false,
    includeUserViewPersisted: true,
    recoveryExperimentRoot: join(root, 'data-run', 'experiments', 'audit-recovery'),
    workflowCandidate: { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' },
    policy: { wallClockMs: 30 * 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10 * 60_000, maxConsecutiveNoProgress: 1 },
    preflightExtras: {
      comparisonClass: 'observational',
      limitations: ['fingerprint differs'],
      workspace: { fileCount: 111, totalBytes: Math.round(66.4 * 1024 * 1024), largestFileBytes: 1024, blockedReasons: [] },
    },
    comparison: { status: 'completed' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
  });
  const {
    releasePreflight,
    releaseRecovery,
    releaseCopy,
    releaseStart,
    resolveResult,
    copyLatched,
    startLatched,
  } = handles;
  const workflow = {
    ...scripted,
    listCatalog: async () => [{ value: 'gpt-5.6-luna', displayName: 'gpt-5.6-luna', resolvedModel: 'gpt-5.6-luna' }],
    inspectAvailability: async (productId) => [{ productId, status: 'available', observedAt: '2026-08-11T00:10:00.000Z' }],
    verifyCandidate: async (candidate) => ({
      productId: candidate.productId, executable: 'fixture', requestedModel: candidate.requestedModel, resolvedModel: candidate.requestedModel,
    }),
  };
  const run = mockTui(32);
  await saveHarnessModelConfig(join(root, 'data-run'), defaultHarnessModelConfig());
  const runApp = new IntakeTui(tuiOptions(join(root, 'data-run'), {
    tui: run.tui, workflow, now: () => '2026-08-11T00:10:00.000Z',
  }));
  await runApp.start();
  runApp.harnessAuthOk = true;
  enterCommand(runApp, '/intake');
  await waitFor(() => runApp.page === 'sessions' && runApp.intakeLevel === 'products', 'run product list');
  runApp.handleInput('\r');
  await waitFor(() => runApp.page === 'sessions' && runApp.intakeLevel === 'projects', 'run project list');
  runApp.handleInput('\r');
  await waitFor(() => /Fix the bug/.test(run.render(120)), 'run session list');
  runApp.handleInput('\r');
  await waitFor(() => runApp.page === 'inspection', 'run inspection');
  runApp.handleInput('\r');
  await waitFor(() => {
    return runApp.page === 'running' && runApp.preparePhase === 'check';
  }, { describe: 'auto recovery after freeze with selected product', timeoutMs: 30_000, frame: () => run.render(120) });
  await push('19-running-check', 120, run.render(120));
  await push('19b-running-check-compact', 60, run.render(60));
  releasePreflight();
  await waitFor(() => runApp.runPhase === 'recovery' && Boolean(runApp.recoveryAbort), 'automatic environment preparation after preflight');
  await push('20-running-copy', 120, run.render(120));
  releaseRecovery();
  await waitFor(() => runApp.page === 'candidate-product', { describe: 'candidate product after recovery', frame: () => run.render(120) });
  await waitFor(() => runApp.candidateAvailability.codex === 'available', {
    describe: 'candidate availability settled',
    timeoutMs: 15_000,
    frame: () => run.render(120),
  });
  await push('29-candidate-product', 120, run.render(120));
  await push('29b-candidate-product-narrow', 60, run.render(60));
  assert.match(run.render(120), /Which tool should redo|用哪个工具重做/);
  runApp.handleInput('\u001b');
  assert.equal(runApp.page, 'recovery-review');
  await push('29c-prepared-files-review', 120, run.render(120));
  runApp.handleInput('\r');
  assert.equal(runApp.page, 'candidate-product');
  runApp.handleInput('\r');
  await waitFor(() => runApp.page === 'candidate-model' && runApp.candidateCatalogStatus === 'ready', { describe: 'candidate model after product', frame: () => run.render(120) });
  await push('30-candidate-model', 120, run.render(120));
  await push('30b-candidate-model-narrow', 60, run.render(60));
  runApp.handleInput('\r');
  await waitFor(() => runApp.page === 'confirm' && runApp.confirmStartArmed, {
    describe: 'confirm page after model selection',
    frame: () => run.render(120),
  });
  await push('31-confirm-run', 120, run.render(120));
  await push('31b-confirm-run-narrow', 60, run.render(60));
  assert.match(run.render(120), /开始执行|Start execution/);
  runApp.handleInput('\r');
  await waitFor(() => runApp.page === 'running' && runApp.preparePhase === 'copy', 'candidate preparation after confirm');
  await push('21-running-start', 120, run.render(120));
  await waitFor(() => copyLatched(), { describe: 'candidate copy handle', timeoutMs: 30_000 });
  releaseCopy();
  await waitFor(() => startLatched(), { describe: 'candidate start handle', timeoutMs: 30_000 });
  releaseStart();
  await waitFor(() => runApp.page === 'running' && Boolean(runApp.activeExperiment), 'candidate replay after preparation');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await push('22-running-wide', 120, run.render(120));
  runApp.handleInput('\u001b[A');
  await waitFor(() => /Visible response|public response/.test(run.render(120)));
  await push('22b-running-command-detail', 120, run.render(120));
  await push('22c-running-command-compact', 60, run.render(60));
  runApp.handleInput('l');
  await push('23-running-compact', 60, run.render(60));
  runApp.handleInput('d');
  await push('24-running-compact-detail', 60, run.render(60));
  runApp.handleInput('f');
  await push('25-running-filter-target', 120, run.render(120));
  runApp.handleInput('s');
  resolveResult(syntheticExperimentResult({
    experimentRoot: join(root, 'data', 'experiments', 'fixture'),
    runId: 'run-1',
    comparison: { status: 'completed' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
  }));
  await waitFor(() => runApp.page === 'result');
  await push('26-result', 120, run.render(120));
  await push('26b-result-compact', 60, run.render(60));

  const review = mockTui({ rows: 24, columns: 80 });
  const reviewApp = new IntakeTui(tuiOptions(join(root, 'data-review'), { tui: review.tui }));
  reviewApp.locale = 'zh';
  reviewApp.page = 'result';
  reviewApp.message = '';
  reviewApp.taskCase = taskCase;
  reviewApp.result = syntheticExperimentResult({
    experimentRoot: join(root, 'data', 'experiments', 'fixture'), runId: 'run-1',
    comparison: { status: 'skipped' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'incomplete' },
  });
  reviewApp.result.record.attempt.candidate = { candidateId: 'audit-codex', productId: 'codex', requestedModel: 'gpt-test' };
  reviewApp.selectedCandidate = reviewApp.result.record.attempt.candidate;
  reviewApp.candidateProductId = 'codex';
  let comparisonChoice;
  reviewApp.compareChoice = { resolve: (value) => { comparisonChoice = value; } };
  await push('32-result-review-80x24', 80, reviewApp.preview(80));
  reviewApp.handleInput('c');
  assert.equal(reviewApp.page, 'compare-confirm');
  assert.equal(comparisonChoice, undefined);
  assert.match(reviewApp.preview(80), /可能产生费用/);
  await push('33-compare-confirm-80x24', 80, reviewApp.preview(80));
  reviewApp.handleInput('\u001b');
  assert.equal(reviewApp.page, 'result');
  assert.equal(comparisonChoice, undefined);
  await reviewApp.setLocale('en');
  reviewApp.handleInput('c');
  await push('33b-compare-confirm-en-80x24', 80, reviewApp.preview(80));
  reviewApp.handleInput('\u001b');

  const err = mockTui();
  const sessionsFile = join(root, 'sessions-file');
  await writeFile(sessionsFile, 'not a directory');
  const errApp = new IntakeTui(tuiOptions(join(root, 'data-err'), {
    tui: err.tui, sessionsRoot: sessionsFile, sessionsRoots: { codex: sessionsFile, 'claude-code': claudeSessionsRoot },
  }));
  await errApp.start();
  enterCommand(errApp, '/intake');
  await waitFor(() => errApp.page === 'sessions' && errApp.intakeLevel === 'products');
  errApp.handleInput('\r');
  await waitFor(() => /ENOTDIR|not a directory|Error/i.test(err.render(120)));
  await push('27-product-discovery-error', 120, err.render(120));

  const clipped = mockTui(24);
  const clippedApp = new IntakeTui(tuiOptions(join(root, 'data'), {
    tui: clipped.tui, workflow, now: () => '2026-08-11T00:10:00.000Z',
  }));
  await clippedApp.start();
  await push('28-home-height-24', 120, clipped.render(120));
  await clippedApp.setLocale('zh');
  await push('28b-home-zh-80x24', 80, clipped.render(80));

  const index = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Reprise TUI audit</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#0b1220;color:#e5e7eb;padding:24px} a{color:#93c5fd} li{margin:6px 0}</style>
</head><body>
<h1>Reprise TUI visual audit</h1>
<ol>
${captures.map((item) => `<li><a href="html/${item.name}.html">${item.name}</a> · ${item.width} cols · ${item.rows} rows${item.issues.length ? ' · ' + item.issues.join('; ') : ''}</li>`).join('\n')}
</ol>
</body></html>`;
  if (!checkMode) {
    await writeFile(join(outDir, 'index.html'), toLf(index), 'utf8');
    await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify({ captures, index: pathToFileURL(join(outDir, 'index.html')).href }, null, 2)}\n`);
  }
  console.log(`wrote ${captures.length} frames to ${framesDir}`);
  for (const item of captures) {
    if (item.issues.length) console.log(`issue ${item.name}: ${item.issues.join('; ')}`);
  }
  if (checkMode) {
    await selfTestCompareFrames();
    if (shouldCompareAuditFrames()) {
      try {
        await compareFrames(framesDir, baselineDir);
      } catch (error) {
        await dumpGeneratedFrames(framesDir, framesGeneratedDir);
        throw error;
      }
    } else {
      console.log('audit:tui:check: generated frames; skip Windows baseline byte-compare on this host');
    }
  }
  await rm(root, { recursive: true, force: true });
  if (checkMode) await rm(generatedRoot, { recursive: true, force: true });
}

await main();
