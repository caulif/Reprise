import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';

for (const mode of ['success', 'cancel', 'hard', 'provider-failure'] as const) {
  test(`default autonomous readonly denial and real scratch correction preserve ${mode}`, async t => {
    const abort = new AbortController();
    const correction = process.platform === 'win32' ? "Set-Content corrected.txt 'Corrected in writable scratch'" : "printf '%s\\n' 'Corrected in writable scratch' > corrected.txt";
    const forbidden = process.platform === 'win32' ? 'Set-Content finals/policy-denial-sentinel.txt denied' : 'echo denied > finals/policy-denial-sentinel.txt';
    const steps = [{ name: 'shell_exec', arguments: { command: forbidden }, error: true },
      { name: 'shell_exec', arguments: { command: correction } }, ...publicationSteps()];
    const f = await runAutonomousPublication(t, { steps, signal: abort.signal,
      ...(mode === 'hard' ? { budget: { callTimeoutMs: 5000, maxStructuredRepairAttempts: 0, comparisonResources: { maxToolCalls: 2 } } } : {}),
      onGeneration: (context, index) => {
      if (index === 1) assert.match(JSON.stringify(context.messages.at(-1)), /write_denied/);
      if (index === 2 && mode === 'cancel') abort.abort();
      if (index === 2 && mode === 'provider-failure') throw Object.assign(new Error('Provider unavailable after correction'), { status: 503 });
    } });
    assert.equal(f.result.comparison.result.status, mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(f.result.comparison));
    await assert.rejects(readFile(join(f.attemptRoot, 'finals', 'policy-denial-sentinel.txt')), { code: 'ENOENT' });
    assert.match(await readFile(join(f.attemptRoot, 'scratch', 'corrected.txt'), 'utf8'), /Corrected in writable scratch/);
    assert.ok(f.events.some(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('write_denied')));
    assert.ok(f.events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && event.payload.nativeHook === 'after' && event.payload.isError === true));
    assert.ok(f.events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'shell_exec' && !event.payload.nativeHook
      && typeof event.payload.details === 'object' && event.payload.details !== null && 'exitCode' in event.payload.details && event.payload.details.exitCode === 0));
    assert.equal(f.renders, mode === 'success' ? 1 : 0);
    if (mode === 'hard') {
      assert.ok(f.events.some(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('maxToolCalls')));
      assert.equal(f.events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'submit_report').length, 0);
      await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
    }
    if (mode === 'success') assert.match(await readFile(f.result.reportPath, 'utf8'), /Neither final output is confirmed usable/);
  });
}
