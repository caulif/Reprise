#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const GATES = [
  { id: 'build', label: 'build', command: 'npm', args: ['run', 'build'] },
  { id: 'typecheck', label: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { id: 'lint', label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { id: 'verify:docs', label: 'verify docs', command: 'node', args: ['scripts/verify-docs.mjs'] },
  { id: 'test', label: 'test', command: 'npm', args: ['run', 'test:only'], needs: ['build'] },
  { id: 'check:node', label: 'check node', command: 'npm', args: ['run', 'check:node'], needs: ['build'] },
  { id: 'audit:tui:check', label: 'tui frames', command: 'node', args: ['scripts/tui-visual-audit.mjs', '--check'], needs: ['build'] },
  { id: 'audit:tui:analyze', label: 'tui analyze', command: 'node', args: ['scripts/tui-audit-analyze.mjs'], needs: ['build'] },
  { id: 'verify:generated', label: 'generated docs', command: 'node', args: ['scripts/gen-docs.mjs', '--check'], needs: ['build'] },
  { id: 'knip', label: 'knip', command: 'npm', args: ['run', 'knip'] },
  { id: 'jscpd', label: 'jscpd', command: 'npm', args: ['run', 'jscpd'] },
  { id: 'verify:pack', label: 'pack allowlist', command: 'node', args: ['scripts/verify-pack.mjs'], needs: ['build'] },
  { id: 'verify:audit', label: 'npm audit', command: 'node', args: ['scripts/verify-audit.mjs'] },
  { id: 'verify:secrets', label: 'secret scan', command: 'node', args: ['scripts/verify-secrets.mjs'] },
  { id: 'verify:imports', label: 'layer imports', command: 'node', args: ['scripts/verify-layer-imports.mjs'] },
  { id: 'verify:source-size', label: 'source size', command: 'node', args: ['scripts/verify-source-size.mjs'] },
  { id: 'verify:tracked-source', label: 'tracked source', command: 'node', args: ['scripts/verify-tracked-source.mjs'] },
];

const MODES = {
  docs: ['verify:docs'],
  check: ['build', 'typecheck', 'lint', 'test', 'check:node', 'audit:tui:check', 'audit:tui:analyze', 'verify:docs', 'verify:generated', 'knip', 'jscpd', 'verify:pack', 'verify:audit', 'verify:secrets', 'verify:imports', 'verify:source-size', 'verify:tracked-source'],
  static: ['typecheck', 'lint', 'verify:docs', 'build', 'verify:generated', 'verify:pack', 'verify:audit', 'verify:secrets', 'verify:imports', 'verify:source-size', 'verify:tracked-source'],
  test: ['build', 'test', 'check:node'],
  audit: ['build', 'audit:tui:check', 'audit:tui:analyze'],
};

function validate(selected) {
  const ids = new Set();
  for (const gate of selected) {
    if (ids.has(gate.id)) throw new Error(`duplicate gate id: ${gate.id}`);
    ids.add(gate.id);
    for (const need of gate.needs ?? []) {
      if (!selected.some((item) => item.id === need)) throw new Error(`unknown dependency: ${gate.id} -> ${need}`);
    }
  }
  const visiting = new Set();
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle: ${id}`);
    visiting.add(id);
    for (const need of selected.find((gate) => gate.id === id)?.needs ?? []) visit(need);
    visiting.delete(id);
    seen.add(id);
  };
  for (const gate of selected) visit(gate.id);
}

function collectRuntime() {
  let git = 'unknown';
  try {
    git = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // git 不可用或不是 git 检出时仍输出 node/os，避免诊断本身再失败
  }
  return { node: process.version, os: `${process.platform} ${process.arch}`, git };
}

function commandLine(gate) {
  return [gate.command, ...(gate.args ?? [])].join(' ');
}

function formatFailure(gate, result, runtime) {
  const lines = [
    `FAIL  ${gate.id} (${gate.label})`,
    `command: ${commandLine(gate)}`,
  ];
  if (result.spawnError) {
    const code = result.spawnError.code ? `${result.spawnError.code} ` : '';
    lines.push(`spawn error: ${code}${result.spawnError.message}`);
  } else {
    lines.push(`exit: ${result.code ?? '-'} signal: ${result.signal ?? '-'}`);
  }
  lines.push(`node: ${runtime.node} os: ${runtime.os} git: ${runtime.git}`);
  return lines.join('\n');
}

function npmCliJs() {
  return join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function resolveLaunch(gate) {
  if (gate.command === 'npm') {
    return { command: process.execPath, args: [npmCliJs(), ...(gate.args ?? [])] };
  }
  return { command: gate.command, args: gate.args ?? [] };
}

function runCommand(gate, options = {}) {
  const launch = resolveLaunch(gate);
  const shell = options.shell ?? false;
  const stdio = options.stdio ?? 'inherit';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(launch.command, launch.args, { stdio, shell, windowsHide: true });
    child.on('exit', (code, signal) => {
      finish({ ok: code === 0 && !signal, code, signal, spawnError: null });
    });
    child.on('error', (spawnError) => {
      finish({ ok: false, code: null, signal: null, spawnError });
    });
  });
}

function requireDiagnostic(text, fields) {
  const missing = fields.filter((field) => !text.includes(field));
  if (missing.length) {
    throw new Error(`诊断缺少字段: ${missing.join(', ')}\n${text}`);
  }
}

async function selfTest() {
  const runtime = collectRuntime();
  const exitGate = { id: 'self-test-exit', label: 'self-test exit', command: process.execPath, args: ['-e', 'process.exit(3)'] };
  const exitResult = await runCommand(exitGate, { shell: false, stdio: 'ignore' });
  if (exitResult.ok || exitResult.code !== 3) {
    throw new Error(`自检期望 exit 3，实际 ok=${exitResult.ok} code=${exitResult.code}`);
  }
  const exitText = formatFailure(exitGate, exitResult, runtime);
  requireDiagnostic(exitText, ['self-test-exit', 'command:', 'exit: 3', 'node:', 'os:', 'git:']);

  const spawnGate = { id: 'self-test-spawn', label: 'self-test spawn', command: process.execPath + '-missing-reprise-gate', args: [] };
  const spawnResult = await runCommand(spawnGate, { shell: false, stdio: 'ignore' });
  if (spawnResult.ok || !spawnResult.spawnError) {
    throw new Error('自检期望 spawn 失败');
  }
  const spawnText = formatFailure(spawnGate, spawnResult, runtime);
  requireDiagnostic(spawnText, ['self-test-spawn', 'command:', 'spawn error:', 'node:', 'os:', 'git:']);
  const packGate = GATES.find((gate) => gate.id === 'verify:pack');
  if (!packGate?.needs?.includes('build')) {
    throw new Error('verify:pack 必须 needs build，避免与 rm dist 并行');
  }
  const spaceGate = {
    id: 'self-test-space',
    label: 'self-test space',
    command: process.execPath,
    args: ['-e', 'process.exit(process.argv.includes("a b") ? 0 : 4)', 'a b'],
  };
  const spaceResult = await runCommand(spaceGate, { shell: false, stdio: 'ignore' });
  if (!spaceResult.ok) {
    throw new Error('带空格参数在 shell:false 下应当原样传递');
  }
  if (process.platform === 'win32') {
    const npmResult = await runCommand({ id: 'self-test-npm', label: 'npm via npm-cli.js', command: 'npm', args: ['-v'] }, { stdio: 'ignore' });
    if (!npmResult.ok) {
      throw new Error('Windows 下 node npm-cli.js + shell:false 应当能运行');
    }
    const dir = join(tmpdir(), `reprise gate ${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, 'ok.cmd');
    writeFileSync(shim, '@echo off\r\nexit /b 0\r\n');
    try {
      const cmdResult = await runCommand({
        id: 'self-test-cmd-shim',
        label: 'cmd shim',
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/c', shim],
      }, { stdio: 'ignore' });
      if (!cmdResult.ok) {
        throw new Error('.cmd shim 应通过 quoted ComSpec /c 启动');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('run-gates self-test: 非0退出与 spawn 失败均输出可诊断字段；verify:pack 依赖 build；npm 经 npm-cli.js 且 shell:false');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await selfTest();
    return;
  }
  await selfTest();
  const mode = process.argv[2] ?? 'check';
  const ids = MODES[mode];
  if (!ids) throw new Error(`unknown mode: ${mode}`);
  const selected = GATES.filter((gate) => ids.includes(gate.id));
  validate(selected);
  const runtime = collectRuntime();
  const started = Date.now();
  const status = new Map();
  const results = [];
  const pending = new Set(selected.map((gate) => gate.id));
  while (pending.size) {
    const ready = selected.filter((gate) => pending.has(gate.id) && (gate.needs ?? []).every((need) => status.get(need) === 'pass'));
    const blocked = selected.filter((gate) => pending.has(gate.id) && (gate.needs ?? []).some((need) => status.get(need) === 'fail' || status.get(need) === 'skip'));
    for (const gate of blocked) {
      pending.delete(gate.id);
      status.set(gate.id, 'skip');
      results.push({ gate, ok: false, skipped: true, reason: `依赖失败或被跳过: ${(gate.needs ?? []).join(', ')}` });
    }
    if (!ready.length && pending.size) throw new Error(`gates stalled: ${[...pending].join(', ')}`);
    await Promise.all(ready.map(async (gate) => {
      pending.delete(gate.id);
      const result = await runCommand(gate);
      if (result.ok) {
        status.set(gate.id, 'pass');
        results.push({ gate, ok: true });
        return;
      }
      status.set(gate.id, 'fail');
      results.push({ gate, ok: false, result });
    }));
  }
  const failed = results.filter((item) => !item.ok && !item.skipped);
  const skipped = results.filter((item) => item.skipped);
  const passed = results.filter((item) => item.ok);
  for (const item of results) {
    if (item.skipped) console.log(`SKIP  ${item.gate.id} (${item.reason})`);
    else if (item.ok) console.log(`PASS  ${item.gate.id}`);
    else console.log(formatFailure(item.gate, item.result, runtime));
  }
  console.log(`run-gates: ${passed.length} 通过, ${failed.length} 失败, ${skipped.length} 跳过, 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length) {
    for (const item of failed) console.log(`失败: ${item.gate.id}  ${commandLine(item.gate)}`);
    process.exitCode = 1;
  }
}

await main();
