import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { probeHarnessImageInput, readImageProbe } from '../../src/application/harness-image-probe.js';
import { runQueryCommand } from '../../src/cli/query.js';

const config = { schemaVersion: 2 as const, provider: { kind: 'pi-catalog' as const, id: 'fake' }, providerId: 'fake', modelId: 'vision', effort: 'medium' as const };

function fakeModels(input: string[], answer: 'image' | 'wrong' | 'failure', calls: unknown[]): PiModels {
  return {
    getModel: () => ({ id: 'vision', provider: 'fake', input, api: 'openai-completions', baseUrl: 'https://example.test/v1', contextWindow: 128_000, maxTokens: 4096 }),
    getAuth: async () => ({ auth: { apiKey: 'test-only-secret' } }),
    completeSimple: async (_model: unknown, context: { messages: { content: { type: string; data?: string; text?: string }[] }[] }, options: { maxRetries: number }) => {
      calls.push(context);
      assert.equal(options.maxRetries, 0);
      if (answer === 'failure') throw new Error('upstream failed with test-only-secret');
      const blocks = context.messages[0]!.content;
      const png = Buffer.from(blocks.find((block) => block.type === 'image')!.data!, 'base64');
      const length = png.readUInt32BE(33);
      const row = inflateSync(png.subarray(41, 41 + length));
      const colors = Array.from({ length: 4 }, (_, index) => {
        const rgb = [...row.subarray(1 + index * 60, 4 + index * 60)].join(',');
        return ({ '255,0,0': 'red', '0,200,0': 'green', '0,0,255': 'blue', '255,255,0': 'yellow' } as Record<string, string>)[rgb];
      }).join(',');
      assert.ok(!blocks.filter((block) => block.type === 'text').some((block) => block.text?.includes(colors)));
      return { stopReason: 'stop', content: [{ type: 'text', text: answer === 'image' ? colors : 'wrong' }] };
    },
  } as unknown as PiModels;
}

test('image probe validates native pixels, mismatches and failures without retaining responses or secrets', async () => {
  for (const [answer, expected] of [['image', 'passed'], ['wrong', 'answer_mismatch'], ['failure', 'provider_failure']] as const) {
    const calls: unknown[] = [];
    const caller = new PiModelCaller(config, fakeModels(['text', 'image'], answer, calls));
    const result = await caller.probeImageInput();
    assert.equal(result.status, expected);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /test-only-secret|base64|expected|response/);
    assert.notEqual(caller.modelSnapshot.configFingerprint, new PiModelCaller({ ...config, effort: 'high' }, fakeModels(['text', 'image'], answer, [])).modelSnapshot.configFingerprint);
  }
});

test('text-only and cancelled probes cannot issue a request', async () => {
  const calls: unknown[] = [];
  assert.equal((await new PiModelCaller(config, fakeModels(['text'], 'image', calls)).probeImageInput()).status, 'unsupported');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(new PiModelCaller(config, fakeModels(['text', 'image'], 'image', calls)).probeImageInput(abort.signal), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('application image probe requires opt-in before config access and reports untested status offline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.REPRISE_RUN_IMAGE_PROBE;
  delete process.env.REPRISE_RUN_IMAGE_PROBE;
  try {
    await assert.rejects(probeHarnessImageInput(root), /REPRISE_RUN_IMAGE_PROBE=1/);
    assert.deepEqual(await readImageProbe(root), { status: 'not_tested' });
    const output: string[] = [];
    const io = { stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { output.push(text); } };
    assert.equal(await runQueryCommand('config', ['image-status', '--data-dir', root], io), 0);
    assert.match(output.join(''), /not_tested/);
    assert.equal(await runQueryCommand('config', ['test-image', '--data-dir', root], io), 2);
    assert.match(output.join(''), /REPRISE_RUN_IMAGE_PROBE/);
  } finally {
    if (original === undefined) delete process.env.REPRISE_RUN_IMAGE_PROBE;
    else process.env.REPRISE_RUN_IMAGE_PROBE = original;
  }
});
