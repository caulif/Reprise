import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingComparisonTools } from '../../src/application/comparison-coding-tools.js';
import type { RenderRequest } from '../../src/infrastructure/artifact-render-types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const signal = new AbortController().signal;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'comparison-coding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'input'), workRoot = join(root, 'work');
  await mkdir(sourceRoot); await mkdir(workRoot);
  await writeFile(join(sourceRoot, 'delivery.html'), '<html><body>Original</body></html>');
  await writeFile(join(sourceRoot, 'sample.png'), png);
  return { root, sourceRoot, workRoot };
}

test('coding lane writes a complete report without submission tools and protects source files', async t => {
  const f = await fixture(t), tools = createCodingComparisonTools(f);
  assert.equal(tools.some(tool => /submit|register|preview_report/.test(tool.name)), false);
  const write = tools.find(tool => tool.name === 'write')!;
  await write.execute({ path: 'report.html', content: '<html><body><style>p{color:red}</style><p>Result</p></body></html>' }, signal);
  assert.match(await readFile(join(f.workRoot, 'report.html'), 'utf8'), /Result/);
  await assert.rejects(write.execute({ path: 'source/delivery.html', content: 'changed' }, signal));
  assert.match(await readFile(join(f.sourceRoot, 'delivery.html'), 'utf8'), /Original/);
  const viewed = await tools.find(tool => tool.name === 'view_image')!.execute({ path: 'source/sample.png' }, signal);
  assert.equal(viewed.contentBlocks?.[1]?.type, 'image');
});

test('browser tool checks both source and working report with actions and native images, without catalog IDs', async t => {
  const f = await fixture(t), requests: RenderRequest[] = [];
  const tools = createCodingComparisonTools({ ...f, render: async request => {
    requests.push(request);
    await mkdir(request.outputRoot, { recursive: true });
    const path = join(request.outputRoot, 'frame.png'); await writeFile(path, png);
    return { ok: true, frames: [{ pngPath: path, byteLength: png.length, contentHash: 'fixture', sampleTimeMs: 0, actualTimeMs: 0 }],
      diagnostics: [], measured: { loadMs: 0, viewport: request.viewport, origin: 'fixture' } };
  } });
  const render = tools.find(tool => tool.name === 'render_browser')!;
  const first = await render.execute({ path: 'source/delivery.html', actions: [{ kind: 'scroll', x: 0, y: 500 }], media: { reducedMotion: 'reduce' }, geometryQueries: [{ name: 'body', selector: 'body', kind: 'dom_rect' }] }, signal);
  assert.equal(first.contentBlocks?.[1]?.type, 'image');
  assert.equal(requests[0]?.bundleRoot, await realpath(f.sourceRoot));
  assert.equal(requests[0]?.actions?.[0]?.kind, 'scroll');
  assert.equal(requests[0]?.media?.reducedMotion, 'reduce');
  assert.equal(requests[0]?.geometryQueries?.[0]?.selector, 'body');
  await writeFile(join(f.workRoot, 'report.html'), '<html><body>Result</body></html>');
  const second = await render.execute({ path: 'report.html', viewport: { width: 390, height: 844 }, includeImages: false }, signal);
  assert.equal(requests[1]?.bundleRoot, await realpath(f.workRoot));
  assert.equal(requests[1]?.viewport.width, 390);
  assert.equal(second.contentBlocks?.length, 1);
  assert.notEqual(requests[0]?.outputRoot, requests[1]?.outputRoot);
});

test('coding shell rejects browser launches and global process termination without spawning', async t => {
  const f = await fixture(t), shell = createCodingComparisonTools(f).find(tool => tool.name === 'exec_command')!;
  for (const command of ['chrome --headless --dump-dom report.html', 'Stop-Process -Name chrome -Force', 'taskkill /IM node.exe /F', 'pkill firefox']) {
    const result = await shell.execute({ cmd: command }, signal);
    assert.match(result.content, /render_browser/); assert.deepEqual(result.details, { denied: true, code: 'process_boundary' });
  }
});

test('image/browser path boundaries reject traversal and escaping junctions; invalid inputs are recoverable', async t => {
  const f = await fixture(t), tools = createCodingComparisonTools(f);
  await symlink(f.root, join(f.workRoot, 'escape'), 'junction');
  const image = tools.find(tool => tool.name === 'view_image')!;
  for (const path of ['../input/sample.png', 'source/../work/report.html', 'escape/input/sample.png', join(f.sourceRoot, 'sample.png')]) {
    await assert.rejects(image.execute({ path }, signal), /escapes|Use source/);
  }
  assert.match((await image.execute({}, signal)).content, /Supply/);
  await assert.rejects(image.execute({ path: 'missing.png' }, signal), /does not exist/);
  await assert.rejects(image.execute({ path: 'source/' }, signal), /regular file/);
  assert.match((await tools.find(tool => tool.name === 'render_browser')!.execute({ path: 'report.html', actions: [{ kind: 'eval' }] }, signal)).content, /Invalid/);
});

test('path-based image crop validates original bounds and returns its image directly', async t => {
  const f = await fixture(t);
  let transforms = 0;
  const tools = createCodingComparisonTools({ ...f, transform: async (bytes, spec) => {
    transforms++; assert.deepEqual(bytes, png); assert.equal(spec.crop.width, 1); return png;
  } });
  const crop = tools.find(tool => tool.name === 'transform_image')!;
  const invalid = await crop.execute({ path: 'source/sample.png', crop: { x: 1, y: 0, width: 1, height: 1 }, width: 1, height: 1 }, signal);
  assert.match(invalid.content, /outside/); assert.equal(transforms, 0);
  const result = await crop.execute({ path: 'source/sample.png', crop: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1 }, signal);
  assert.equal(transforms, 1); assert.equal(result.contentBlocks?.[1]?.type, 'image');
});
