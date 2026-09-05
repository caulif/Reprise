import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const IMPORT = /from\s+['"](\.[^'"]+)['"]/g;

test('core does not import products', async () => {
  const files = await tsFiles(join(SRC, 'core'));
  for (const file of files) {
    const imports = await relativeImports(file);
    assert.equal(imports.some((item) => item.includes(`${sep}products${sep}`) || item.includes('/products/')), false, `${relative(SRC, file)} imports products`);
  }
});

test('only the product registry may import a concrete pack', async () => {
  const files = await tsFiles(SRC);
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'products/index.ts') continue;
    if (rel.startsWith('products/codex/')) continue;
    if (rel.startsWith('products/claude-code/')) continue;
    if (rel.startsWith('products/shared/')) continue;
    if (rel === 'products/contract.ts') continue;
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*products\/(?:codex|claude-code)\//.test(source)) {
      violations.push(rel);
    }
  }
  assert.deepEqual(violations, []);
});

test('recovery stack does not import product JSONL parsers', async () => {
  const files = [
    ...(await tsFiles(join(SRC, 'agents'))).filter((file) => file.includes('recovery')),
    ...(await tsFiles(join(SRC, 'infrastructure'))).filter((file) => /recovery/.test(file)),
    ...(await tsFiles(join(SRC, 'application'))).filter((file) => /experiment-recovery|recovery-/.test(file)),
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(?:jsonl-io|products\/(?:codex|claude-code)\/sessions)['"]/.test(source)) {
      violations.push(relative(SRC, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(violations, []);
});

test('packs do not import each other', async () => {
  const packs = ['codex', 'claude-code'];
  for (const pack of packs) {
    const root = join(SRC, 'products', pack);
    try { await stat(root); } catch { continue; }
    for (const file of await tsFiles(root)) {
      const source = await readFile(file, 'utf8');
      for (const other of packs) {
        if (other === pack) continue;
        assert.equal(source.includes(`products/${other}/`), false, `${relative(SRC, file)} imports ${other}`);
      }
    }
  }
});

async function tsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return files.flat();
}

async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  return [...source.matchAll(IMPORT)].map((match) => match[1] ?? '');
}

test('internal agents share workspace tools; Controller omits read_observation', async () => {
  const { recoveryTools, recoveryObservationTools } = await import('../src/infrastructure/recovery-tools.js');
  const eight = ['edit', 'find', 'grep', 'ls', 'read', 'read_observation', 'shell_exec', 'write'];
  const seven = ['edit', 'find', 'grep', 'ls', 'read', 'shell_exec', 'write'];
  const recovery = [
    ...recoveryObservationTools({ transcript: [], historicalEvents: [] } as never).map((tool) => tool.name),
    ...recoveryTools('TMP').map((tool) => tool.name),
  ].sort();
  const controller = recoveryTools('TMP', { allowWrite: () => false, mounts: { project: 'REPLICA' } })
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(recovery, eight);
  assert.deepEqual(controller, seven);
  assert.equal(controller.includes('read_observation'), false);
  const experiment = await readFile(join(SRC, 'application/experiment-report.ts'), 'utf8');
  assert.match(experiment, /comparison\.requested/);
  assert.doesNotMatch(experiment, /write_comparison_report|read_artifact/);
  const loop = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.match(loop, /experimentAgentAuditSink/);
  assert.match(loop, /controllerBriefingRoot/);
  assert.match(loop, /assertBriefingOutsideReplica/);
  assert.doesNotMatch(loop, /observationTools/);
  assert.doesNotMatch(loop, /recoveryTools\(\s*input\.environment\.root/);
  const caller = await readFile(join(SRC, 'infrastructure/pi-model-caller.ts'), 'utf8');
  assert.match(caller, /shouldStopAfterTurn/);
  assert.match(caller, /compactPiMessages/);
});




