import { resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { writeAtomic } from '../core/identity.js';
import type { ArtifactRef, EventEnvelope, TaskCase } from '../core/schema.js';
import type { AgentToolDefinition } from './pi-agent-host.js';
import type { ExperimentStore } from './store/experiment-store.js';

const MAX_BYTES = 262_144;
const DEFAULT_READ_BYTES = 65_536;
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
    return { content: JSON.stringify(visiblePage), details: { source: value.source, start, returned: page.length, ...(start + page.length < facts.length ? { nextCursor: start + page.length } : {}) } };
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

/** A comparison agent may write only its one narrative sink; all evidence remains read-only. */
export function comparisonReportTool(reportRoot: string): AgentToolDefinition {
  return { name: 'write_comparison_report', description: 'Write the final comparison.md report to the Host-owned report sink.', parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: MAX_BYTES }) }), execute: async (params) => writeReport(reportRoot, 'comparison.md', params) };
}

/** Catalog-backed reader: identifiers and ownership are verified by ExperimentStore. */
export function evidenceTools(store: ExperimentStore, refs: readonly ArtifactRef[]): readonly AgentToolDefinition[] {
  const cataloged = refs.filter((ref): ref is Extract<ArtifactRef, { experimentId: string }> => 'experimentId' in ref);
  const byKey = new Map(cataloged.map((ref) => [`${ref.runId ?? ''}:${ref.artifactId}`, ref]));
  const byId = new Map<string, Extract<ArtifactRef, { experimentId: string }>[]>();
  for (const ref of cataloged) {
    const list = byId.get(ref.artifactId) ?? [];
    list.push(ref);
    byId.set(ref.artifactId, list);
  }
  const parameters = Type.Object({ artifactId: Type.String({ minLength: 1, maxLength: 128 }), runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BYTES })) });
  return [{ name: 'read_artifact', description: 'Read a bounded range of a cataloged experiment artifact by logical identifier. runId is optional when the catalog has one match for artifactId.', parameters, execute: async (params) => {
    const value = params as { artifactId?: unknown; runId?: unknown; offset?: unknown; maxBytes?: unknown };
    if (typeof value.artifactId !== 'string' || (value.runId !== undefined && typeof value.runId !== 'string')) throw new Error('Artifact identifier is invalid.');
    const ref = resolveCatalogRef(byKey, byId, value.artifactId, value.runId);
    if (!ref) throw new Error('Artifact is not in this comparison evidence catalog.');
    const bytes = await store.readArtifact(ref);
    const offset = readCursor(value.offset, 'Artifact offset');
    const slice = bytes.subarray(offset, offset + readMaxBytes(value));
    return { content: Buffer.from(slice).toString('utf8'), details: { artifactId: value.artifactId, offset, truncated: offset + slice.byteLength < bytes.byteLength, ...(offset + slice.byteLength < bytes.byteLength ? { nextCursor: offset + slice.byteLength } : {}) } };
  } }];
}

async function writeReport(root: string, name: string, params: unknown): Promise<{ content: string; details: { path: string } }> {
  const value = params as { content?: unknown };
  if (typeof value.content !== 'string') throw new Error('Report content must be text.');
  const path = resolve(root, name);
  await writeAtomic(path, value.content);
  return { content: `Wrote ${Buffer.byteLength(value.content)} bytes.`, details: { path: name } };
}

function resolveCatalogRef(
  byKey: Map<string, Extract<ArtifactRef, { experimentId: string }>>,
  byId: Map<string, Extract<ArtifactRef, { experimentId: string }>[]>,
  artifactId: string,
  runId?: string,
): Extract<ArtifactRef, { experimentId: string }> | undefined {
  if (runId) return byKey.get(`${runId}:${artifactId}`);
  const matches = byId.get(artifactId) ?? [];
  return matches.length === 1 ? matches[0] : byKey.get(`:${artifactId}`);
}

function readMaxBytes(params: unknown): number { const value = (params as { maxBytes?: unknown }).maxBytes; if (value === undefined) return DEFAULT_READ_BYTES; if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_BYTES) throw new Error(`maxBytes must be a positive integer no greater than ${MAX_BYTES}.`); return value; }
function readCursor(value: unknown, label: string): number { if (value === undefined) return 0; if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`); return value; }

function redactEvent(event: EventEnvelope): EventEnvelope { return { ...event, payload: redactTextFields(event.payload) }; }
