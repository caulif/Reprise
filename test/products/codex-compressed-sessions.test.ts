import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { codexSessionAdapter, discoverCodexSessions, inspectCodexSession } from '../../src/products/packs/codex/sessions.js';
import { readCodexCatalog } from '../../src/products/packs/codex/catalog.js';
import { resolveCodexSource, withCodexSource } from '../../src/products/packs/codex/session-source.js';
import { freezeCase } from '../../src/products/shared/freeze.js';
import { sessionReadStream, snapshotSessionSource, type SessionReadOptions } from '../../src/products/shared/session-source.js';
import { formatDiscoverySignals } from '../../src/tui/pages/intake.js';

function body(id = 'compressed-session', text = 'Render a bicycle. SECRET'): Buffer {
  return Buffer.from([
    { timestamp: '2026-09-13T00:00:00.000Z', type: 'session_meta', payload: { id } },
    { type: 'event_msg', payload: { type: 'user_message', message: text } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((row) => JSON.stringify(row)).join('\r\n') + '\r\n');
}

async function decoded(path: string, options: SessionReadOptions = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of sessionReadStream(path, options)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('compressed Codex discovery binds the stale SQLite path and preserves frozen identity and raw bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const plain = join(sessions, 'rollout-session.jsonl');
  const raw = body();
  await writeFile(plain, raw);
  const ref = { productId: 'codex', sessionId: 'compressed-session', sourcePath: plain };
  const original = await codexSessionAdapter.import(ref);
  const privacy = { allowModelText: true, allowBinary: false, redactions: [] };
  const first = await freezeCase(original, join(root, 'plain-cases'), privacy, '2026-10-19T00:00:00.000Z');
  await writeFile(`${plain}.zst`, zstdCompressSync(raw));
  await rm(plain);
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(ref.sessionId, plain, 'Indexed title');
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot: sessions });
  assert.equal(catalog.sessions[0]?.availability, 'indexed');
  assert.equal(catalog.diagnostics.some((item) => item.code === 'source-missing'), false);
  const found = await discoverCodexSessions(sessions);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, ref.sessionId);
  assert.equal(found[0]?.availability, 'indexed');
  const inspection = await codexSessionAdapter.inspect(ref);
  assert.equal(inspection.signals.userMessages, 1);
  const compressed = await codexSessionAdapter.import(ref);
  assert.deepEqual(compressed.transcript, original.transcript);
  assert.deepEqual(compressed.raw.receipt, original.raw.receipt);
  const second = await freezeCase(compressed, join(root, 'compressed-cases'), privacy, '2026-10-19T00:00:00.000Z');
  assert.equal(second.taskCase.caseId, first.taskCase.caseId);
  assert.equal(second.taskCase.provenance.sourceHash, first.taskCase.provenance.sourceHash);
  assert.deepEqual(await readFile(join(root, 'compressed-cases', second.taskCase.caseId, 'raw/session.jsonl')), raw);
  assert.deepEqual(await readFile(`${plain}.zst`), zstdCompressSync(raw));
});

test('compressed import redacts the decoded snapshot and refuses changes after parsing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-freeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'rollout-session.jsonl.zst');
  await writeFile(sourcePath, zstdCompressSync(body()));
  const imported = await codexSessionAdapter.import({ productId: 'codex', sessionId: 'compressed-session', sourcePath });
  const privacy = { allowModelText: true, allowBinary: false, redactions: ['SECRET'] };
  const cases = join(root, 'cases');
  const frozen = await freezeCase(imported, cases, privacy, '2026-10-19T00:00:00.000Z');
  const raw = await readFile(join(cases, frozen.taskCase.caseId, 'raw/session.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /SECRET/);
  assert.match(raw, /\[REDACTED\]/);
  for (const line of raw.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line) as unknown);
  await writeFile(sourcePath, zstdCompressSync(body('compressed-session', 'A different task.')));
  await assert.rejects(freezeCase(imported, join(root, 'changed-cases'), privacy, '2026-10-19T00:00:00.000Z'), /changed after import/);
  await assert.rejects(readdir(join(root, 'changed-cases')), { code: 'ENOENT' });
});

test('plain representation wins without silently falling back from corrupt or mismatched plaintext', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-precedence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plain = join(root, 'rollout-session.jsonl');
  await writeFile(plain, body());
  await writeFile(`${plain}.zst`, zstdCompressSync(body('stale-session')));
  const found = await discoverCodexSessions(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, 'compressed-session');
  assert.equal(resolveCodexSource(`${plain}.zst`), await realpath(plain));
  await writeFile(plain, 'broken json\n');
  await assert.rejects(inspectCodexSession(`${plain}.zst`));
  await writeFile(plain, body('different-id'));
  await assert.rejects(codexSessionAdapter.inspect({ productId: 'codex', sessionId: 'compressed-session', sourcePath: `${plain}.zst` }), /does not match/);
});

