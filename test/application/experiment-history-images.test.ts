import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink } from '../../src/application/experiment-helpers.js';
import { readCommittedExperimentHistory } from '../../src/application/experiment-history-read.js';

test('History resolves each session attachment in its own run without changing disk state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'experiment-images');
  await store.acquireWriter();
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
  for (const runId of ['run-first', 'run-second']) {
    const host = new AgentHost({ inputCapabilities: ['text', 'image'], createSession: () => ({
      inputCapabilities: ['text', 'image'], append: async () => '{"ok":true}', cancel() {},
    }) });
    const result = await host.request({ role: 'comparison', systemPrompt: 'Inspect', allowModelText: true, schema: Type.Object({ ok: Type.Boolean() }),
      timeoutMs: 0, maxRepairAttempts: 0, promptContent: 'x'.repeat(9_000), promptImages: [image],
      audit: experimentAgentAuditSink(store, runId) });
    assert.equal(result.status, 'completed');
  }
  await store.close();
  const logBefore = await readFile(join(root, 'events.jsonl'));
  const artifactFiles = await readdir(join(root, 'runs', 'run-second', 'artifacts'));
  const manifests = await Promise.all(artifactFiles.filter((name) => name.endsWith('.json')).map(async (name) => ({ name,
    manifest: JSON.parse(await readFile(join(root, 'runs', 'run-second', 'artifacts', name), 'utf8')) as { artifactId: string; byteLength: number } })));
  const imageManifest = manifests.find((entry) => entry.manifest.byteLength === Buffer.byteLength(image.data, 'base64'));
  assert.ok(imageManifest);
  const imageArtifact = imageManifest.manifest.artifactId;
  await writeFile(join(root, 'writer.lock'), 'active writer; History must leave this alone');
  const directoryBefore = await readdir(root, { recursive: true });
  const good = await readCommittedExperimentHistory(root, 'experiment-images');
  assert.equal(good.incompleteModelInput, false);
  assert.equal(good.diagnosticCode, undefined);
  assert.deepEqual(await readdir(root, { recursive: true }), directoryBefore);
  assert.deepEqual(await readFile(join(root, 'events.jsonl')), logBefore);
  assert.equal(await readFile(join(root, 'writer.lock'), 'utf8'), 'active writer; History must leave this alone');
  const truncated = `${logBefore.toString('utf8')}{"schemaVersion":1`;
  await writeFile(join(root, 'events.jsonl'), truncated);
  const interrupted = await readCommittedExperimentHistory(root, 'experiment-images');
  assert.equal(interrupted.incompleteModelInput, false);
  assert.equal(interrupted.diagnosticCode, 'incomplete_tail');
  assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), truncated);
  await writeFile(join(root, 'events.jsonl'), logBefore);
  const path = join(root, 'runs', 'run-second', 'artifacts', imageArtifact);
  await writeFile(path, 'corrupt');
  const corrupt = await readCommittedExperimentHistory(root, 'experiment-images');
  assert.equal(corrupt.incompleteModelInput, true);
  assert.equal(corrupt.diagnosticCode, 'attachment_checksum');
  await rm(path);
  const missing = await readCommittedExperimentHistory(root, 'experiment-images');
  assert.equal(missing.incompleteModelInput, true);
  assert.equal(missing.diagnosticCode, 'missing_attachment');
  assert.deepEqual(await readFile(join(root, 'events.jsonl')), logBefore);
});

test('History does not create a missing experiment directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readCommittedExperimentHistory(join(root, 'not-created')), {
    runStatus: 'unknown', incompleteModelInput: false, legacyRequestComplete: false,
  });
  assert.deepEqual(await readdir(root), []);
});
