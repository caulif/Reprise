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
const EXPERIMENT_APPLICATION_TURN_TIMEOUT_MS = 10 * 60_000;

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
        try {
          return await completeCodexTextTurn({
            options: this.#options,
            model: this.#model,
            effort: this.#effort,
            turnTimeoutMs: this.#turnTimeoutMs,
          }, { systemPrompt: input.systemPrompt, contextJson: content }, controller.signal);
        }
        finally { signal.removeEventListener('abort', abort); }
      },
      cancel: () => controller?.abort(),
    };
  }
}

type CodexTextTurnConfig = {
  options: CodexRuntimeOptions;
  model: string;
  effort: CodexReasoningEffort;
  turnTimeoutMs: number;
};

async function completeCodexTextTurn(
  config: CodexTextTurnConfig,
  input: { systemPrompt: string; contextJson: string },
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const executable = await discoverCodexExecutable(config.options);
  if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found for the Experiment Application.');
  const root = await mkdtemp(join(tmpdir(), 'reprise-experiment-application-'));
  const session = await startCodexTextTurn(config, input, executable, root);
  return finishCodexTextTurn(session, signal, config.turnTimeoutMs);
}

async function startCodexTextTurn(
  config: CodexTextTurnConfig,
  input: { systemPrompt: string; contextJson: string },
  executable: string,
  root: string,
): Promise<{
  client: CodexAppServerClient;
  root: string;
  completion: Promise<string>;
  threadId: string;
  turnId: string;
}> {
  /* eslint-disable prefer-const -- thread/turn ids are filled after start RPCs; the notification handler closes over them. */
  let threadId: string | undefined;
  let turnId: string | undefined;
  /* eslint-enable prefer-const */
  let finish: ((value: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let earlyCompletion: Record<string, unknown> | undefined;
  const completion = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const settleTurn = (turn: Record<string, unknown>) => {
    const settlement = codexSettlementStatus(text(turn.status));
    if (settlement !== 'completed' && settlement !== 'waiting_input') {
      fail?.(new CodexRuntimeUnavailableError(`Codex text turn ended as ${text(turn.status) ?? 'an unreported status'}.`));
      return;
    }
    finish?.(lastAgentMessage(turn.items) ?? '');
  };
  void completion.catch(() => undefined);
  const client = new CodexAppServerClient({
    executable,
    cwd: root,
    ...(config.options.env ? { env: config.options.env } : {}),
    ...(config.options.args ? { args: config.options.args } : {}),
    onClosed: (error) => fail?.(error),
    onNotification: async (method, params) => {
      if (method !== 'turn/completed') return;
      const payload = record(params);
      if (text(payload.threadId) !== threadId) return;
      const turn = record(payload.turn);
      if (!turnId) { earlyCompletion = turn; return; }
      if (text(turn.id) === turnId) settleTurn(turn);
    },
  });
  await client.start();
  const started = record(await client.request('thread/start', {
    model: config.model,
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
    model: config.model,
    effort: config.effort,
  }));
  turnId = text(record(startedTurn.turn).id);
  if (!turnId) throw new CodexRuntimeUnavailableError('Codex app-server turn/start response was incomplete.');
  if (earlyCompletion && text(earlyCompletion.id) === turnId) settleTurn(earlyCompletion);
  return { client, root, completion, threadId, turnId };
}

async function finishCodexTextTurn(
  session: { client: CodexAppServerClient; root: string; completion: Promise<string>; threadId: string; turnId: string },
  signal: AbortSignal,
  turnTimeoutMs: number,
): Promise<string> {
  let result: string | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    result = await raceWithAbort(withTimeout(session.completion, turnTimeoutMs), signal);
  } catch (error) {
    primaryError = error;
    try {
      await session.client.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
    } catch (interruptError) {
      cleanupError = interruptError;
    }
  }
  try {
    await session.client.close();
  } catch (closeError) {
    cleanupError ??= closeError;
  }
  try {
    await rm(session.root, { recursive: true, force: true });
  } catch (removeError) {
    cleanupError ??= removeError;
  }
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined && primaryError !== null) throw new Error("Codex text turn failed.");
  if (cleanupError instanceof Error) throw cleanupError;
  if (cleanupError !== undefined && cleanupError !== null) throw new Error("Codex text turn cleanup failed.");
  return result ?? '';
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
