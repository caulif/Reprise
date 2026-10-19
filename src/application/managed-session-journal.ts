import type { CandidateLaunchContext, ManagedSessionReceipt } from '../core/schema.js';
import type { TargetEventSink, TargetRunner } from '../core/runtime.js';
import type { ProductHistoryReader } from '../products/contract.js';
import { archiveManagedSession, bindManagedSession } from './managed-session-history.js';

export function managedSessionJournal(input: {
  dataDir: string;
  launch: CandidateLaunchContext;
  journalSink: TargetEventSink;
  history?: ProductHistoryReader;
  redactions: readonly string[];
  append(type: string, receipt: ManagedSessionReceipt): Promise<unknown>;
}) {
  let receipt: ManagedSessionReceipt | undefined;
  const runner: { current?: TargetRunner } = {};
  const sink: TargetEventSink = { append: async event => {
    await input.journalSink.append(event);
    if (event.type === 'runtime.session_started' && runner.current && !receipt) {
      receipt = await bindManagedSession(input.dataDir, input.launch, runner.current);
      if (receipt) await input.append('candidate.history_bound', receipt);
    }
  } };
  return {
    sink,
    bind: (value: TargetRunner) => { runner.current = value; },
    async capture(signal: AbortSignal) {
      if (!receipt || !runner.current || !input.history) return;
      const archived = await archiveManagedSession({
        dataDir: input.dataDir, receipt, runner: runner.current, history: input.history, redactions: input.redactions, signal,
      });
      signal.throwIfAborted();
      await input.append('candidate.history_archived', archived);
    },
  };
}
