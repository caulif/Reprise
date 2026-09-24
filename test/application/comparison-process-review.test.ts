import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedProcesses } from "../../src/infrastructure/managed-processes.js";
import { sanitizedEnvironment } from "../../src/infrastructure/recovery-workspace-tools.js";

test("managed process cursors preserve multibyte output and cannot address another attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-process-review-"));
  const work = join(root, "work");
  await mkdir(work);
  const env = sanitizedEnvironment(work);
  const first = new ManagedProcesses(join(root, "first"), work, env);
  const second = new ManagedProcesses(join(root, "second"), work, env);
  t.after(async () => {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await first.start('node -e "process.stdout.write(String.fromCodePoint(0x4e2d,0x1f642).repeat(7))"');
  await assert.rejects(second.poll(started.taskId, { stdout: 0, stderr: 0 }), /Unknown|attempt/i);
  const deadline = Date.now() + 10000;
  let state = await first.poll(started.taskId, { stdout: 0, stderr: 0 });
  while (state.status === "running" && Date.now() < deadline) {
    await delay(20);
    state = await first.poll(started.taskId, { stdout: 0, stderr: 0 });
  }
  assert.equal(state.status, "exited");
  assert.equal(state.exitCode, 0, state.stderr);
  const expected = "中🙂".repeat(7);
  assert.equal(state.stdout, expected);
  let cursor = { stdout: 0, stderr: 0 };
  let combined = "";
  for (let count = 0; count < 100; count += 1) {
    const part = await first.poll(started.taskId, cursor, 4);
    const replay = await first.poll(started.taskId, cursor, 4);
    assert.equal(replay.stdout, part.stdout);
    assert.deepEqual(replay.cursor, part.cursor);
    assert.doesNotMatch(part.stdout, /\uFFFD/);
    combined += part.stdout;
    if (!part.truncated) break;
    assert.ok(part.cursor.stdout > cursor.stdout, "cursor must progress without splitting a character");
    cursor = part.cursor;
  }
  assert.equal(combined, expected);
});
