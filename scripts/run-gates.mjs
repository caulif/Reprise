#!/usr/bin/env node
import { spawn } from 'node:child_process';

const GATES = [
  { id: 'build', label: 'build', command: 'npm', args: ['run', 'build'] },
  { id: 'typecheck', label: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { id: 'lint', label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { id: 'verify:docs', label: 'verify docs', command: 'node', args: ['scripts/verify-docs.mjs'] },
  { id: 'test', label: 'test', command: 'npm', args: ['run', 'test:only'], needs: ['build'] },
  { id: 'check:node', label: 'check node', command: 'npm', args: ['run', 'check:node'], needs: ['build'] },
  { id: 'audit:tui:check', label: 'tui frames', command: 'node', args: ['scripts/tui-visual-audit.mjs', '--check'], needs: ['build'] },
  { id: 'verify:generated', label: 'generated docs', command: 'node', args: ['scripts/gen-docs.mjs', '--check'], needs: ['build'] },
  { id: 'test:coverage', label: 'coverage', command: 'npm', args: ['run', 'test:coverage'] },
  { id: 'knip', label: 'knip', command: 'npm', args: ['run', 'knip'], allowFailure: true },
  { id: 'jscpd', label: 'jscpd', command: 'npm', args: ['run', 'jscpd'], allowFailure: true },
];

const MODES = {
  docs: ['verify:docs'],
  check: ['build', 'typecheck', 'lint', 'test', 'check:node', 'audit:tui:check', 'verify:docs', 'verify:generated', 'knip', 'jscpd'],
  static: ['typecheck', 'lint', 'verify:docs', 'build', 'verify:generated'],
  test: ['build', 'test', 'check:node'],
  audit: ['build', 'audit:tui:check'],
  ci: ['build', 'typecheck', 'lint', 'test', 'check:node', 'audit:tui:check', 'verify:docs', 'verify:generated', 'test:coverage', 'knip', 'jscpd'],
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

function runCommand(gate) {
  return new Promise((resolve) => {
    const child = spawn(gate.command, gate.args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function main() {
  const mode = process.argv[2] ?? 'check';
  const ids = MODES[mode];
  if (!ids) throw new Error(`unknown mode: ${mode}`);
  const selected = GATES.filter((gate) => ids.includes(gate.id));
  validate(selected);
  const started = Date.now();
  const status = new Map();
  const results = [];
  const pending = new Set(selected.map((gate) => gate.id));
  while (pending.size) {
    const ready = selected.filter((gate) => pending.has(gate.id) && (gate.needs ?? []).every((need) => status.get(need) === 'pass' || status.get(need) === 'non-blocking'));
    const blocked = selected.filter((gate) => pending.has(gate.id) && (gate.needs ?? []).some((need) => status.get(need) === 'fail' || status.get(need) === 'skip'));
    for (const gate of blocked) {
      pending.delete(gate.id);
      status.set(gate.id, 'skip');
      results.push({ gate, ok: false, skipped: true, reason: `依赖失败或被跳过: ${(gate.needs ?? []).join(', ')}` });
    }
    if (!ready.length && pending.size) throw new Error(`gates stalled: ${[...pending].join(', ')}`);
    await Promise.all(ready.map(async (gate) => {
      pending.delete(gate.id);
      const ok = await runCommand(gate);
      if (ok) {
        status.set(gate.id, 'pass');
        results.push({ gate, ok: true });
        return;
      }
      if (gate.allowFailure) {
        status.set(gate.id, 'non-blocking');
        results.push({ gate, ok: false, allowFailure: true });
        return;
      }
      status.set(gate.id, 'fail');
      results.push({ gate, ok: false });
    }));
  }
  const failed = results.filter((item) => !item.ok && !item.skipped && !item.allowFailure);
  const skipped = results.filter((item) => item.skipped);
  const passed = results.filter((item) => item.ok);
  for (const item of results) {
    if (item.skipped) console.log(`SKIP  ${item.gate.label} (${item.reason})`);
    else if (item.allowFailure) console.log(`NON-BLOCKING  ${item.gate.label}`);
    else console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.gate.label}`);
  }
  console.log(`run-gates: ${passed.length} 通过, ${failed.length} 失败, ${skipped.length} 跳过, 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length) {
    for (const item of failed) console.log(`失败: ${item.gate.label}`);
    process.exitCode = 1;
  }
}

await main();
