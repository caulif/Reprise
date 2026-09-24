import { randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { writeAtomic } from "../core/identity.js";
import { redactModelVisibleText } from "./agent/model-input.js";
import { shellInvocation, terminateProcessTree } from "./platform.js";
import { spawnRuntimeProcess } from "./process/spawn.js";

const MAX_TASKS = 4;
const MAX_OUTPUT_BYTES = 1_048_576;

type StreamState = { decoder: StringDecoder; text: string; bytes: number; path: string; visibleBytes: number };
type Task = {
  child: ChildProcess;
  stdout: StreamState;
  stderr: StreamState;
  status: "running" | "exited" | "failed" | "stopped";
  exitCode: number | undefined;
  failure?: string;
  pending: Promise<void>;
  closed: Promise<void>;
};

export class ManagedProcesses {
  readonly #root: string;
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #tasks = new Map<string, Task>();
  #closing = false;

  constructor(root: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.#root = root;
    this.#cwd = cwd;
    this.#env = env;
  }

  async start(command: string, signal?: AbortSignal): Promise<{ taskId: string; status: string }> {
    if (this.#closing || signal?.aborted) throw new Error("Managed process attempt is closing or cancelled.");
    if (!command.trim() || command.length > 8192) throw new Error("Managed process command is empty or too long.");
    if ([...this.#tasks.values()].filter((task) => task.status === "running").length >= MAX_TASKS) throw new Error("Managed process task limit reached.");
    if (this.#tasks.size >= 16) throw new Error("Managed process lifetime task limit reached.");
    const taskId = randomUUID();
    const taskRoot = join(this.#root, taskId);
    const stdout: StreamState = { decoder: new StringDecoder("utf8"), text: "", bytes: 0,
      path: join(taskRoot, "stdout.txt"), visibleBytes: 0 };
    const stderr: StreamState = { decoder: new StringDecoder("utf8"), text: "", bytes: 0,
      path: join(taskRoot, "stderr.txt"), visibleBytes: 0 };
    await Promise.all([writeAtomic(stdout.path, ""), writeAtomic(stderr.path, "")]);
    if (this.#closing || signal?.aborted) throw new Error("Managed process attempt is closing or cancelled.");
    const invocation = shellInvocation(command, this.#env);
    const child = spawnRuntimeProcess(invocation.executable, invocation.args, {
      cwd: this.#cwd, env: this.#env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const task: Task = { child, stdout, stderr, status: "running", exitCode: undefined, pending: Promise.resolve(), closed };
    this.#tasks.set(taskId, task);
    const append = (stream: StreamState, chunk: Buffer) => {
      stream.bytes += chunk.byteLength;
      if (task.stdout.bytes + task.stderr.bytes > MAX_OUTPUT_BYTES) {
        task.failure = "output_limit_exceeded";
        task.status = "failed";
        terminateProcessTree(child, true);
        return;
      }
      task.pending = task.pending.then(async () => {
        stream.text += stream.decoder.write(chunk);
        const boundary = stream.text.lastIndexOf("\n") + 1;
        if (!boundary) return;
        const complete = stream.text.slice(0, boundary);
        if (/(?:authorization|api[_-]?key|token|password|secret)\s*[=:]\s*$|Bearer\s*$/i.test(complete)) return;
        stream.text = stream.text.slice(boundary);
        const visible = redactModelVisibleText(complete).text;
        await appendFile(stream.path, visible);
        stream.visibleBytes += Buffer.byteLength(visible);
      }).catch((error) => {
        task.failure = `output_io_failed:${error instanceof Error ? error.name : "unknown"}`;
        task.status = "failed";
        terminateProcessTree(child, true);
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => { task.status = "failed"; task.failure = `spawn_failed:${error.name}`; resolveClosed(); });
    child.on("close", (code) => {
      task.pending = task.pending.then(async () => {
        for (const stream of [stdout, stderr]) {
          stream.text += stream.decoder.end();
          const visible = redactModelVisibleText(stream.text).text;
          await appendFile(stream.path, visible);
          stream.visibleBytes += Buffer.byteLength(visible);
          stream.text = "";
        }
      }).catch((error) => { task.status = "failed"; task.failure = `output_io_failed:${error instanceof Error ? error.name : "unknown"}`; });
      void task.pending.then(() => {
        if (task.status === "running") task.status = "exited";
        task.exitCode = code ?? undefined;
        resolveClosed();
      });
    });
    if (this.#closing || signal?.aborted) this.stop(taskId);
    return { taskId, status: task.status };
  }

  async poll(taskId: string, cursor: { stdout: number; stderr: number }, maxBytes = 16_384): Promise<{
    status: string; exitCode?: number; failure?: string; stdout: string; stderr: string;
    cursor: { stdout: number; stderr: number }; truncated: boolean;
    stdoutPath: string; stderrPath: string;
  }> {
    const task = this.#task(taskId);
    if (maxBytes < 1 || maxBytes > 65_536) throw new Error("Managed process maxBytes is out of range.");
    await task.pending;
    const [out, err] = await Promise.all([
      readChunk(task.stdout.path, cursor.stdout, task.stdout.visibleBytes, maxBytes),
      readChunk(task.stderr.path, cursor.stderr, task.stderr.visibleBytes, maxBytes),
    ]);
    return { status: task.status, ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.failure ? { failure: task.failure } : {}), stdout: out.text, stderr: err.text,
      cursor: { stdout: out.next, stderr: err.next },
      truncated: out.next < task.stdout.visibleBytes || err.next < task.stderr.visibleBytes || task.failure === "output_limit_exceeded",
      stdoutPath: `scratch/process/${taskId}/stdout.txt`, stderrPath: `scratch/process/${taskId}/stderr.txt` };
  }

  stop(taskId: string): void {
    const task = this.#task(taskId);
    if (task.status === "exited" || task.status === "stopped") return;
    task.status = "stopped";
    terminateProcessTree(task.child, true);
  }

  async close(): Promise<void> {
    if (this.#closing && this.#tasks.size === 0) return;
    this.#closing = true;
    for (const [id, task] of this.#tasks) if (task.status !== "exited") this.stop(id);
    await Promise.all([...this.#tasks.values()].map(async (task) => {
      await task.closed;
      await task.pending;
    }));
    this.#tasks.clear();
  }

  #task(taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error("Unknown managed taskId for this comparison attempt.");
    return task;
  }
}

async function readChunk(path: string, cursor: number, total: number, maxBytes: number): Promise<{ text: string; next: number }> {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total) throw new Error("Managed process cursor is invalid.");
  const size = Math.min(Math.max(4, maxBytes), total - cursor);
  const bytes = Buffer.alloc(size);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(bytes, 0, size, cursor);
    for (let count = bytesRead; count >= 0; count -= 1) {
      try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)), next: cursor + count }; }
      catch { /* Try the previous UTF-8 boundary; the next poll rereads excluded bytes. */ }
    }
    throw new Error("Managed process output is not valid UTF-8.");
  } finally {
    await handle.close();
  }
}
