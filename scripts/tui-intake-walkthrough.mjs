import { cp, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexIntakeTui } from '../dist/src/tui/codex-intake.js';
import { createCodexTuiWorkflow } from '../dist/src/application/codex-tui-workflow.js';
import { CodexRuntimePort } from '../dist/src/products/codex/runtime-port.js';

Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
process.env.TERM = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
delete process.env.NO_COLOR;

const TARGET = '019ff9fd-62c5-76b3-ba67-beed462fe746';
const outDir = join(process.cwd(), 'docs', 'tui-intake-review');
const framesDir = join(outDir, 'frames');
const htmlDir = join(outDir, 'html');
const sessionsRoot = join(homedir(), '.codex', 'sessions');

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
  return {
    tui,
    render(width = 120) { return document?.render(width).join('\n') ?? ''; },
  };
}

function enterCommand(app, command) {
  app.handleInput(command);
  app.handleInput('\r');
}

async function waitFor(condition, ms = 120_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
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

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-intake-walk-'));
  try {
    await cp(join(process.cwd(), '.reprise'), dataDir, { recursive: true, force: true });
  } catch {
    /* walkthrough still works without a saved harness config */
  }

  const terminal = { columns: 120, rows: undefined };
  const host = mockTui(terminal);
  const app = new CodexIntakeTui({
    dataDir,
    sessionsRoot,
    tui: host.tui,
    workflow: createCodexTuiWorkflow({
      dataDir,
      runtime: new CodexRuntimePort({ effort: 'high' }),
      now: () => new Date().toISOString(),
    }),
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();

  const captures = [];
  const push = async (name, width, frame) => {
    await writeFile(join(framesDir, `${name}.txt`), frame, 'utf8');
    await writeFile(join(htmlDir, `${name}.html`), pageHtml(name, width, frame), 'utf8');
    captures.push({ name, width, rows: frame.split('\n').length });
    console.log(`captured ${name} ${width}x${frame.split('\n').length}`);
  };

  await push('01-home', 120, host.render(120));

  enterCommand(app, '/intake');
  console.log('waiting for session list...');
  await waitFor(() => /filter: (all|eligible)/.test(host.render(120)), 180_000);
  await push('02-sessions-wide', 120, host.render(120));
  await push('03-sessions-compact', 60, host.render(60));

  const typeQuery = (query) => {
    app.handleInput('/');
    for (const char of query) app.handleInput(char);
  };
  if (/Projects /.test(host.render(120))) {
    typeQuery(TARGET);
    await waitFor(() => host.render(120).includes(TARGET.slice(0, 8)) || /20260810|汇报ppt/.test(host.render(120)));
    await push('02a-search-projects', 120, host.render(120));
    app.handleInput('\r');
    await waitFor(() => /Choose a historical session/.test(host.render(120)));
  }
  if (!host.render(120).includes(TARGET.slice(0, 8))) {
    typeQuery(TARGET);
    await waitFor(() => host.render(120).includes(TARGET.slice(0, 8)));
  }
  await push('02b-project-sessions', 120, host.render(120));

  app.handleInput('\r');
  await waitFor(() => /Review the session details/.test(host.render(120)));
  terminal.rows = undefined;
  await push('04-inspection-unbounded', 120, host.render(120));
  terminal.rows = 32;
  await push('05-inspection-32rows', 120, host.render(120));
  terminal.rows = 24;
  await push('06-inspection-24rows', 120, host.render(120));
  terminal.rows = undefined;
  await push('07-inspection-compact', 60, host.render(60));

  terminal.rows = 32;
  app.handleInput('\u001b[B');
  await push('08-inspection-task-2', 120, host.render(120));
  app.handleInput('\u001b[B');
  await push('09-inspection-task-3', 120, host.render(120));
  app.handleInput('\u001b[A');
  app.handleInput('\u001b[A');
  await push('10-inspection-task-1-again', 120, host.render(120));

  app.handleInput('\r');
  await waitFor(() => /is current/.test(host.render(120)));
  terminal.rows = undefined;
  await push('11-home-after-freeze', 120, host.render(120));

  enterCommand(app, '/run');
  await waitFor(() => /Source root/.test(host.render(120)));
  await push('12-run-source', 120, host.render(120));
  app.handleInput('\r');
  await waitFor(() => /Candidate preflight/.test(host.render(120)));
  await push('13-run-preflight', 120, host.render(120));
  app.handleInput('\r');
  await waitFor(() => /Start isolated Codex Candidate/.test(host.render(120)));
  await push('14-run-confirm', 120, host.render(120));

  const index = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Intake walkthrough</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#0b1220;color:#e5e7eb;padding:24px;max-width:1100px} a{color:#93c5fd} li{margin:10px 0} img{max-width:100%;border:1px solid #1f2937;border-radius:8px;margin-top:6px}</style>
</head><body>
<h1>真实会话 intake 走查</h1>
<p>目标会话 <code>${TARGET}</code>。未按确认页 Enter，避免启动计费 Codex 进程。</p>
<ol>
${captures.map((item) => `<li><a href="html/${item.name}.html">${item.name}</a> · ${item.width} cols · ${item.rows} rows<br><img src="screenshots/${item.name}.png" alt="${item.name}"></li>`).join('\n')}
</ol>
</body></html>`;
  await writeFile(join(outDir, 'index.html'), index, 'utf8');
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ target: TARGET, sessionsRoot, captures, index: pathToFileURL(join(outDir, 'index.html')).href }, null, 2));
  console.log(`wrote ${captures.length} frames to ${outDir}`);
  await rm(dataDir, { recursive: true, force: true });
}

await main();
