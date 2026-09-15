import { record, text } from "../core/json.js";
import type { EventEnvelope } from "../core/schema.js";
import {
  calculateUsageCostUsd,
  resolveModelPricing,
  type ModelPricing,
  type PricingResolveOptions,
} from "./model-pricing.js";

export type UsageParts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning?: number;
};

export type AggregatedUsage = {
  parts: UsageParts;
  display: number;
  inputIncludesCache: boolean;
};

const ZERO: UsageParts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function displayTokenCount(parts: UsageParts, inputIncludesCache: boolean): number {
  const fresh = freshInput(parts, inputIncludesCache);
  return fresh + parts.output + parts.cacheCreation + parts.cacheRead;
}

function freshInput(parts: UsageParts, inputIncludesCache: boolean): number {
  if (!inputIncludesCache) return Math.max(0, parts.input);
  return Math.max(0, parts.input - parts.cacheRead - parts.cacheCreation);
}

export function aggregateEventUsage(events: readonly EventEnvelope[]): AggregatedUsage | undefined {
  return aggregateUnknownRecords(events.map((event) => ({
    type: event.type,
    ...record(event.payload),
    payload: event.payload,
  })));
}

export function aggregateHistoricalUsage(events: readonly Record<string, unknown>[]): AggregatedUsage | undefined {
  return aggregateUnknownRecords(events);
}

export function busyMsFromHistoricalEvents(events: readonly Record<string, unknown>[]): number | undefined {
  let started: number | undefined;
  let total = 0;
  let paired = false;
  for (const event of events) {
    const kind = eventKind(event);
    const at = eventTimeMs(event);
    if (at === undefined) continue;
    if (kind === "task_started") {
      started = at;
      continue;
    }
    if (kind === "task_complete" && started !== undefined && at >= started) {
      total += at - started;
      started = undefined;
      paired = true;
    }
  }
  return paired ? total : undefined;
}

export type UsagePricing = {
  lookup: "hit" | "miss" | "invalid";
  costUsd?: number;
  pricingModelId?: string;
  pricingSource?: string;
  pricingVersion?: string;
  rates?: ModelPricing;
};

export function usagePricing(
  usage: AggregatedUsage | undefined,
  modelId: string | undefined,
  pricingTable?: Record<string, ModelPricing>,
  options?: PricingResolveOptions,
): UsagePricing {
  if (!usage) return { lookup: "miss" };
  const resolved = resolveModelPricing(modelId, pricingTable, options);
  if (resolved.kind === "miss" || resolved.kind === "unavailable") return { lookup: "miss" };
  if (resolved.kind === "invalid") {
    return { lookup: "invalid", pricingModelId: resolved.modelId, pricingSource: resolved.source };
  }
  return {
    lookup: "hit",
    costUsd: calculateUsageCostUsd(usage.parts, resolved.rates, usage.inputIncludesCache),
    pricingModelId: resolved.modelId,
    pricingSource: resolved.source,
    ...(resolved.version ? { pricingVersion: resolved.version } : {}),
    rates: resolved.rates,
  };
}

export function usageCostUsd(
  usage: AggregatedUsage | undefined,
  modelId: string | undefined,
  pricingTable?: Record<string, ModelPricing>,
  options?: PricingResolveOptions,
): number | undefined {
  return usagePricing(usage, modelId, pricingTable, options).costUsd;
}

export function factsFromUsage(usage: AggregatedUsage | undefined): {
  total?: number;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
} | undefined {
  if (!usage) return undefined;
  const fresh = freshInput(usage.parts, usage.inputIncludesCache);
  return {
    total: usage.display,
    input: fresh,
    output: usage.parts.output,
    cached: usage.parts.cacheRead,
    ...(usage.parts.reasoning !== undefined ? { reasoning: usage.parts.reasoning } : {}),
  };
}

function aggregateUnknownRecords(events: readonly unknown[]): AggregatedUsage | undefined {
  const deltas: UsageParts[] = [];
  let watermark: UsageParts | undefined;
  let inputIncludesCache = false;
  for (const event of events) {
    const extracted = extractUsage(event);
    if (!extracted) continue;
    if (extracted.inputIncludesCache) inputIncludesCache = true;
    if (extracted.kind === "delta") deltas.push(extracted.parts);
    else watermark = extracted.parts;
  }
  if (deltas.length) {
    const parts = sumParts(deltas);
    return { parts, inputIncludesCache, display: displayTokenCount(parts, inputIncludesCache) };
  }
  if (!watermark) return undefined;
  const display = displayTokenCount(watermark, inputIncludesCache);
  if (display === 0) return undefined;
  return { parts: watermark, inputIncludesCache, display };
}

