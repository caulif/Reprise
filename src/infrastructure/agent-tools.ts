import { Type } from '@sinclair/typebox';
import type { EventEnvelope, TaskCase } from '../core/schema.js';
import type { AgentToolDefinition } from './pi-agent-host.js';
import type { ExperimentStore } from './store/experiment-store.js';

const OBSERVATION = Type.Object({ source: Type.Union([Type.Literal('run_events'), Type.Literal('transcript')]), start: Type.Optional(Type.Integer({ minimum: 0 })), maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })) });

/** Read only a bounded page of Host facts; no caller passes filesystem paths to this tool. */
export function observationTools(store: ExperimentStore, input: { runId: string; transcript: TaskCase['transcript']; allowModelText: boolean }): readonly AgentToolDefinition[] {
  return [{ name: 'read_observation', description: 'Read a bounded page of the frozen TaskCase transcript (historical session, not this candidate) or this candidate run event trace.', parameters: OBSERVATION, execute: async (params) => {
    const value = params as { source?: unknown; start?: unknown; maxItems?: unknown };
    if (value.source !== 'run_events' && value.source !== 'transcript') throw new Error('Observation source is invalid.');
    const start = readCursor(value.start, 'Observation cursor');
    const maxItems = typeof value.maxItems === 'number' && Number.isInteger(value.maxItems) && value.maxItems > 0 && value.maxItems <= 128 ? value.maxItems : 32;
    const facts = value.source === 'run_events' ? store.events(input.runId) : input.transcript;
    const page = facts.slice(start, start + maxItems);
    let visiblePage: readonly unknown[] = page;
    if (!input.allowModelText) {
      visiblePage = value.source === 'transcript'
        ? (page as TaskCase['transcript']).map(redactAssistantText)
        : (page as readonly EventEnvelope[]).map(redactEvent);
    }
    return { content: JSON.stringify(visiblePage), details: { source: value.source, start, returned: page.length, runId: input.runId, ...(value.source === 'run_events' ? { evidenceRefs: (page as readonly EventEnvelope[]).map((event) => `event:${event.eventId}`) } : {}), ...(start + page.length < facts.length ? { nextCursor: start + page.length } : {}) } };
  } }];
}

function redactAssistantText(message: TaskCase['transcript'][number]): TaskCase['transcript'][number] {
  return message.role === 'assistant' ? { ...message, text: '[REDACTED]' } : message;
}

function redactTextFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTextFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'text' && typeof child === 'string' ? '[REDACTED]' : redactTextFields(child)]));
}

function readCursor(value: unknown, label: string): number { if (value === undefined) return 0; if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`); return value; }

function redactEvent(event: EventEnvelope): EventEnvelope { return { ...event, payload: redactTextFields(event.payload) }; }
