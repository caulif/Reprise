import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewindIsolatedWorkspaceToStart, sessionWritePaths } from '../src/application/session-start-workspace.js';
import type { TaskCase } from '../src/core/schema.js';

function caseWithWrites(cwd: string, paths: readonly string[]): TaskCase {
  return {
    schemaVersion: 1,
    caseId: 'case-1',
    source: { productId: 'claude-code', sessionId: 'session-1' },
    initialInput: { id: 'message-1', role: 'user', text: 'Organize papers.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Organize papers.' }],
    historicalEvents: [],
    baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'claude-code', artifactRefs: [] },
    taskContext: { historicalCwd: cwd, historicalBehavior: { commands: [], touchedPaths: paths } },
    provenance: { packVersion: 'fixture', importedAt: '2026-08-14T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: 'b'.repeat(64),
  };
}

test('session write paths relativize historical absolute writes and reject escapes', () => {
  const cwd = String.raw`C:\obsidian\papers`;
  const paths = sessionWritePaths(caseWithWrites(cwd, [
    String.raw`C:\obsidian\papers\kimi-k3\README.md`,
    'notes/index.md',
    String.raw`C:\Windows\System32\evil.dll`,
    '../outside.txt',
  ]), cwd);
  assert.deepEqual(paths, ['kimi-k3/README.md', 'notes/index.md']);
});

test('rewind removes historical writes from the isolated replica only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-start-rewind-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const replica = join(root, 'replica');
  await mkdir(join(replica, 'kimi-k3'), { recursive: true });
  await writeFile(join(replica, 'kimi-k3', 'README.md'), 'historical result\n');
  await writeFile(join(replica, 'keep.txt'), 'pre-task\n');
  const result = await rewindIsolatedWorkspaceToStart({
    workspaceRoot: replica,
    taskCase: caseWithWrites(replica, ['kimi-k3/README.md']),
    historicalCwd: replica,
  });
  assert.deepEqual(result.removed, ['kimi-k3/README.md']);
  await assert.rejects(readFile(join(replica, 'kimi-k3', 'README.md')));
  assert.equal(await readFile(join(replica, 'keep.txt'), 'utf8'), 'pre-task\n');
});