function extractUsage(value: unknown): { kind: "delta" | "watermark"; parts: UsageParts; inputIncludesCache: boolean } | undefined {
  const row = record(value);
  const payload = record(row.payload);
  const info = record(row.info).total_token_usage ? record(row.info) : record(payload.info);
  const last = firstRecord(row.last_token_usage, payload.last_token_usage, info.last_token_usage);
  if (last && hasAnyTokenField(last)) {
    return { kind: "delta", parts: partsFrom(last), inputIncludesCache: true };
  }
  if (isTokenCount(row, payload) || (info.last_token_usage === undefined && hasAnyTokenField(record(info.total_token_usage)))) {
    const total = firstRecord(info.total_token_usage, row.total_token_usage, payload.total_token_usage);
    if (total && hasAnyTokenField(total)) {
      return { kind: "watermark", parts: partsFrom(total), inputIncludesCache: cacheInclusive(total) };
    }
  }
  if (shouldReadClaudeUsage(row, payload)) {
    const usage = firstRecord(row.usage, payload.usage, record(record(row.message).usage), record(record(payload.message).usage));
    if (usage && hasAnyTokenField(usage)) {
      return { kind: "delta", parts: partsFrom(usage), inputIncludesCache: cacheInclusive(usage) };
    }
  }
  const nested = firstRecord(row.tokenUsage, payload.tokenUsage, record(record(row.tokenUsage).total));
  if (nested && hasAnyTokenField(nested) && (row.type === "runtime.usage_reported" || payload.type === "runtime.usage_reported")) {
    return { kind: "watermark", parts: partsFrom(nested), inputIncludesCache: cacheInclusive(nested) };
  }
  return undefined;
}

function shouldReadClaudeUsage(row: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  const type = text(row.type) ?? text(payload.type) ?? "";
  return type === "result" || type === "runtime.usage_reported" || type.endsWith("usage_reported");
}

function isTokenCount(row: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return text(row.type) === "token_count"
    || text(payload.type) === "token_count"
    || text(record(row.payload).type) === "token_count";
}

function partsFrom(usage: Record<string, unknown>): UsageParts {
  const input = num(usage.input_tokens) ?? num(usage.inputTokens) ?? num(usage.input) ?? 0;
  const output = num(usage.output_tokens) ?? num(usage.outputTokens) ?? num(usage.output) ?? 0;
  const cacheRead = num(usage.cached_input_tokens)
    ?? num(usage.cache_read_input_tokens)
    ?? num(usage.cache_read_tokens)
    ?? num(usage.cachedInputTokens)
    ?? num(usage.cached)
    ?? 0;
  const cacheCreation = num(usage.cache_creation_input_tokens)
    ?? num(usage.cache_creation_tokens)
    ?? num(usage.cacheCreationInputTokens)
    ?? 0;
  const reasoning = num(usage.reasoning_output_tokens) ?? num(usage.reasoningOutputTokens) ?? num(usage.reasoning);
  const totalOnly = num(usage.total_tokens) ?? num(usage.totalTokens) ?? num(usage.token_count) ?? num(usage.total);
  if (!input && !output && !cacheRead && !cacheCreation && totalOnly !== undefined) {
    return { ...ZERO, input: totalOnly };
  }
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function cacheInclusive(usage: Record<string, unknown>): boolean {
  return num(usage.cached_input_tokens) !== undefined || num(usage.cachedInputTokens) !== undefined;
}

function hasAnyTokenField(usage: Record<string, unknown>): boolean {
  return num(usage.input_tokens) !== undefined
    || num(usage.inputTokens) !== undefined
    || num(usage.output_tokens) !== undefined
    || num(usage.outputTokens) !== undefined
    || num(usage.cached_input_tokens) !== undefined
    || num(usage.cache_read_input_tokens) !== undefined
    || num(usage.total_tokens) !== undefined
    || num(usage.totalTokens) !== undefined
    || num(usage.token_count) !== undefined
    || num(usage.total) !== undefined
    || num(usage.cache_creation_input_tokens) !== undefined;
}

function sumParts(items: readonly UsageParts[]): UsageParts {
  const summed = items.reduce((acc, item) => ({
    input: acc.input + item.input,
    output: acc.output + item.output,
    cacheRead: acc.cacheRead + item.cacheRead,
    cacheCreation: acc.cacheCreation + item.cacheCreation,
    reasoning: (acc.reasoning ?? 0) + (item.reasoning ?? 0),
  }), { ...ZERO });
  return summed.reasoning ? summed : { input: summed.input, output: summed.output, cacheRead: summed.cacheRead, cacheCreation: summed.cacheCreation };
}

function eventKind(event: Record<string, unknown>): string | undefined {
  const payload = record(event.payload);
  const type = typeof event.type === "string" ? event.type : undefined;
  const nested = typeof payload.type === "string" ? payload.type : undefined;
  return nested ?? type;
}

function eventTimeMs(event: Record<string, unknown>): number | undefined {
  const payload = record(event.payload);
  const raw = [event.timestamp, event.occurredAt, payload.timestamp, payload.occurredAt].find((item) => typeof item === "string");
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const item = record(value);
    if (Object.keys(item).length) return item;
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
