import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CodexIntakeTui } from '../dist/src/tui/intake-app.js';
import { createCodexTuiWorkflow } from '../dist/src/application/tui-workflow.js';
import { CodexRuntimePort } from '../dist/src/products/codex/runtime-port.js';

Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
process.env.TERM = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
delete process.env.NO_COLOR;

const CASE_ID = process.env.REPRISE_CASE_ID ?? 'case-4efe900555f98a46';
const CYCLE = process.env.REPRISE_CYCLE ?? '1';
const LOOP_NAME = process.env.REPRISE_LOOP ?? `cycle-${CYCLE}`;
const dataDir = resolve(process.cwd(), '.reprise');
const sessionsRoot = join(homedir(), '.codex', 'sessions');
const outDir = join(process.cwd(), 'docs', 'tui-loop', LOOP_NAME);
const framesDir = join(outDir, 'frames');
const htmlDir = join(outDir, 'html');
const shotDir = join(outDir, 'screenshots');
const RUN_TIMEOUT_MS = 28 * 60_000;
const execFileAsync = promisify(execFile);

function mockTui(terminal) {
  let document;
  const tui = {
    terminal,
    addChild(component) { document = component; },
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  };
  return { tui, render(width = 120) { return document?.render(width).join('\n') ?? ''; } };
}

function enterCommand(app, command) {
  app.handleInput(command);
  app.handleInput('\r');
}

async function waitFor(condition, ms = 120_000, frame = () => '') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`TUI did not reach the expected state.\n${frame().slice(0, 1500)}`);
}

