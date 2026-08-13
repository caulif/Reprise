import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexIntakeTui } from '../dist/src/tui/codex-intake.js';
import { defaultHarnessModelConfig, saveHarnessModelConfig } from '../dist/src/infrastructure/harness-model-config.js';

Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
process.env.TERM = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
delete process.env.NO_COLOR;

const outDir = join(process.cwd(), 'docs', 'tui-audit');
const framesDir = join(outDir, 'frames');
const htmlDir = join(outDir, 'html');

function mockTui(rows) {
  let document;
  const tui = {
    terminal: rows ? { rows, columns: 120 } : undefined,
    addChild(component) { document = component; },
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  };
  return {
    tui: tui,
    render(width = 120) { return document?.render(width).join('\n') ?? ''; },
  };
}

function enterCommand(app, command) {
  app.handleInput(command);
  app.handleInput('\r');
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('TUI did not reach the expected state.');
}

function ansiToHtml(text) {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const colors = {
    '1': 'font-weight:700',
    '2': 'opacity:.65',
    '31': 'color:#f87171',
    '32': 'color:#4ade80',
    '33': 'color:#facc15',
    '34': 'color:#60a5fa',
    '35': 'color:#e879f9',
    '36': 'color:#22d3ee',
    '36;1': 'color:#22d3ee;font-weight:700',
  };
  return escaped.replace(/\u001b\[([0-9;]+)m([\s\S]*?)\u001b\[0m/g, (_, code, body) => {
    const style = colors[code] ?? '';
    return style ? `<span style="${style}">${body}</span>` : body;
  }).replace(/\u001b\[[0-9;]*m/g, '');
}

function pageHtml(title, width, frame) {
  const lines = frame.split('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; background: #0b1220; color: #e5e7eb; }
  .wrap { padding: 16px 20px 24px; }
  h1 { font: 600 14px/1.4 ui-sans-serif, system-ui; color: #93c5fd; margin: 0 0 12px; }
  pre {
    margin: 0; padding: 12px 14px; background: #111827; border: 1px solid #1f2937;
    border-radius: 8px; font: 13px/1.35 "Cascadia Mono", "Sarasa Mono SC", Consolas, monospace;
    white-space: pre; overflow: auto; min-width: ${Math.max(40, width)}ch;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${title} · ${width} cols · ${lines.length} rows</h1>
    <pre>${ansiToHtml(frame)}</pre>
  </div>
</body>
</html>`;
}

async function capture(name, width, frame) {
  await writeFile(join(framesDir, `${name}.txt`), frame, 'utf8');
  await writeFile(join(htmlDir, `${name}.html`), pageHtml(name, width, frame), 'utf8');
  const issues = [];
  const lines = frame.split('\n');
  if (width >= 78) {
    const tops = lines.filter((line) => line.includes('┌'));
    const bottoms = lines.filter((line) => line.includes('└'));
    if (tops.length && bottoms.length && tops[0] && bottoms[0]) {
      // length is UTF-16; visual check is still useful for ASCII titles
    }
  }
  if (width < 78 && width >= 32 && /[┌┐└┘│─❯●✓…]/.test(frame)) {
    issues.push('compact frame still contains wide glyphs');
  }
  return { name, width, rows: lines.length, issues };
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-audit-'));
  const sessionsRoot = join(root, 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
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

  const captures = [];
  const push = async (name, width, frame) => {
    captures.push(await capture(name, width, frame));
  };

  const home = mockTui();
  const homeApp = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot, tui: home.tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
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
  const configApp = new CodexIntakeTui({
    dataDir: join(root, 'data-config'), sessionsRoot, tui: config.tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await configApp.start();
  enterCommand(configApp, '/config');
  await waitFor(() => /Harness API/.test(config.render(120)));
  await push('06-config-catalog', 120, config.render(120));
  configApp.handleInput('\r');
  await push('07-config-openai-empty', 120, config.render(120));
  configApp.handleInput('\u001b[B');
  configApp.handleInput('\r');
  configApp.handleInput('private-gateway');
  configApp.handleInput('\r');
  configApp.handleInput('\u001b[B');
  configApp.handleInput('\r');
  configApp.handleInput('http://insecure.example/v1');
  configApp.handleInput('\r');
  configApp.handleInput('\u001b[B');
  configApp.handleInput('\r');
  configApp.handleInput('model-private');
  configApp.handleInput('\r');
  configApp.handleInput('\u001b[B');
  configApp.handleInput('\u001b[B');
  configApp.handleInput('\r');
  configApp.handleInput('not-a-key');
  configApp.handleInput('\r');
  await push('08-config-invalid', 120, config.render(120));
  await push('08b-config-invalid-compact', 60, config.render(60));

  const intake = mockTui();
  const intakeApp = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot, tui: intake.tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => '2026-08-11T00:10:00.000Z',
  });
  await intakeApp.start();
  enterCommand(intakeApp, '/intake');
  await waitFor(() => /Fix the bug/.test(intake.render(120)));
  await push('09-sessions-wide', 120, intake.render(120));
  await push('10-sessions-compact', 60, intake.render(60));
  intakeApp.handleInput('\u001b[B');
  await push('11-sessions-cjk-selected', 120, intake.render(120));
  intakeApp.handleInput('\r');
  await waitFor(() => /Review the session details/.test(intake.render(120)));
  await push('12-inspection-cjk', 120, intake.render(120));
  intakeApp.handleInput('\u001b');
  enterCommand(intakeApp, '/intake');
  await waitFor(() => /Fix the bug/.test(intake.render(120)));
  intakeApp.handleInput('\r');
  await waitFor(() => /Review the session details/.test(intake.render(120)));
  await push('13-inspection', 120, intake.render(120));
  intakeApp.handleInput('\u001b[B');
  await push('14-inspection-task-2', 120, intake.render(120));

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
    outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
  }));
  const history = mockTui();
  const historyApp = new CodexIntakeTui({
    dataDir: historyRoot, sessionsRoot, tui: history.tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await historyApp.start();
  enterCommand(historyApp, '/history');
  await waitFor(() => /Recent experiments/.test(history.render(120)));
  await push('15-history-runs', 120, history.render(120));
  historyApp.handleInput('\t');
  await push('16-history-cases', 120, history.render(120));
  historyApp.handleInput('\r');
  await push('17-history-detail', 120, history.render(120));

  const fullPublicResponse = `${Array.from({ length: 40 }, (_, index) => `public response line ${index + 1}`).join('\n')}\nPUBLIC_DETAIL_END`;
  let releaseStart;
  let resolveResult;
  const workflow = {
    candidate: { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' },
    policy: { wallClockMs: 30 * 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10 * 60_000, maxConsecutiveNoProgress: 1 },
    preflight: async () => ({
      sourceBaseline: 'partial',
      resolved: { productId: 'codex', executable: 'fixture', requestedModel: 'gpt-5.6-luna', resolvedModel: 'gpt-5.6-luna' },
      comparisonClass: 'observational',
      limitations: ['fingerprint differs'],
    }),
    start: async (input) => {
      input.onEvent({ schemaVersion: 1, sequence: 1, eventId: 'event-1', occurredAt: '2026-08-11T00:10:00.000Z', type: 'run.state_changed', payload: { to: 'launching' }, checksum: 'a'.repeat(64) });
      input.onEvent({ schemaVersion: 1, sequence: 2, eventId: 'event-2', occurredAt: '2026-08-11T00:10:01.000Z', type: 'controller.decision', payload: { status: 'completed', sessionId: 'controller-1', value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' } }, checksum: 'b'.repeat(64) });
      input.onEvent({ schemaVersion: 1, sequence: 3, eventId: 'event-3', occurredAt: '2026-08-11T00:10:02.000Z', type: 'codex.item_completed', payload: { item: { type: 'agentMessage', text: fullPublicResponse } }, checksum: 'c'.repeat(64) });
      input.onEvent({ schemaVersion: 1, sequence: 4, eventId: 'event-4', occurredAt: '2026-08-11T00:10:05.000Z', type: 'codex.codex.stderr', payload: { line: 'runtime warning from target' }, checksum: 'd'.repeat(64) });
      await new Promise((resolve) => { releaseStart = resolve; });
      return { cancel: async () => {}, result: new Promise((resolve) => { resolveResult = resolve; }) };
    },
  };
  const run = mockTui();
  const runApp = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot, tui: run.tui, workflow,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => '2026-08-11T00:10:00.000Z',
  });
  await runApp.start();
  enterCommand(runApp, '/intake');
  await waitFor(() => /Fix the bug/.test(run.render(120)));
  runApp.handleInput('\r');
  await waitFor(() => /Review the session details/.test(run.render(120)));
  runApp.handleInput('\r');
  await waitFor(() => /is current/.test(run.render(120)));
  await push('18-home-with-taskcase', 120, run.render(120));
  enterCommand(runApp, '/run');
  await push('19-source', 120, run.render(120));
  await push('19b-source-compact', 60, run.render(60));
  for (let index = 0; index < 'C:/source'.length; index += 1) runApp.handleInput('\b');
  runApp.handleInput('C:\\explicit-source');
  runApp.handleInput('\r');
  await waitFor(() => /Candidate preflight/.test(run.render(120)));
  await push('20-preflight', 120, run.render(120));
  runApp.handleInput('\r');
  await waitFor(() => /Start isolated Codex Candidate/.test(run.render(120)));
  await push('21-confirm', 120, run.render(120));
  runApp.handleInput('\r');
  await waitFor(() => /Validating the configured provider/.test(run.render(120)));
  releaseStart?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await push('22-running-wide', 120, run.render(120));
  await push('23-running-compact', 60, run.render(60));
  runApp.handleInput('d');
  await push('24-running-compact-detail', 60, run.render(60));
  runApp.handleInput('f');
  await push('25-running-filter-target', 120, run.render(120));
  resolveResult?.({
    reportPath: join(root, 'data', 'experiments', 'fixture', 'report.html'),
    experimentRoot: join(root, 'data', 'experiments', 'fixture'),
    preflight: {
      sourceBaseline: 'partial',
      resolved: { productId: 'codex', executable: 'fixture', requestedModel: 'gpt-5.6-luna', resolvedModel: 'gpt-5.6-luna' },
      comparisonClass: 'observational',
      limitations: ['fingerprint differs'],
    },
    record: { attempt: { runId: 'run-1' }, outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } } },
    decision: { status: 'completed', value: { type: 'done' }, usedFallback: false },
    comparison: { result: { status: 'completed', usedFallback: false } },
  });
  await waitFor(() => /Experiment finished/.test(run.render(120)));
  await push('26-result', 120, run.render(120));
  await push('26b-result-compact', 60, run.render(60));

  const err = mockTui();
  const sessionsFile = join(root, 'sessions-file');
  await writeFile(sessionsFile, 'not a directory');
  const errApp = new CodexIntakeTui({
    dataDir: join(root, 'data-err'), sessionsRoot: sessionsFile, tui: err.tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await errApp.start();
  enterCommand(errApp, '/intake');
  await waitFor(() => /ENOTDIR|not a directory|Error/i.test(err.render(120)));
  await push('27-error', 120, err.render(120));

  const clipped = mockTui(24);
  const clippedApp = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot, tui: clipped.tui, workflow,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => '2026-08-11T00:10:00.000Z',
  });
  await clippedApp.start();
  await push('28-home-height-24', 120, clipped.render(120));

  const index = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Reprise TUI audit</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#0b1220;color:#e5e7eb;padding:24px} a{color:#93c5fd} li{margin:6px 0}</style>
</head><body>
<h1>Reprise TUI visual audit</h1>
<ol>
${captures.map((item) => `<li><a href="html/${item.name}.html">${item.name}</a> · ${item.width} cols · ${item.rows} rows${item.issues.length ? ' · ' + item.issues.join('; ') : ''}</li>`).join('\n')}
</ol>
</body></html>`;
  await writeFile(join(outDir, 'index.html'), index, 'utf8');
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ captures, index: pathToFileURL(join(outDir, 'index.html')).href }, null, 2));
  console.log(`wrote ${captures.length} frames to ${outDir}`);
  for (const item of captures) {
    if (item.issues.length) console.log(`issue ${item.name}: ${item.issues.join('; ')}`);
  }
  await rm(root, { recursive: true, force: true });
}

await main();
