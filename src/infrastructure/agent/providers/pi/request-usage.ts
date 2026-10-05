import type { AgentUsageFacts } from '../../../../core/schema.js';
import type { ProviderAdapter } from '../../types.js';
import { sha256 } from '../../../../core/identity.js';
import type { PiModels } from './adapter.js';
import { redactModelVisibleValue } from '../../model-input.js';
import { observePiFailure } from './yield-deadline.js';

type Hooks = Parameters<ProviderAdapter['createSession']>[0];

export function piRequestUsage(source: PiModels, input: Pick<Hooks, 'onModelUsage' | 'onModelRequest'>, onFailure?: (error: unknown) => void) {
  const pending: Promise<void>[] = [];
  let auditFailed = false;
  let auditFailure: unknown;
  const flush = async () => {
    const tasks = pending.splice(0);
    const results = await Promise.allSettled(tasks);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      auditFailed = true;
      auditFailure = failure.reason;
    }
    if (auditFailed) throw auditFailure;
  };
  const report = async (message: { model: string; usage: AgentUsageFacts['usage']; stopReason?: string; errorMessage?: string }, scope: AgentUsageFacts['scope'], signal?: AbortSignal) => {
    if (message.stopReason === 'error') onFailure?.(new Error(message.errorMessage ?? 'Provider response failed.'));
    if (message.stopReason === 'aborted' && !signal?.aborted) onFailure?.(new Error(message.errorMessage ?? 'Provider response aborted independently.'));
    // Pinned SDK failure messages initialize usage to zero before any provider usage arrives; these zeros are not a bill.
    if ((message.stopReason === 'error' || message.stopReason === 'aborted')
      && [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite, message.usage.totalTokens].every(count => count === 0)) return;
    try {
      await input.onModelUsage?.({ model: message.model, scope, usage: {
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
    await input.onModelRequest?.({ model: model.id, scope, digest: sha256(JSON.stringify({ model, context })), messageCount: context.messages.length, images,
      ...(scope === 'compaction' ? { compactionContext: context } : { generationContext: context }) });
  };
  const models: PiModels = {
    getProviders: (...args) => source.getProviders(...args), getModels: (...args) => source.getModels(...args),
    getModel: (...args) => source.getModel(...args),
    getAuth: (target, options) => typeof target === 'string' ? source.getAuth(target, options) : source.getAuth(target, options),
    completeSimple: async (...args) => {
      args[2]?.signal?.throwIfAborted();
      const context = redactModelVisibleValue(args[1]);
      await notify(args[0], context, 'compaction').catch(error => { onFailure?.(error); throw error; });
      args[2]?.signal?.throwIfAborted();
      const message = await observePiFailure(() => source.completeSimple(args[0], context, { ...args[2], maxRetries: 0, maxRetryDelayMs: 8_000 }), onFailure);
      await report(message, 'compaction', args[2]?.signal);
      return message;
    },
    streamSimple: (...args) => source.streamSimple(...args),
  };
  const stream = async (...args: Parameters<PiModels['streamSimple']>) => {
    args[2]?.signal?.throwIfAborted();
    const context = redactModelVisibleValue(args[1]);
    await notify(args[0], context, 'generation').catch(error => { onFailure?.(error); throw error; });
    args[2]?.signal?.throwIfAborted();
    let result: ReturnType<PiModels['streamSimple']>;
    try { result = source.streamSimple(args[0], context, { ...args[2], maxRetries: 0, maxRetryDelayMs: 8_000 }); }
    catch (error) { onFailure?.(error); throw error; }
    const task = observePiFailure(() => result.result(), onFailure).then((message) => report(message, 'generation', args[2]?.signal)).catch(error => { onFailure?.(error); throw error; });
    // Lifecycle checkpoints await failures; attach a handler while the stream is still being consumed.
    void task.catch(() => undefined);
    pending.push(task);
    return result;
  };
  return { models, stream, flush };
}
