import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';
import { hostNodeCommand } from '../host-shell.js';

for (const mode of ['success', 'cancel', 'hard', 'provider-failure'] as const) {
  test(`default autonomous readonly denial and real scratch correction preserve ${mode}`, async t => {
    const abort = new AbortController();
    const correction = process.platform === 'win32' ? "Set-Content corrected.txt 'Corrected in writable scratch'" : "printf '%s\\n' 'Corrected in writable scratch' > corrected.txt";
    const forbidden = 'rm finals/policy-denial-sentinel.txt';
    const steps = [{ name: 'exec_command', arguments: { cmd: forbidden }, error: true },
      { name: 'exec_command', arguments: { cmd: correction } }, ...publicationSteps()];
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
    assert.ok(f.events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'exec_command' && event.payload.nativeHook === 'after' && event.payload.isError === true));
    assert.ok(f.events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'exec_command' && !event.payload.nativeHook
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

test('formal Comparison yields, recovers process preconditions, polls nonzero exit and seals its log before publication', async t => {
  const poll = { session_id: '', chars: 'continue\n', yield_time_ms: 10_000 };
  const steps = [
    { name: 'exec_command', arguments: { cmd: 'chrome --headless --dump-dom report.html' } },
    { name: 'exec_command', arguments: { cmd: hostNodeCommand("process.stdin.once('data', () => { console.log('verification-failed'); process.exit(7); });"), yield_time_ms: 0 } },
    { name: 'write_stdin', arguments: { session_id: 'unknown', yield_time_ms: 0 }, error: true },
    { name: 'write', arguments: { path: 'scratch/busy.txt', content: 'not written' }, error: true },
    { name: 'write_stdin', arguments: poll },
    ...publicationSteps(),
  ];
  const f = await runAutonomousPublication(t, { steps, onGeneration: (context, index) => {
    if (index === 1) assert.match(JSON.stringify(context.messages.at(-1)), /browser_shell_denied/);
    if (index === 2) {
      const result = context.messages.at(-1)!;
      assert.equal(result.role, 'toolResult');
      const block = result.content[0]!;
      assert.equal(block.type, 'text');
      if (block.type === 'text') {
        const receipt = JSON.parse(block.text) as { state: string; session_id: string };
        assert.equal(receipt.state, 'running'); poll.session_id = receipt.session_id;
      }
    }
    if (index === 3) assert.match(JSON.stringify(context.messages.at(-1)), /unknown, expired/);
    if (index === 4) assert.match(JSON.stringify(context.messages.at(-1)), /owns this workspace/);
    if (index === 5) assert.match(JSON.stringify(context.messages.at(-1)), /verification-failed/);
  } });
  assert.equal(f.result.comparison.result.status, 'completed', JSON.stringify(f.result.comparison));
  const finished = f.events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'write_stdin' && !event.payload.nativeHook);
  assert.ok(finished);
  assert.equal(typeof (finished.payload.details as { exitCode: number }).exitCode, 'number');
  assert.notEqual((finished.payload.details as { exitCode: number }).exitCode, 0);
  const log = f.events.find(event => event.type === 'artifact.created' && String(event.payload.artifactId).startsWith('comparison-process-'));
  assert.ok(log, 'Process log is committed to the experiment');
  assert.ok(log.sequence < finished.sequence, 'Log is committed before its final receipt');
  assert.ok(f.events.some(event => event.type === 'report.created' && event.sequence > log.sequence));
  await assert.rejects(readFile(join(f.attemptRoot, 'scratch', 'busy.txt')), { code: 'ENOENT' });
});

for (const mode of ['unfinished', 'cancelled'] as const) {
  test(`formal Comparison drains a ${mode} managed command and does not publish success`, async t => {
    const abort = new AbortController();
    const f = await runAutonomousPublication(t, { signal: abort.signal,
      steps: [{ name: 'exec_command', arguments: { cmd: hostNodeCommand('setInterval(() => {}, 1000)'), yield_time_ms: 0 } }],
      onGeneration: (_context, index) => { if (index === 1 && mode === 'cancelled') abort.abort(); },
    });
    assert.equal(f.result.comparison.result.status, mode === 'cancelled' ? 'cancelled' : 'failed', JSON.stringify(f.result.comparison));
    assert.equal(f.renders, 0);
    assert.ok(f.events.some(event => event.type === 'artifact.created' && String(event.payload.artifactId).startsWith('comparison-process-')));
    await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
  });
}
