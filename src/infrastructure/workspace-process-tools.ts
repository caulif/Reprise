import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { ManagedProcessSession } from '../core/runtime.js';
import { ToolPreconditionRejected } from '../core/tool-precondition-rejected.js';
import type { AgentToolDefinition, AgentToolOwner } from './agent/types.js';

type Session = { owner: string; process: ManagedProcessSession; command: string; cwd: string; outputLog?: string; logArtifact?: Promise<unknown> };
type Options = {
  description: string;
  start(command: string, workdir: string | undefined, signal: AbortSignal): Promise<{ process: ManagedProcessSession; cwd: string; outputLog?: string }>;
  onProcessLog?(path: string, truncated: boolean): Promise<unknown>;
  validateInput?(chars: string): void;
};
const wait = Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 }));
const budget = Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 }));

export function workspaceProcessTools(options: Options): { tools: readonly AgentToolDefinition[]; assertIdle(): void } {
  const sessions = new Map<string, Session>();
  const persistLog = async (session: Session) => {
    if (!session.outputLog || !options.onProcessLog) return undefined;
    session.logArtifact ??= options.onProcessLog(session.outputLog, session.process.logTruncated ?? false);
    return session.logArtifact;
  };
  let starting = false;
  const ownerKey = (owner?: AgentToolOwner) => {
    if (!owner?.invocationId || !owner.sessionId) throw new ToolPreconditionRejected('invalid_process_session', 'Managed processes require a live invocation owner.');
    return `${owner.sessionId}:${owner.invocationId}`;
  };
  const assertIdle = () => {
    if (starting || [...sessions.values()].some(session => session.process.running))
      throw new ToolPreconditionRejected('workspace_busy', 'A managed command owns this workspace. Use write_stdin or cancel_process before other workspace operations.');
  };
  const owned = (id: unknown, owner?: AgentToolOwner) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.owner !== ownerKey(owner)) throw new ToolPreconditionRejected('invalid_process_session', 'The process session is unknown, expired, or belongs to another invocation.');
    return session;
  };
  const lifecycle = { async finishInvocation(owner: AgentToolOwner, requireCompleted = true) {
    const entries = [...sessions.entries()].filter(([, session]) => session.owner === ownerKey(owner));
    const unfinished = entries.some(([, session]) => session.process.state === 'running');
    const results = await Promise.allSettled(entries.map(async ([, session]) => {
      await session.process.cancel();
      const snapshot = await session.process.poll(60_000, 0);
      if (snapshot.state === 'flushing') throw new Error('Process output log flush timed out; workspace cannot be sealed.');
      await persistLog(session);
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason as unknown), 'Process cleanup or log persistence failed.');
    for (const [id] of entries) sessions.delete(id);
    if (unfinished && requireCompleted) throw new Error('Invocation ended with a running command; process tree was drained and the workspace is not accepted.');
  } };
  const result = async (id: string, session: Session, params: { yield_time_ms?: number; max_output_tokens?: number; chars?: string }) => {
    const snapshot = await session.process.poll(params.yield_time_ms ?? 10_000, (params.max_output_tokens ?? 4_096) * 4, params.chars);
    const logArtifact = snapshot.state === 'running' || snapshot.state === 'flushing' ? undefined : await persistLog(session);
    const receipt = { session_id: id, ...snapshot, command: session.command, cwd: session.cwd,
      ...(session.outputLog ? { outputLog: session.outputLog, logMaxBytes: 16_777_216, logTruncated: session.process.logTruncated ?? false } : {}),
      ...(logArtifact ? { logArtifact } : {}) };
    return { content: JSON.stringify(receipt), details: receipt };
  };
  const tools: AgentToolDefinition[] = [
    { name: 'exec_command', description: `${options.description} Waits up to 10000ms by default; yield_time_ms returns control without killing the command. Pipe input remains open. Use write_stdin to collect incremental output, and finish or cancel every session before this invocation ends. A flushing session has exited but still owns the workspace until logs are saved; use write_stdin to wait.`, lifecycle,
      parameters: Type.Object({ cmd: Type.String({ minLength: 1, maxLength: 32_768 }), workdir: Type.Optional(Type.String({ maxLength: 4096 })), yield_time_ms: wait, max_output_tokens: budget }),
      async execute(params, signal, owner) {
        const value = params as { cmd: string; workdir?: string; yield_time_ms?: number; max_output_tokens?: number };
        const key = ownerKey(owner);
        assertIdle(); starting = true;
        try {
          const launched = await options.start(value.cmd, value.workdir, signal);
          const id = randomUUID();
          const session = { owner: key, ...launched, command: value.cmd };
          sessions.set(id, session);
          return await result(id, session, value);
        } finally { starting = false; }
      } },
    { name: 'write_stdin', description: 'Send chars to a process session owned by this invocation, or omit chars to wait. Returns only new output. yield_time_ms defaults to 10000ms and never limits command lifetime.', lifecycle,
      parameters: Type.Object({ session_id: Type.String(), chars: Type.Optional(Type.String({ maxLength: 32_768 })), yield_time_ms: wait, max_output_tokens: budget }),
      async execute(params, _signal, owner) {
        const value = params as { session_id: string; chars?: string; yield_time_ms?: number; max_output_tokens?: number };
        const session = owned(value.session_id, owner);
        if (value.chars) options.validateInput?.(value.chars);
        return result(value.session_id, session, value);
      } },
    { name: 'cancel_process', description: 'Terminate an owned command tree and wait for pipe/process cleanup. A flushing result means the process has exited and logs are still saving; use write_stdin to wait. Unconfirmed termination is fatal; cancellation itself is an ordinary command result.', lifecycle,
      parameters: Type.Object({ session_id: Type.String(), max_output_tokens: budget }),
      async execute(params, _signal, owner) {
        const value = params as { session_id: string; max_output_tokens?: number };
        const session = owned(value.session_id, owner);
        await session.process.cancel();
        return result(value.session_id, session, { ...value, yield_time_ms: 0 });
      } },
  ];
  return { tools, assertIdle };
}
