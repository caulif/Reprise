import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TargetRunner } from "../src/core/runtime.js";
import { CodexRuntimePort } from "../src/products/codex/runtime-port.js";

export const fixturePath = new URL(
  "./fixtures/codex-session.fixture.json",
  import.meta.url,
);
const execFileAsync = promisify(execFile);
export const FAKE_APP_SERVER = `
const status = process.argv[2];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 'approval-1' && message.error) send({ method: 'server/rejection_observed', params: { id: message.id, error: message.error } });
    if (message.method === 'initialize' && status === 'server_request') send({ id: 'approval-1', method: 'item/commandExecution/request', params: { command: 'echo test' } });
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'test-model' } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      if (status === 'exit') setTimeout(() => process.exit(1), 10);
      else if (status !== 'never' && status !== 'interrupt_failed') send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status, items: [{ type: 'agentMessage', text: 'Done.' }] } } });
    } else if (message.method === 'turn/interrupt' && status === 'interrupt_failed') {
      send({ id: message.id, error: { code: -32001, message: 'interrupt failed' } });
    } else if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method !== undefined) send({ id: message.id, result: {} });
  }
});
`;

export async function fakeCodexRunner(
  t: { after(fn: () => Promise<unknown>): void },
  status: string,
): Promise<{ runner: TargetRunner; events: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "reprise-fake-app-server-"));
  const script = join(root, "fake-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  const runtime = new CodexRuntimePort({ args: [script, status] });
  const events: string[] = [];
  const runner = await runtime.createRunner(
    {
      productId: "codex",
      executable: process.execPath,
      requestedModel: "test-model",
      resolvedModel: "unknown",
    },
    { environmentId: "environment-run-1", runId: "run-1", root },
    {
      append: async (event) => {
        events.push(event.type);
      },
    },
  );
  t.after(async () => runner.stop("shutdown"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { runner, events };
}
export async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    cwd,
    "rev-parse",
    "HEAD",
  ]);
  return stdout.trim();
}
export function timeoutAfter<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
