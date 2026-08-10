import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiTextCaller } from '../../infrastructure/pi-agent-host.js';
import {
  CodexAppServerClient,
  CodexRuntimeUnavailableError,
  discoverCodexExecutable,
  type CodexReasoningEffort,
  type CodexRuntimeOptions,
} from './runtime-port.js';

type JsonRecord = Record<string, unknown>;

export const EXPERIMENT_APPLICATION_MODEL = 'gpt-5.6-terra';
export const EXPERIMENT_APPLICATION_EFFORT: CodexReasoningEffort = 'medium';

/**
 * A text-only Experiment Application caller backed by the current Codex app-server.
 * Each request gets an ephemeral, empty, read-only thread and never approves tools.
 */
export class CodexTextCaller implements PiTextCaller {
  readonly #options: CodexRuntimeOptions;
  readonly #model: string;
  readonly #effort: CodexReasoningEffort;

  constructor(input: { options?: CodexRuntimeOptions; model?: string; effort?: CodexReasoningEffort } = {}) {
    this.#options = input.options ?? {};
    this.#model = input.model ?? EXPERIMENT_APPLICATION_MODEL;
    this.#effort = input.effort ?? EXPERIMENT_APPLICATION_EFFORT;
  }

  async complete(input: { systemPrompt: string; contextJson: string; repair?: string; capabilities: readonly string[] }, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError();
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found for the Experiment Application.');
    const root = await mkdtemp(join(tmpdir(), 'reprise-experiment-application-'));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finish: ((value: string) => void) | undefined;
    const completion = new Promise<string>((resolve) => { finish = resolve; });
    const client = new CodexAppServerClient({
      executable,
      cwd: root,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      onNotification: async (method, params) => {
        if (method !== 'turn/completed') return;
        const payload = record(params);
        if (text(payload.threadId) !== threadId) return;
        const turn = record(payload.turn);
        if (text(turn.id) !== turnId) return;
        finish?.(lastAgentMessage(turn.items) ?? '');
      },
    });
    try {
      await client.start();
      const started = record(await client.request('thread/start', {
        model: this.#model,
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        threadSource: 'reprise',
        developerInstructions: input.systemPrompt,
      }));
      threadId = text(record(started.thread).id);
      if (!threadId) throw new CodexRuntimeUnavailableError('Codex app-server thread/start response was incomplete.');
      const startedTurn = record(await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: message(input), text_elements: [] }],
        model: this.#model,
        effort: this.#effort,
      }));
      turnId = text(record(startedTurn.turn).id);
      if (!turnId) throw new CodexRuntimeUnavailableError('Codex app-server turn/start response was incomplete.');
      return await raceWithAbort(completion, signal);
    } catch (error) {
      if (signal.aborted && threadId && turnId) await client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      throw error;
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

function message(input: { contextJson: string; repair?: string }): string {
  return `${input.repair ? `${input.repair}\n\n` : ''}Use only this JSON context:\n${input.contextJson}`;
}

function lastAgentMessage(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of [...items].reverse()) {
    const recordItem = record(item);
    if (recordItem.type === 'agentMessage' && text(recordItem.text)) return text(recordItem.text);
  }
  return undefined;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function abortError(): Error { const error = new Error('Codex text request was aborted.'); error.name = 'AbortError'; return error; }
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): JsonRecord { return isRecord(value) ? value : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
