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
