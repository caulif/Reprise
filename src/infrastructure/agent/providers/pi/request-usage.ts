import { randomUUID } from 'node:crypto';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { failedRequestUsage } from './usage-estimate.js';
import type { AgentUsageFacts } from '../../../../core/schema.js';
import type { ProviderAdapter } from '../../types.js';
import { sha256 } from '../../../../core/identity.js';
import type { PiModels } from './adapter.js';
import { redactModelVisibleValue } from '../../model-input.js';
import { observePiFailure } from './yield-deadline.js';

type Hooks = Parameters<ProviderAdapter['createSession']>[0];

export function piRequestUsage(source: PiModels, input: Pick<Hooks, 'onModelUsage' | 'onModelRequest' | 'onModelStream' | 'onModelUsageEstimated'>, onFailure?: (error: unknown) => void, onProviderFailure = onFailure, outputCeiling?: () => number | undefined) {
  const pending: Promise<void>[] = [];
  let auditFailed = false;
  let auditFailure: unknown;
  const flush = async (alreadyReported?: { failure: unknown }) => {
    const tasks = [...pending];
    const results = await Promise.allSettled(tasks);
    for (const task of tasks) {
      const index = pending.indexOf(task);
      if (index >= 0) void pending.splice(index, 1);
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      auditFailed = true;
      auditFailure = failure.reason;
    }
    if (failure?.status === 'rejected' || (auditFailed && (!alreadyReported || auditFailure !== alreadyReported.failure))) throw auditFailure;
  };
  const report = async (message: AssistantMessage, scope: AgentUsageFacts['scope'], requestId: string, context: Context, signal?: AbortSignal) => {
    const responseFailure = scope === 'generation' ? onProviderFailure : onFailure;
    if (message.stopReason === 'error') responseFailure?.(new Error(message.errorMessage ?? 'Provider response failed.'));
    if (message.stopReason === 'aborted' && !signal?.aborted) responseFailure?.(new Error(message.errorMessage ?? 'Provider response aborted independently.'));
    // Pinned SDK failure messages initialize usage to zero before any provider usage arrives; these zeros are not a bill.
    if ((message.stopReason === 'error' || message.stopReason === 'aborted')
      && [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite, message.usage.totalTokens].every(count => count === 0)) {
      const estimate = failedRequestUsage(requestId, message.model, context, scope, message);
      if (estimate) await observePiFailure(() => input.onModelUsageEstimated?.(estimate), error => { auditFailed = true; auditFailure = error; onFailure?.(error); });
      return;
    }
    try {
      await input.onModelUsage?.({ requestId, model: message.model, scope, usage: {
        input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite, totalTokens: message.usage.totalTokens,
      } });
    } catch (error) {
      auditFailed = true;
      auditFailure = error;
      throw error;
    }
  };
  const notify = async (...args: [Parameters<PiModels['streamSimple']>[0], Parameters<PiModels['streamSimple']>[1], AgentUsageFacts['scope']]) => {
    const [model, context, scope] = args;
    await flush();
    const images = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : []);
    const requestId = randomUUID();
    await input.onModelRequest?.({ requestId, model: model.id, scope, digest: sha256(JSON.stringify({ model, context })), messageCount: context.messages.length, images,
      ...(scope === 'compaction' ? { compactionContext: context } : { generationContext: context }) });
    return requestId;
  };
  const models: PiModels = {
    getProviders: (...args) => source.getProviders(...args), getModels: (...args) => source.getModels(...args),
    getModel: (...args) => source.getModel(...args),
    getAuth: (target, options) => typeof target === 'string' ? source.getAuth(target, options) : source.getAuth(target, options),
    completeSimple: async (...args) => {
      args[2]?.signal?.throwIfAborted();
      const context = redactModelVisibleValue(args[1]);
      const requestId = await notify(args[0], context, 'compaction').catch(error => { onFailure?.(error); throw error; });
      args[2]?.signal?.throwIfAborted();
      const message = await observePiFailure(() => source.completeSimple(args[0], context, { ...args[2], maxRetries: 0, maxRetryDelayMs: 8_000 }), onFailure);
      await report(message, 'compaction', requestId, context, args[2]?.signal);
      return message;
    },
    streamSimple: (...args) => source.streamSimple(...args),
  };
  const stream = async (...args: Parameters<PiModels['streamSimple']>) => {
    args[2]?.signal?.throwIfAborted();
    const ceiling = outputCeiling?.();
    const startedAt = Date.now();
    const context = redactModelVisibleValue(args[1]);
    const requestId = await notify(args[0], context, 'generation').catch(error => { onFailure?.(error); throw error; });
    args[2]?.signal?.throwIfAborted();
    let result: ReturnType<PiModels['streamSimple']>;
    try { result = source.streamSimple(args[0], context, { ...args[2], maxRetries: 0, maxRetryDelayMs: 8_000,
      ...(ceiling === undefined ? {} : { maxTokens: Math.min(ceiling, args[2]?.maxTokens ?? Infinity, args[0].maxTokens) }) }); }
    catch (error) { onProviderFailure?.(error); throw error; }
    const task = observePiFailure(() => result.result(), onProviderFailure).then((message) => report(message, 'generation', requestId, context, args[2]?.signal)).catch(error => { if (auditFailed) onFailure?.(error); else onProviderFailure?.(error); throw error; });
    // Lifecycle checkpoints await failures; attach a handler while the stream is still being consumed.
    void task.catch(() => undefined);
    pending.push(task);
    if (!input.onModelStream) return result;
    return observeStream(result, input.onModelStream, requestId, startedAt, onFailure);
  };
  return { models, stream, flush };
}

function observeStream(result: ReturnType<PiModels['streamSimple']>, onModelStream: NonNullable<Hooks['onModelStream']>,
  requestId: string, startedAt: number, onFailure?: (error: unknown) => void) {
  return new Proxy(result, {
    get(target, property) {
      if (property !== Symbol.asyncIterator) {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) as unknown : value;
      }
      return async function* () {
        let firstEventAt: number | null = null, firstTextAt: number | null = null, events = 0;
        try {
          for await (const event of target) {
            firstEventAt ??= Date.now(); events++;
            if (event.type === 'text_delta') firstTextAt ??= Date.now();
            yield event;
          }
        } finally {
          await observePiFailure(() => onModelStream({ requestId, startedAt, firstEventAt, firstTextAt, finishedAt: Date.now(), events }), onFailure);
        }
      };
    },
  });
}
