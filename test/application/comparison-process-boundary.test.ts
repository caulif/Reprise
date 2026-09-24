import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedProcesses } from "../../src/infrastructure/managed-processes.js";
import { sanitizedEnvironment } from "../../src/infrastructure/recovery-workspace-tools.js";

test("managed process holds incomplete secrets and keeps issued cursors stable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-process-boundary-"));
  const releaseFile = join(root, "release");
  const env = sanitizedEnvironment(join(root, "home"));
  env.REPRISE_TEST_SECRET = "visible-only-in-managed-env";
  env.REPRISE_TEST_RELEASE_FILE = releaseFile;
  const processes = new ManagedProcesses(join(root, "tasks"), root, env);
  t.after(async () => { await processes.close(); await rm(root, { recursive: true, force: true }); });
  const script = "process.stdout.write('first\\napi_key=SE');const timer=setInterval(()=>{if(require('node:fs').existsSync(process.env.REPRISE_TEST_RELEASE_FILE)){clearInterval(timer);process.stdout.write('CRET\\nlast\\n')}},20)";
  const started = await processes.start(`node -e "${script}"`);
  let first = await processes.poll(started.taskId, { stdout: 0, stderr: 0 });
  const firstDeadline = Date.now() + 20_000;
  while (!first.stdout && first.status === "running" && Date.now() < firstDeadline) {
    await delay(20);
    first = await processes.poll(started.taskId, { stdout: 0, stderr: 0 });
  }
  assert.equal(first.stdout, "first\n");
  assert.doesNotMatch(first.stdout, /SE|key/i);
  await writeFile(releaseFile, "release");
  let completed = first;
  const deadline = Date.now() + 20_000;
  while (completed.status === "running" && Date.now() < deadline) {
    await delay(50);
    completed = await processes.poll(started.taskId, first.cursor);
  }
  assert.equal(completed.status, "exited");
  assert.equal(completed.stdout, "api_key=[REDACTED]\nlast\n");
  const replay = await processes.poll(started.taskId, { stdout: 0, stderr: 0 });
  assert.equal(replay.stdout, "first\napi_key=[REDACTED]\nlast\n");
});