test('compressed frame errors are fatal and discovery preserves a specific diagnostic and unknown count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-damage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const bytes of [Buffer.from('not zstandard'), zstdCompressSync(body()).subarray(0, -1)]) {
    const source = join(root, 'rollout-broken.jsonl.zst');
    await writeFile(source, bytes);
    await assert.rejects(inspectCodexSession(source), { code: 'decompression-failed' });
    const found = await codexSessionAdapter.discover({ root, refresh: true });
    assert.equal(found.items[0]?.availability, 'unreadable');
    assert.equal(found.items[0]?.recoveryDiagnostics?.[0]?.code, 'decompression-failed');
    assert.equal(formatDiscoverySignals(found.items[0]), 'u?');
  }
});

test('decoded budgets, prefix windows, multiframe UTF-8 and cancellation operate on decoded bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'rollout-session.jsonl.zst');
  const raw = body('compressed-session', '中文'.repeat(5000));
  await writeFile(source, Buffer.concat([zstdCompressSync(raw.subarray(0, 301)), zstdCompressSync(raw.subarray(301))]));
  assert.deepEqual(await decoded(source, { encoding: 'zstd' }), raw);
  assert.equal((await inspectCodexSession(source)).transcript[0]?.text, '中文'.repeat(5000));
  assert.deepEqual(await decoded(source, { encoding: 'zstd', maxBytes: 257, prefix: true }), raw.subarray(0, 257));
  await assert.rejects(decoded(source, { encoding: 'zstd', maxBytes: 257 }), { code: 'read-limit' });
  await assert.rejects(decoded(source, { encoding: 'zstd', maxLineBytes: 200 }), { code: 'read-limit' });
  await assert.rejects(decoded(source, { encoding: 'zstd', signal: AbortSignal.abort() }), { name: 'AbortError' });
  const control = new AbortController();
  await assert.rejects(decoded(source, { encoding: 'zstd', signal: control.signal, onBytes: () => control.abort() }), { name: 'AbortError' });
  assert.deepEqual(await decoded(source, { encoding: 'zstd' }), raw);
  await assert.rejects(decoded(join(root, 'missing.zst'), { encoding: 'zstd' }), { code: 'ENOENT' });
});

test('compressed oversized summaries use a decoded bounded head and still allow full inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'rollout-large.jsonl.zst');
  const raw = Buffer.concat([body(), Buffer.from(JSON.stringify({ type: 'unrecognized', payload: 'x'.repeat(4 * 1024 * 1024) }) + '\n')]);
  await writeFile(source, zstdCompressSync(raw));
  const found = await discoverCodexSessions(root);
  assert.equal(found[0]?.partial, true);
  assert.equal(found[0]?.recoveryReadiness, 'pending');
  const inspection = await inspectCodexSession(source);
  assert.equal(inspection.sessionId, 'compressed-session');
  assert.equal(inspection.signals.userMessages, 1);
});

test('representation races retry only missing files and support cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'rollout-session.jsonl');
  await writeFile(source, body());
  let calls = 0;
  const result = await withCodexSource(source, async (resolved) => {
    calls += 1;
    if (calls === 1) {
      await writeFile(`${source}.zst`, zstdCompressSync(body()));
      await rm(source);
      throw Object.assign(new Error('representation changed'), { code: 'ENOENT' });
    }
    return resolved;
  });
  assert.equal(result, await realpath(`${source}.zst`));
  assert.equal(calls, 2);
  await assert.rejects(withCodexSource(source, () => Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }))), { code: 'EPERM' });
  await assert.rejects(withCodexSource(join(root, 'missing.jsonl'), () => Promise.resolve('unexpected')), { code: 'ENOENT' });
  const control = new AbortController();
  await assert.rejects(withCodexSource(source, () => { control.abort(); return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })); }, control.signal), { name: 'AbortError' });
});

test('compressed catalog sources cannot escape their configured root through siblings or links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-containment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const outside = join(root, 'outside.jsonl.zst');
  await writeFile(outside, zstdCompressSync(body()));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('compressed-session', outside);
  db.close();
  assert.equal((await readCodexCatalog({ codexHome: root, sessionsRoot: sessions })).sessions[0]?.availability, 'catalog-only');
  const linked = join(sessions, 'rollout-link.jsonl.zst');
  try { await symlink(outside, linked, 'file'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EPERM') { t.diagnostic('file symlink unavailable'); return; } throw error; }
  assert.throws(() => resolveCodexSource(linked), /regular file/);
});

test('source snapshots accept legacy plain defaults and verify exact imported receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-source-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'session.jsonl');
  await writeFile(source, body());
  await snapshotSessionSource(source, join(root, 'copy'), undefined, undefined);
  assert.deepEqual(await readFile(join(root, 'copy')), body());
  await assert.rejects(snapshotSessionSource(source, join(root, 'mismatch'), 'identity', { hash: 'wrong', bytes: body().length }), { code: 'source-changed' });
});

