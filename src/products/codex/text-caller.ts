import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, text } from '../../core/json.js';
import type { AgentToolDefinition, PiTextCaller, PiTextSession } from '../../infrastructure/pi-agent-host.js';
import {
  CodexAppServerClient,
  CodexRuntimeUnavailableError,
  codexSettlementStatus,
  discoverCodexExecutable,
  type CodexReasoningEffort,
  type CodexRuntimeOptions,
} from './runtime-port.js';

export const EXPERIMENT_APPLICATION_MODEL = 'gpt-5.6-terra';
export const EXPERIMENT_APPLICATION_EFFORT: CodexReasoningEffort = 'medium';
export const EXPERIMENT_APPLICATION_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * A text-only Experiment Application caller backed by the current Codex app-server.
 * Each request gets an ephemeral, empty, read-only thread and never approves tools.
 */
export class CodexTextCaller implements PiTextCaller {
  readonly #options: CodexRuntimeOptions;
  readonly #model: string;
  readonly #effort: CodexReasoningEffort;
  readonly #turnTimeoutMs: number;

  constructor(input: { options?: CodexRuntimeOptions; model?: string; effort?: CodexReasoningEffort; turnTimeoutMs?: number } = {}) {
    this.#options = input.options ?? {};
    this.#model = input.model ?? EXPERIMENT_APPLICATION_MODEL;
    this.#effort = input.effort ?? EXPERIMENT_APPLICATION_EFFORT;
    this.#turnTimeoutMs = Number.isInteger(input.turnTimeoutMs) && (input.turnTimeoutMs ?? 0) > 0
      ? (input.turnTimeoutMs as number)
      : EXPERIMENT_APPLICATION_TURN_TIMEOUT_MS;
  }

  createSession(input: { sessionId: string; systemPrompt: string; tools: readonly AgentToolDefinition[] }): PiTextSession {
    if (input.tools.length > 0) throw new Error('CodexTextCaller cannot expose Host tools through the app-server protocol.');
    let controller: AbortController | undefined;
    return {
      append: async ({ content, signal }) => {
        if (signal.aborted) throw abortError();
        controller = new AbortController();
        const abort = () => controller?.abort();
        signal.addEventListener('abort', abort, { once: true });
        try { return await this.#complete({ systemPrompt: input.systemPrompt, contextJson: content }, controller.signal); }
        finally { signal.removeEventListener('abort', abort); }
      },
      cancel: () => controller?.abort(),
    };
  }

  async #complete(input: { systemPrompt: string; contextJson: string }, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError();
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found for the Experiment Application.');
    const root = await mkdtemp(join(tmpdir(), 'reprise-experiment-application-'));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finish: ((value: string) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    let earlyCompletion: Record<string, unknown> | undefined;
    const completion = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    const settleTurn = (turn: Record<string, unknown>) => {
      const settlement = codexSettlementStatus(text(turn.status));
      // Without this an interrupted or failed turn would be reported to the Agent as an empty answer.
      if (settlement !== 'completed' && settlement !== 'waiting_input') {
        fail?.(new CodexRuntimeUnavailableError(`Codex text turn ended as ${text(turn.status) ?? 'an unreported status'}.`));
        return;
      }
      finish?.(lastAgentMessage(turn.items) ?? '');
    };
    // Startup can fail before anything awaits this promise; the close signal must not surface as an unhandled rejection.
    void completion.catch(() => undefined);
    const client = new CodexAppServerClient({
      executable,
      cwd: root,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
      // Completion arrives as a notification, so a dead process would otherwise never settle this call.
      onClosed: (error) => fail?.(error),
      onNotification: async (method, params) => {
        if (method !== 'turn/completed') return;
        const payload = record(params);
        if (text(payload.threadId) !== threadId) return;
        const turn = record(payload.turn);
        // JSONL response and notification frames can arrive in the same stream chunk. Keep the
        // terminal notification until turn/start supplies its id instead of losing fast failures.
        if (!turnId) { earlyCompletion = turn; return; }
        if (text(turn.id) === turnId) settleTurn(turn);
      },
    });
    let result: string | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;
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
      if (earlyCompletion && text(earlyCompletion.id) === turnId) settleTurn(earlyCompletion);
      result = await raceWithAbort(withTimeout(completion, this.#turnTimeoutMs), signal);
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
      // A turn left running after an abort or timeout keeps burning the operator's budget.
      if (threadId && turnId) {
        try {
          await client.request('turn/interrupt', { threadId, turnId });
        } catch (interruptError) {
          cleanupError = interruptError;
          hasCleanupError = true;
        }
      }
    }
    try {
      await client.close();
    } catch (closeError) {
      if (!hasCleanupError) {
        cleanupError = closeError;
        hasCleanupError = true;
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (removeError) {
      if (!hasCleanupError) {
        cleanupError = removeError;
        hasCleanupError = true;
      }
    }
    if (hasPrimaryError) throw primaryError;
    if (hasCleanupError) throw cleanupError;
    return result ?? '';
  }
}

function message(input: { contextJson: string }): string { return `Use only this JSON context:\n${input.contextJson}`; }

function lastAgentMessage(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const recordItem = record(items[index]);
    if (recordItem.type === 'agentMessage' && text(recordItem.text)) return text(recordItem.text);
  }
  return undefined;
}

/** turn/completed is a notification, not a response, so no RPC timeout covers it. */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodexRuntimeUnavailableError(`Codex text turn did not complete within ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
