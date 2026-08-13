import type { EventEnvelope } from '../core/schema.js';

type JsonRecord = Record<string, unknown>;

export type TimelineSource = 'HARNESS' | 'CONTROLLER' | 'TARGET';

export interface TimelineEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly source: TimelineSource;
  readonly title: string;
  readonly detail?: string;
  readonly level?: 'warning' | 'error';
}

/** Projects persisted public facts into an operator timeline; unknown and noisy delta events stay in trace only. */
export function projectTimelineEvent(event: EventEnvelope): readonly TimelineEntry[] {
  const payload = record(event.payload);
  const entry = (source: TimelineSource, title: string, detail?: string, level?: TimelineEntry['level']): TimelineEntry => ({
    sequence: event.sequence, occurredAt: event.occurredAt, source, title,
    ...(detail ? { detail } : {}),
    ...(level ? { level } : {}),
  });

  switch (event.type) {
    case 'run.attempt_created':
      return [entry('HARNESS', 'Run created', requestedModel(payload))];
    case 'run.state_changed':
      return [entry('HARNESS', `State: ${text(payload.from) ?? '?'} → ${text(payload.to) ?? '?'}`)];
    case 'input.submitted':
      return [entry('HARNESS', `Input submitted · turn ${integer(payload.turnIndex) ?? '?'}`)];
    case 'runtime.delivery_observed':
      return [entry('HARNESS', `Delivery: ${text(record(payload.receipt).delivery) ?? 'unknown'}`)];
    case 'runtime.turn_settled':
      return [entry('HARNESS', `Turn settled: ${text(payload.status) ?? 'unknown'}`)];
    case 'artifact.created':
      return [entry('HARNESS', `Artifact: ${text(payload.artifactId) ?? 'created'}`)];
    case 'run.stop_requested':
      return [entry('HARNESS', `Stop requested: ${text(payload.reason) ?? 'unknown'}`)];
    case 'environment.release_completed':
      return [entry('HARNESS', 'Isolated workspace released')];
    case 'run.outcome_created':
      return [entry('HARNESS', 'Outcome recorded', outcome(payload))];
    case 'run.finished':
      return [entry('HARNESS', 'Candidate run finished')];
    case 'report.created':
      return [entry('HARNESS', 'Report created', text(payload.path))];
    case 'controller.started':
      return [entry('CONTROLLER', 'Evaluation started', text(payload.model))];
    case 'controller.decision':
      return controllerEntries(event, payload);
    case 'controller.done':
      return [entry('CONTROLLER', `Done: ${text(payload.reason) ?? 'unknown'}`)];
    case 'comparison.started':
      return [entry('CONTROLLER', 'Comparison started', text(payload.model))];
    case 'comparison.completed': {
      const status = text(payload.status) ?? 'unknown';
      const failure = record(payload.failure);
      return [entry('CONTROLLER', status === 'completed' ? 'Comparison completed' : `Comparison ${status}`, status === 'failed' ? text(failure.message) : undefined, status === 'failed' ? 'warning' : undefined)];
    }
    case 'codex.turn_plan_updated':
      return [entry('TARGET', 'Plan updated', plan(payload))];
    case 'codex.item_started':
      return targetItem(event, payload, false);
    case 'codex.item_completed':
      return targetItem(event, payload, true);
    case 'codex.model_rerouted':
      return [entry('TARGET', 'Model rerouted', `${text(payload.fromModel) ?? '?'} → ${text(payload.toModel) ?? '?'}`, 'warning')];
    case 'codex.protocol_error':
      return [entry('TARGET', 'Protocol error', text(payload.message), 'error')];
    case 'codex.codex.stderr':
      return [entry('TARGET', 'Runtime warning', text(payload.line), 'warning')];
    default:
      return [];
  }
}

function controllerEntries(event: EventEnvelope, payload: JsonRecord): readonly TimelineEntry[] {
  const decision = record(payload.value);
  const kind = text(decision.type) ?? 'unknown';
  const rationale = text(decision.rationale);
  const base: TimelineEntry = {
    sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER',
    title: `Decision: ${kind.toUpperCase()}`,
    ...(rationale ? { detail: rationale } : {}),
  };
  if (kind !== 'send') return [base];
  const message = text(decision.message);
  return [base, {
    sequence: event.sequence, occurredAt: event.occurredAt, source: 'CONTROLLER', title: 'Input to Target',
    ...(message ? { detail: message } : {}),
  }];
}

function targetItem(event: EventEnvelope, payload: JsonRecord, completed: boolean): readonly TimelineEntry[] {
  const item = record(payload.item);
  const type = text(item.type);
  if (type === 'reasoning' || type === 'userMessage') return [];
  if (type === 'commandExecution') {
    const command = text(item.command) ?? 'command';
    const status = text(item.status) ?? (completed ? 'completed' : 'started');
    const output = completed ? text(item.aggregatedOutput) : undefined;
    return [{ sequence: event.sequence, occurredAt: event.occurredAt, source: 'TARGET', title: `Command ${status}`, detail: `${command}${output ? `\n${output}` : ''}` }];
  }
  if (type === 'agentMessage' && completed) {
    const message = text(item.text);
    return message ? [{ sequence: event.sequence, occurredAt: event.occurredAt, source: 'TARGET', title: 'Visible response', detail: message }] : [];
  }
  return [];
}

function requestedModel(payload: JsonRecord): string | undefined {
  return text(record(payload.candidate).requestedModel);
}

function plan(payload: JsonRecord): string | undefined {
  if (!Array.isArray(payload.plan)) return undefined;
  return payload.plan.map((value) => {
    const step = record(value);
    return `${text(step.status) ?? 'unknown'} · ${text(step.step) ?? 'unnamed step'}`;
  }).join('\n');
}

function outcome(payload: JsonRecord): string {
  const task = record(payload.task);
  const termination = record(payload.termination);
  const cleanup = record(payload.cleanup);
  return `task=${text(task.status) ?? 'unknown'} · termination=${text(termination.kind) ?? 'unknown'} · cleanup=${text(cleanup.status) ?? 'unknown'}`;
}

function record(value: unknown): JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function integer(value: unknown): number | undefined { return Number.isInteger(value) ? value as number : undefined; }