test('frame validation checks skippable frames, checksums, headers and exact frame boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-zstd-frames-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'session.zst');
  const raw = body();
  const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
  await writeFile(source, Buffer.concat([skip, compressed]));
  assert.equal((await decoded(source, { encoding: 'zstd' })).equals(raw), true);
  const checksumDamage = Buffer.from(compressed);
  checksumDamage[checksumDamage.length - 1]! ^= 1;
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const huge = Buffer.alloc(8);
  huge.writeBigUInt64LE(513n * 1024n * 1024n);
  const invalid = [
    checksumDamage,
    compressed.subarray(0, -2),
    Buffer.concat([compressed, Buffer.from([1])]),
    Buffer.concat([magic, Buffer.from([8])]),
    Buffer.concat([magic, Buffer.from([0x20, 1, 7, 0, 0])]),
    Buffer.concat([magic, Buffer.from([0x20, 1, 1, 0, 0])]),
    skip,
    Buffer.alloc(0),
  ];
  for (const value of invalid) {
    await writeFile(source, value);
    await assert.rejects(decoded(source, { encoding: 'zstd' }), { code: 'decompression-failed' });
  }
  for (const value of [Buffer.concat([magic, Buffer.from([0xe0]), huge]), Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0xff, 0xff, 0xff, 0x7f]), Buffer.concat([magic, Buffer.from([0, 0xff])])]) {
    await writeFile(source, value);
    await assert.rejects(decoded(source, { encoding: 'zstd' }), { code: 'read-limit' });
  }
  // A streaming frame can omit a content size. Its final block still establishes EOF.
  await writeFile(source, Buffer.concat([magic, Buffer.from([0, 0, 25, 0, 0]), Buffer.from('abc')]));
  assert.equal((await decoded(source, { encoding: 'zstd' })).toString(), 'abc');
  await writeFile(source, Buffer.concat([magic, Buffer.from([0x20, 7, 59, 0, 0, 97])]));
  assert.equal((await decoded(source, { encoding: 'zstd' })).toString(), 'aaaaaaa');
});

test('cancelled concurrent compressed previews release decoder slots for later full reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-zstd-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'session.zst');
  const raw = Buffer.concat(Array.from({ length: 5000 }, () => body()));
  await writeFile(source, zstdCompressSync(raw));
  const control = new AbortController();
  const reads = Array.from({ length: 8 }, () => decoded(source, { encoding: 'zstd', signal: control.signal, onBytes: () => control.abort() }));
  const results = await Promise.allSettled(reads);
  assert.equal(results.every((result) => result.status === 'rejected'), true);
  assert.equal((await decoded(source, { encoding: 'zstd' })).equals(raw), true);
});

test('catalog identity recovered from a compressed prefix cannot conceal a failed full decode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-prefix-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const plain = join(sessions, 'rollout-session.jsonl');
  await writeFile(`${plain}.zst`, Buffer.concat([zstdCompressSync(body()), Buffer.from('bad trailing frame')]));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('compressed-session', plain, 'Keep the real title');
  db.close();
  const found = await discoverCodexSessions(sessions);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, 'compressed-session');
  assert.equal(found[0]?.availability, 'unreadable');
  assert.equal(found[0]?.summary, 'Keep the real title');
  assert.equal(found[0]?.recoveryDiagnostics?.[0]?.code, 'decompression-failed');
});

test('a damaged duplicate cannot replace another verified transcript regardless of discovery order', async (t) => {
  for (const damagedDate of ['2026-10-18T00:00:00.000Z', '2026-10-20T00:00:00.000Z']) {
    await t.test(damagedDate, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'reprise-compressed-duplicate-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const sessions = join(root, 'sessions');
      await mkdir(sessions);
      const good = join(sessions, 'rollout-good.jsonl');
      const damaged = join(sessions, 'rollout-damaged.jsonl.zst');
      const bytes = Buffer.concat([body(), Buffer.from(JSON.stringify({
        timestamp: '2026-10-19T00:00:00.000Z', type: 'event_msg',
        payload: { type: 'agent_message', message: 'Verified continuation.' },
      }) + '\n')]);
      await writeFile(good, bytes);
      await writeFile(damaged, Buffer.concat([zstdCompressSync(body()), Buffer.from('bad trailing frame')]));
      await utimes(damaged, new Date(damagedDate), new Date(damagedDate));
      const db = new DatabaseSync(join(root, 'state_5.sqlite'));
      db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)');
      db.prepare('INSERT INTO threads VALUES (?, ?)').run('compressed-session', damaged);
      db.close();
      const found = await codexSessionAdapter.discover({ root: sessions, refresh: true });
      assert.equal(found.items.length, 1);
      const selected = found.items[0]!;
      assert.equal(await realpath(selected.sourcePath), await realpath(good));
      assert.equal(selected.availability, 'indexed');
      assert.equal(selected.recoveryReadiness, 'verified');
      assert.equal(selected.signals.userMessages, 1);
      assert.equal(found.diagnostics.some((item) => item.code === 'decompression-failed'), true);
      const imported = await codexSessionAdapter.import(selected);
      assert.equal(imported.baseline.finalMessage, 'Verified continuation.');
      const frozen = await freezeCase(imported, join(root, 'cases'), { allowModelText: true, allowBinary: false, redactions: [] }, '2026-10-21T00:00:00.000Z');
      assert.equal((await readFile(join(root, 'cases', frozen.taskCase.caseId, 'raw/session.jsonl'))).equals(bytes), true);
    });
  }
});