function ansiToHtml(text) {
  const withLinks = text.replace(/\u001b\]8;;([^\u001b]*)\u001b\\([\s\S]*?)\u001b\]8;;\u001b\\/g, (_, url, body) => {
    const href = String(url).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return `\x00A${href}\x00B${body}\x00C`;
  });
  const escaped = withLinks.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const colors = {
    '1': 'font-weight:700', '2': 'opacity:.65', '31': 'color:#f87171', '32': 'color:#4ade80',
    '33': 'color:#facc15', '34': 'color:#60a5fa', '35': 'color:#e879f9', '36': 'color:#22d3ee',
    '36;1': 'color:#22d3ee;font-weight:700',
  };
  return escaped.replace(/\u001b\[([0-9;]+)m([\s\S]*?)\u001b\[0m/g, (_, code, body) => {
    const style = colors[code] ?? '';
    return style ? `<span style="${style}">${body}</span>` : body;
  }).replace(/\u001b\[[0-9;]*m/g, '').replace(/\x00A([^\x00]*)\x00B([\s\S]*?)\x00C/g, (_, href, body) => (
    `<a href="${href}" style="color:#67e8f9;text-decoration:underline">${body}</a>`
  ));
}

function pageHtml(title, width, frame) {
  const lines = frame.split('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;background:#0b1220;color:#e5e7eb}.wrap{padding:16px 20px 24px}h1{font:600 14px/1.4 ui-sans-serif,system-ui;color:#93c5fd;margin:0 0 12px}pre{margin:0;padding:12px 14px;background:#111827;border:1px solid #1f2937;border-radius:8px;font:13px/1.35 Consolas,monospace;white-space:pre;overflow:auto;min-width:${Math.max(40, width)}ch}</style>
</head><body><div class="wrap"><h1>${title} · ${width} cols · ${lines.length} rows</h1><pre>${ansiToHtml(frame)}</pre></div></body></html>`;
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function commandRowSelected(frame) {
  return /[❯›>].*Command (?:completed|failed)/.test(stripAnsi(frame));
}

function selectCommandRow(app, render) {
  for (let index = 0; index < 24; index += 1) {
    if (commandRowSelected(render())) return true;
    app.handleInput('\u001b[A');
  }
  return commandRowSelected(render());
}

function classify(frame) {
  if (/Cannot continue|no usable credential|Experiment did not start/.test(frame)) return 'error';
  if (/Run result /.test(frame) || /Experiment finished/.test(frame)) return 'result';
  if (/Timeline /.test(frame) || /Cancellation requested/.test(frame)) return 'running';
  if (/Current workspace/.test(frame)) return 'home';
  if (/TaskCases /.test(frame) || /Recent experiments/.test(frame)) return 'history';
  return 'other';
}

async function listExperiments() {
  const root = join(dataDir, 'experiments');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function newestExperiment(previous) {
  const names = await listExperiments();
  const created = names.filter((name) => !previous.has(name));
  if (created.length === 1) return created[0];
  return created.at(-1) ?? names.sort().at(-1);
}

async function main() {
  await mkdir(framesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  await mkdir(shotDir, { recursive: true });
  const previousExperiments = new Set(await listExperiments());
  const host = mockTui({ columns: 120, rows: 32 });
  const app = new CodexIntakeTui({
    dataDir, sessionsRoot, tui: host.tui,
    workflow: createCodexTuiWorkflow({ dataDir, runtime: new CodexRuntimePort({ effort: 'high' }), now: () => new Date().toISOString() }),
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  await app.start();

  const captures = [];
  const notes = [];
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    notes.push(line);
    console.log(line);
  };
  const push = async (name, width, frame) => {
    await writeFile(join(framesDir, `${name}.txt`), frame, 'utf8');
    await writeFile(join(htmlDir, `${name}.html`), pageHtml(name, width, frame), 'utf8');
    captures.push({ name, width, rows: frame.split('\n').length, at: new Date().toISOString(), class: classify(frame) });
    log(`captured ${name} ${width}x${frame.split('\n').length} ${classify(frame)}`);
  };

  const frame = () => host.render(120);
  await push('01-home', 120, frame());
  enterCommand(app, '/history');
  await waitFor(() => /Recent experiments ·/.test(frame()), 180_000, frame);
  await push('02-history-runs', 120, frame());
  app.handleInput('\t');
  await waitFor(() => /TaskCases ·/.test(frame()), 30_000, frame);
  await push('03-history-cases', 120, frame());
  for (let index = 0; index < 12 && !new RegExp(`\\b${CASE_ID}\\b`).test(frame()); index += 1) app.handleInput('\u001b[B');
  if (!new RegExp(`\\b${CASE_ID}\\b`).test(frame())) throw new Error(`TaskCase ${CASE_ID} was not visible in history.\n${frame()}`);
  await push('04-history-case-selected', 120, frame());
  app.handleInput('\r');
  await waitFor(() => /TaskCase:/.test(frame()) && frame().includes(CASE_ID), 30_000, frame);
  await push('05-history-detail', 120, frame());
  app.handleInput('\r');
  await waitFor(() => new RegExp(`${CASE_ID} is current`).test(frame()), 30_000, frame);
  await push('06-home-with-case', 120, frame());

  enterCommand(app, '/run');
  log('starting isolated run');
  await waitFor(() => /Timeline |Enter the absolute source|no usable credential|Experiment did not start|Cannot continue|Codex was not started/.test(frame()), 180_000, frame);
  await push('07-after-run', 120, frame());
  if (/Enter the absolute source/.test(frame())) {
    throw new Error('Historical cwd is missing; refusing to invent a source root.');
  }

  const blocked = /Codex was not started|Cannot continue|no usable credential/.test(frame());
  if (blocked) {
    log('run blocked before Codex started');
    await push('20-blocked', 120, frame());
  } else {
  const runStarted = Date.now();
  let runningSamples = 0;
  let lastSignature = '';
  let commandDetailCaptures = 0;
  let compareCaptured = false;
  const seenCommandTitles = new Set();
  while (Date.now() - runStarted < RUN_TIMEOUT_MS) {
    const frame = host.render(120);
    const kind = classify(frame);
    const signature = `${kind}:${frame.replace(/\d{2}:\d{2}/g, 'mm:ss').slice(0, 1600)}`;
    if (kind === 'running' && signature !== lastSignature && runningSamples < 48) {
      lastSignature = signature;
      runningSamples += 1;
      await push(`10-running-${String(runningSamples).padStart(2, '0')}`, 120, frame);
      if (runningSamples === 1 || runningSamples % 6 === 0) {
        await push(`10-running-${String(runningSamples).padStart(2, '0')}-compact`, 60, host.render(60));
      }
    }
    if (kind === 'running' && !compareCaptured && /\bcompare\b/i.test(stripAnsi(frame))) {
      compareCaptured = true;
      await push('12-running-compare', 120, frame);
      await push('12-running-compare-compact', 60, host.render(60));
    }
    if (kind === 'running' && commandDetailCaptures < 4) {
      const commandTitle = /Command (?:completed|failed)[^\n]*/.exec(stripAnsi(frame))?.[0]?.trim();
      if (commandTitle && !seenCommandTitles.has(commandTitle)) {
        seenCommandTitles.add(commandTitle);
        const selected = selectCommandRow(app, () => host.render(120));
        commandDetailCaptures += 1;
        const prefix = `11-command-detail-${String(commandDetailCaptures).padStart(2, '0')}`;
        await push(prefix, 120, host.render(120));
        await push(`${prefix}-compact`, 60, host.render(60));
        app.handleInput('d');
        await push(`${prefix}-compact-open`, 60, host.render(60));
        app.handleInput('d');
        if (!selected) log(`command detail ${commandDetailCaptures} was not on a Command row`);
        app.handleInput('l');
      }
    }
    if (kind === 'result') {
      log(`experiment finished after ${Math.round((Date.now() - runStarted) / 1000)}s`);
      await push('20-result', 120, frame);
      await push('20b-result-compact', 60, host.render(60));
      break;
    }
    if (kind === 'error') {
      log('TUI entered an error state before Codex started');
      await push('20-error', 120, frame);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  }

  const experimentId = await newestExperiment(previousExperiments);
  const artifacts = await copyExperimentArtifacts(dataDir, experimentId, join(outDir, 'experiment'));
  const summary = {
    cycle: CYCLE,
    loop: LOOP_NAME,
    caseId: CASE_ID,
    experimentId,
    artifacts,
    captures,
    notes,
    lastFrameClass: captures.at(-1)?.class,
  };
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(outDir, 'notes.txt'), `${notes.join('\n')}\nlast=${captures.at(-1)?.class ?? 'none'} experiment=${experimentId ?? 'unknown'}\n`);
  const screenshots = await captureScreenshots(captures, log);
  await writeFile(join(outDir, 'index.html'), indexHtml(LOOP_NAME, captures), 'utf8');
  console.log(`wrote ${captures.length} frames and ${screenshots} screenshots to ${outDir}`);
}

async function copyExperimentArtifacts(dataDir, experimentId, dest) {
  if (!experimentId) return undefined;
  const root = join(dataDir, 'experiments', experimentId);
  await mkdir(dest, { recursive: true });
  const copied = [];
  for (const name of ['experiment.json', 'comparison.md', 'report.md']) {
    try {
      await copyFile(join(root, name), join(dest, name));
      copied.push(name);
    } catch {
      /* optional */
    }
  }
  const runsDir = join(root, 'runs');
  const runs = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runId = runs.find((entry) => entry.isDirectory())?.name;
  if (runId) {
    const runRoot = join(runsDir, runId);
    await mkdir(join(dest, 'run'), { recursive: true });
    for (const name of ['record.json', 'events.jsonl', 'outcome.json']) {
      try {
        await copyFile(join(runRoot, name), join(dest, 'run', name));
        copied.push(`run/${name}`);
      } catch {
        /* optional */
      }
    }
  }
  try {
    const record = JSON.parse(await readFile(join(dest, 'run', 'record.json'), 'utf8'));
    copied.push(`termination=${record?.outcome?.termination?.kind}/${record?.outcome?.termination?.code}`);
  } catch {
    /* optional */
  }
  return { experimentId, copied };
}

function indexHtml(loop, captures) {
  const items = captures.map((item) => {
    const shot = `screenshots/${item.name}.png`;
    return `<li><a href="html/${item.name}.html">${item.name}</a> · ${item.class} · ${item.width}x${item.rows}<br><a href="${shot}"><img src="${shot}" alt="${item.name}" width="${item.width >= 100 ? 920 : 480}"></a></li>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>TUI loop ${loop}</title>
<style>body{margin:24px;background:#0b1220;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui}a{color:#93c5fd}img{margin:8px 0 16px;border:1px solid #1f2937;border-radius:8px;background:#111827}</style>
</head><body><h1>TUI loop ${loop}</h1><ol>${items}</ol></body></html>`;
}

function chromePath() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ].find((path) => existsSync(path));
}

async function captureScreenshots(captures, log) {
  const chrome = chromePath();
  if (!chrome) {
    log('chrome not found; skipping PNG screenshots');
    return 0;
  }
  let count = 0;
  for (const item of captures) {
    const html = join(htmlDir, `${item.name}.html`);
    const png = join(shotDir, `${item.name}.png`);
    const width = item.width >= 100 ? 1480 : 820;
    const height = Math.min(2200, 160 + item.rows * 22);
    try {
      await execFileAsync(chrome, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        `--window-size=${width},${height}`, `--screenshot=${png}`, pathToFileURL(html).href,
      ], { timeout: 20_000 });
      count += 1;
    } catch (error) {
      log(`screenshot failed for ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`captured ${count} PNG screenshots`);
  return count;
}

await main();
