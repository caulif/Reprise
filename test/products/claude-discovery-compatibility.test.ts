import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionAdapter } from '../../src/products/packs/claude-code/sessions.js';
import { groupSessionsByProject } from '../../src/tui/pages/intake.js';

const cwd = 'C:/work/compatibility';
const timestamp = '2026-10-19T00:00:00.000Z';
const row = (sessionId: string) => ({ type: 'user', sessionId, cwd, timestamp, message: { role: 'user', content: 'Inspect compatibility.' } });
const history = (sessionId: string, display = 'Indexed task') => ({ sessionId, display, project: cwd, timestamp: 1 });

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const config = await mkdtemp(join(tmpdir(), 'reprise-claude-discovery-compat-'));
  t.after(async () => rm(config, { recursive: true, force: true }));
  const root = join(config, 'projects');
  const project = join(root, 'C--work-compatibility');
  await mkdir(project, { recursive: true });
  return { config, root, project };
}

test('Claude indexed history keeps known project grouping and separates missing body from unreadable body', async (t) => {
  const { config, root } = await fixture(t);
  await writeFile(join(config, 'history.jsonl'), [history('history-a'), history('history-b')].map((entry) => JSON.stringify(entry)).join('\n'));
  const page = await claudeSessionAdapter.discover({ root });
  assert.equal(page.items.length, 2);
  assert.equal(page.items.every((item) => item.evidenceLevel === 'history' && item.availability === 'catalog-only'), true);
  const projects = groupSessionsByProject(page.items);
  assert.equal(projects.filter((project) => project.sessions.length).length, 1);
  assert.equal(projects.find((project) => project.sessions.length)?.sessions.length, 2);
});

test('Claude discovery isolates malformed and invalid-time bodies, excludes agents and backups, and deduplicates large renamed bodies by internal ID', async (t) => {
  const { config, root, project } = await fixture(t);
  await mkdir(join(project, 'parent', 'subagents'), { recursive: true });
  await writeFile(join(project, 'broken.jsonl'), '{broken\n');
  await writeFile(join(project, 'invalid-time.jsonl'), JSON.stringify({ ...row('invalid-time'), timestamp: 'bad' }));
  await writeFile(join(project, 'renamed.jsonl'), JSON.stringify(row('large-body')) + '\n' + JSON.stringify({ type: 'attachment', content: 'x'.repeat(4 * 1024 * 1024) }) + '\n');
  await writeFile(join(project, 'parent', 'subagents', 'agent-child.jsonl'), JSON.stringify(row('parent')));
  await writeFile(join(project, 'agent-legacy.jsonl'), JSON.stringify(row('legacy')));
  await writeFile(join(project, 'copy.bak.jsonl'), JSON.stringify(row('backup')));
  await writeFile(join(config, 'history.jsonl'), [history('large-body'), history('renamed'), history('parent'), history('legacy'), history('indexed')].map((entry) => JSON.stringify(entry)).join('\n'));
  const page = await claudeSessionAdapter.discover({ root });
  assert.equal(page.items.filter((item) => item.sessionId === 'large-body').length, 1);
  assert.equal(page.items.find((item) => item.sessionId === 'large-body')?.partial, true);
  assert.equal(page.items.find((item) => item.sessionId === 'renamed')?.evidenceLevel, 'history');
  assert.equal(page.items.find((item) => item.sessionId === 'parent')?.evidenceLevel, 'history');
  assert.equal(page.items.find((item) => item.sessionId === 'legacy')?.evidenceLevel, 'history');
  assert.equal(page.items.some((item) => item.sessionId === 'backup'), false);
  assert.equal(page.items.filter((item) => item.recoveryDiagnostics?.some((diagnostic) => diagnostic.code === 'invalid-jsonl' || diagnostic.code === 'invalid-metadata')).length, 2);
  assert.equal(page.items.find((item) => item.sessionId === 'indexed')?.evidenceLevel, 'history');
  assert.ok(page.diagnostics.some((entry) => entry.code === 'invalid-jsonl'));
  assert.ok(page.diagnostics.some((entry) => entry.code === 'invalid-metadata'));
});

test('Claude history streams beyond the old total budget and preserves entries before a damaged tail', async (t) => {
  const { config, root } = await fixture(t);
  const entries = Array.from({ length: 600 }, (_, index) => history(`history-${index}`, `${index}: ${'x'.repeat(8_000)}`));
  await writeFile(join(config, 'history.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{damaged');
  const page = await claudeSessionAdapter.discover({ root });
  assert.equal(page.items.length, 600);
  assert.ok(page.diagnostics.some((entry) => entry.code === 'invalid-jsonl'));
  assert.ok(page.items.some((item) => item.sessionId === 'history-599'));
  const signal = AbortSignal.abort();
  await assert.rejects(claudeSessionAdapter.discover({ root, signal }), { name: 'AbortError' });
});
