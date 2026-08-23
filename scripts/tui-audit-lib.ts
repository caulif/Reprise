import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function firstLineDiff(expected: string, actual: string): { line: number; expected: string | undefined; actual: string | undefined } | undefined {
  const left = expected.split('\n');
  const right = actual.split('\n');
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) {
      return { line: index + 1, expected: left[index], actual: right[index] };
    }
  }
  return undefined;
}

export async function compareFrames(generated: string, baseline: string): Promise<void> {
  const generatedFiles = new Set((await readdir(generated)).filter((name) => name.endsWith('.txt')).sort());
  const baselineFiles = new Set((await readdir(baseline)).filter((name) => name.endsWith('.txt')).sort());
  const stale: string[] = [];
  for (const name of baselineFiles) {
    if (!generatedFiles.has(name)) stale.push(`missing generated frame: ${name}`);
  }
  for (const name of generatedFiles) {
    if (!baselineFiles.has(name)) stale.push(`unexpected generated frame: ${name}`);
  }
  for (const name of generatedFiles) {
    if (!baselineFiles.has(name)) continue;
    const expected = toLf(await readFile(join(baseline, name), 'utf8'));
    const actual = toLf(await readFile(join(generated, name), 'utf8'));
    if (expected === actual) continue;
    const diff = firstLineDiff(expected, actual);
    stale.push(diff
      ? `${name} line ${diff.line}\n  baseline ${JSON.stringify(diff.expected)}\n  generated ${JSON.stringify(diff.actual)}`
      : `${name} differs`);
  }
  if (!stale.length) return;
  throw new Error(`TUI frames are stale.\n${stale.join('\n')}\n运行 npm run audit:tui 并提交 docs/tui-audit/frames/`);
}

export async function selfTestCompareFrames(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-frame-self-test-'));
  const generated = join(root, 'generated');
  const baseline = join(root, 'baseline');
  await mkdir(generated);
  await mkdir(baseline);
  await writeFile(join(generated, 'probe.txt'), 'generated\n', 'utf8');
  await writeFile(join(baseline, 'probe.txt'), 'baseline\n', 'utf8');
  try {
    await compareFrames(generated, baseline);
    throw new Error('compareFrames accepted a mismatched frame');
  } catch (error) {
    if (error instanceof Error && error.message.includes('accepted a mismatched')) throw error;
    if (!(error instanceof Error) || !error.message.includes('TUI frames are stale')) throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('tui-visual-audit self-test: mismatched frames are rejected');
}

export function mockTui(rowsOrTerminal?: number | { rows: number; columns: number }): {
  tui: {
    terminal: { rows: number; columns: number } | undefined;
    addChild(component: { render: (width: number) => string[] }): void;
    addInputListener(): () => void;
    start(): void;
    stop(): void;
    requestRender(): void;
    renderNow(): void;
  };
  render(width?: number): string;
} {
  let document: { render: (width: number) => string[] } | undefined;
  const terminal = typeof rowsOrTerminal === 'number'
    ? { rows: rowsOrTerminal, columns: 120 }
    : rowsOrTerminal;
  const tui = {
    terminal,
    addChild(component: { render: (width: number) => string[] }) { document = component; },
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

export async function waitFor(
  condition: () => boolean,
  options: string | { describe?: string; timeoutMs?: number; frame?: () => string } = {},
): Promise<void> {
  const describe = typeof options === 'string' ? options : (options.describe ?? 'expected state');
  const timeoutMs = typeof options === 'object' ? options.timeoutMs : undefined;
  const frame = typeof options === 'object' ? options.frame : undefined;
  const delayMs = timeoutMs ? 50 : 10;
  const attempts = timeoutMs ? Math.ceil(timeoutMs / delayMs) : 400;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const preview = frame ? `\n${frame().slice(0, 1500)}` : '';
  throw new Error(`TUI did not reach ${describe}.${preview}`);
}

function ansiToHtml(text: string): string {
  const withLinks = text.replace(/\u001b\]8;;([^\u001b]*)\u001b\\([\s\S]*?)\u001b\]8;;\u001b\\/g, (_, url: string, body: string) => {
    const href = String(url).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return `\x00A${href}\x00B${body}\x00C`;
  });
  const escaped = withLinks
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const colors: Record<string, string> = {
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
  return escaped.replace(/\u001b\[([0-9;]+)m([\s\S]*?)\u001b\[0m/g, (_, code: string, body: string) => {
    const style = colors[code] ?? '';
    return style ? `<span style="${style}">${body}</span>` : body;
  }).replace(/\u001b\[[0-9;]*m/g, '').replace(/\x00A([^\x00]*)\x00B([\s\S]*?)\x00C/g, (_, href: string, body: string) => (
    `<a href="${href}" style="color:#67e8f9;text-decoration:underline">${body}</a>`
  ));
}

export function pageHtml(title: string, width: number, frame: string): string {
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
