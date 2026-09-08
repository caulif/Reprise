import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { isRecord } from '../core/json.js';
import { writeAtomic } from '../core/identity.js';

const FILE_NAME = 'harness-model.json';
const EFFORTS = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const KEY_REF = /^(?:env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const OPENAI_APIS = new Set(['openai-completions', 'openai-responses'] as const);

export type OpenAiCompatApi = 'openai-completions' | 'openai-responses';
export type HarnessCompat = {
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
};

export type HarnessProvider = {
  readonly kind: 'pi-catalog' | 'openai-compatible';
  readonly id: string;
};

/** Local Harness config. apiKey is stored here, like Codex auth.json. */
export type HarnessModelConfig = V1Config | V2Config;

type V2Config = {
  readonly schemaVersion: 2;
  readonly provider: HarnessProvider;
  /** Compatibility projection for application code that addresses Pi by id. */
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ThinkingLevel;
  readonly baseUrl?: string;
  /** Optional leftover env:NAME reference. Prefer apiKey. */
  readonly keyRef?: string;
  /** Local file credential, same role as Codex auth.json / Claude .credentials.json. */
  readonly apiKey?: string;
  /** When set, overrides the catalog/custom model context window used for Pi compaction. */
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly api?: OpenAiCompatApi;
  readonly reasoning?: boolean;
  readonly compat?: HarnessCompat;
};

type V1Config = {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ThinkingLevel;
  readonly baseUrl?: string;
};

/** Reads v1 without rewriting it and normalizes it to the v2 application shape. */
export async function readHarnessModelConfig(dataDir: string): Promise<HarnessModelConfig | undefined> {
  const path = configPath(dataDir);
  try {
    return validateConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`Harness model configuration is invalid: ${errorMessage(error)}`, { cause: error });
  }
}

/** Saves normalized v2 configuration atomically. apiKey stays in this local data dir. */
export async function saveHarnessModelConfig(dataDir: string, config: HarnessModelConfig): Promise<void> {
  const value = validateConfig(config);
  const path = configPath(dataDir);
  await writeAtomic(path, `${JSON.stringify(toPersistedConfig(value), null, 2)}\n`);
}

export function defaultHarnessModelConfig(): HarnessModelConfig {
  return { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'openai-codex' }, providerId: 'openai-codex', modelId: 'gpt-5.6-terra', effort: 'medium' };
}

export function emptyHarnessConfigDraft(): HarnessConfigDraft {
  return {
    kind: 'openai-compatible',
    providerId: 'openai-compatible',
    modelId: '',
    effort: 'medium',
    baseUrl: '',
    keyRef: '',
    api: 'openai-completions',
    reasoning: false,
  };
}

export function configPath(dataDir: string): string { return join(dataDir, FILE_NAME); }

/** Validates an env key reference and returns only its environment-variable name. */
export function environmentNameForKeyRef(value: string): string {
  const match = KEY_REF.exec(value);
  const name = match?.[1] ?? match?.[2];
  if (!name) throw new Error('expected keyRef in the form env:NAME or ${NAME}');
  return name;
}

export function resolveKeyRef(value: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment[environmentNameForKeyRef(value)];
}

function validateConfig(value: unknown): V2Config {
  if (!isRecord(value)) throw new Error('expected a configuration object');
  if (value.schemaVersion === 1) return normalizeV1(value as unknown as V1Config);
  if (value.schemaVersion === 2) return normalizeV2(value);
  throw new Error('expected schemaVersion 1 or 2');
}

function normalizeV1(value: V1Config): V2Config {
  if (!safeId(value.providerId) || !safeId(value.modelId) || !isEffort(value.effort)) throw new Error('expected providerId, modelId, and supported effort');
  return normalizeV2({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: value.providerId }, modelId: value.modelId, effort: value.effort });
}

function normalizeV2(value: Record<string, unknown>): V2Config {
  const provider = value.provider;
  if (!isRecord(provider) || (provider.kind !== 'pi-catalog' && provider.kind !== 'openai-compatible') || !safeId(provider.id) || !safeId(value.modelId) || !isEffort(value.effort)) {
    throw new Error('expected provider kind/id, modelId, and supported effort');
  }
  if (provider.kind === 'pi-catalog') {
    return {
      schemaVersion: 2,
      provider: { kind: 'pi-catalog', id: provider.id },
      providerId: provider.id,
      modelId: value.modelId,
      effort: value.effort,
    };
  }
  const baseUrl = optionalBaseUrl(value.baseUrl);
  const credential = readCredential(value.apiKey ?? value.keyRef);
  if (baseUrl === undefined || (!credential.apiKey && !credential.keyRef)) {
    throw new Error('openai-compatible providers require baseUrl and apiKey');
  }
  const contextWindow = optionalPositiveInt(value.contextWindow, 'contextWindow');
  const maxTokens = optionalPositiveInt(value.maxTokens, 'maxTokens');
  const api = optionalApi(value.api);
  const reasoning = optionalBoolean(value.reasoning, 'reasoning');
  const compat = optionalCompat(value.compat);
  return {
    schemaVersion: 2,
    provider: { kind: 'openai-compatible', id: provider.id },
    providerId: provider.id,
    modelId: value.modelId,
    effort: value.effort,
    baseUrl,
    ...(credential.keyRef ? { keyRef: credential.keyRef } : {}),
    ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(api === undefined ? {} : { api }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(compat === undefined ? {} : { compat }),
  };
}

function toPersistedConfig(config: V2Config): Omit<V2Config, 'providerId'> {
  const { providerId: _providerId, ...persisted } = config;
  return persisted;
}

function readCredential(value: unknown): { keyRef?: string; apiKey?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || !value.trim()) throw new Error('expected apiKey to be a non-empty string');
  if (value.length > 8_000) throw new Error('expected apiKey to be at most 8000 characters');
  return KEY_REF.test(value) ? { keyRef: value } : { apiKey: value };
}

function optionalBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('expected baseUrl to be an absolute HTTPS URL without credentials, query, or fragment');
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return value;
  } catch { /* handled below */ }
  throw new Error('expected baseUrl to be an absolute HTTPS URL without credentials, query, or fragment');
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`expected ${label} to be a positive integer`);
  return value;
}

function optionalApi(value: unknown): OpenAiCompatApi | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && OPENAI_APIS.has(value as OpenAiCompatApi)) return value as OpenAiCompatApi;
  throw new Error('expected api to be openai-completions or openai-responses');
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`expected ${label} to be a boolean`);
}

function optionalCompat(value: unknown): HarnessCompat | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('expected compat to be an object');
  const supportsDeveloperRole = optionalBoolean(value.supportsDeveloperRole, 'compat.supportsDeveloperRole');
  const supportsReasoningEffort = optionalBoolean(value.supportsReasoningEffort, 'compat.supportsReasoningEffort');
  if (supportsDeveloperRole === undefined && supportsReasoningEffort === undefined) return undefined;
  return {
    ...(supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole }),
    ...(supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort }),
  };
}

export type HarnessConfigDraft = {
  kind: 'pi-catalog' | 'openai-compatible';
  providerId: string;
  modelId: string;
  effort: ThinkingLevel;
  baseUrl: string;
  keyRef: string;
  api: OpenAiCompatApi;
  reasoning: boolean;
};

export const HARNESS_CONFIG_FIELDS = [
  'provider type', 'provider label', 'base URL', 'model', 'API', 'reasoning', 'effort', 'API key',
] as const;
export type HarnessConfigField = typeof HARNESS_CONFIG_FIELDS[number];

export function configFieldsForKind(kind: HarnessConfigDraft['kind']): readonly HarnessConfigField[] {
  return kind === 'openai-compatible'
    ? HARNESS_CONFIG_FIELDS
    : HARNESS_CONFIG_FIELDS.filter((field) => field === 'provider type' || field === 'provider label' || field === 'model' || field === 'effort');
}

export function languageFieldIndex(kind: HarnessConfigDraft['kind']): number {
  return configFieldsForKind(kind).length;
}

export type FieldValidity = { readonly ok: boolean; readonly display: string; readonly reason?: string };

export function draftForConfig(config: HarnessModelConfig): HarnessConfigDraft {
  if (config.schemaVersion === 2) {
    return {
      kind: config.provider.kind,
      providerId: config.provider.id,
      modelId: config.modelId,
      effort: config.effort,
      baseUrl: config.provider.kind === 'openai-compatible' ? (config.baseUrl ?? '') : '',
      keyRef: config.provider.kind === 'openai-compatible' ? (config.apiKey ?? config.keyRef ?? '') : '',
      api: config.api ?? 'openai-completions',
      reasoning: config.reasoning === true,
    };
  }
  return {
    kind: 'pi-catalog', providerId: config.providerId, modelId: config.modelId,
    effort: config.effort, baseUrl: '', keyRef: '', api: 'openai-completions', reasoning: false,
  };
}

export function configForDraft(draft: HarnessConfigDraft): HarnessModelConfig {
  if (draft.kind === 'pi-catalog') {
    return {
      schemaVersion: 2,
      provider: { kind: 'pi-catalog', id: draft.providerId },
      providerId: draft.providerId,
      modelId: draft.modelId,
      effort: draft.effort,
    };
  }
  return {
    schemaVersion: 2,
    provider: { kind: 'openai-compatible', id: draft.providerId },
    providerId: draft.providerId,
    modelId: draft.modelId,
    effort: draft.effort,
    baseUrl: draft.baseUrl,
    api: draft.api,
    reasoning: draft.reasoning,
    ...readCredential(draft.keyRef),
  };
}

export function configFieldValue(draft: HarnessConfigDraft, field: HarnessConfigField): string {
  if (field === 'provider type') return draft.kind;
  if (field === 'provider label') return draft.providerId;
  if (field === 'base URL') return draft.baseUrl;
  if (field === 'model') return draft.modelId;
  if (field === 'API') return draft.api;
  if (field === 'reasoning') return draft.reasoning ? 'true' : 'false';
  if (field === 'effort') return draft.effort;
  return draft.keyRef;
}

export function setConfigField(
  draft: HarnessConfigDraft, field: HarnessConfigField, value: string,
): HarnessConfigDraft {
  if (field === 'provider label') return { ...draft, providerId: value };
  if (field === 'base URL') return { ...draft, baseUrl: value };
  if (field === 'model') return { ...draft, modelId: value };
  if (field === 'API key') return { ...draft, keyRef: value };
  return draft;
}

export function tryEnvironmentName(value: string): string | undefined {
  const match = KEY_REF.exec(value);
  return match?.[1] ?? match?.[2];
}

export function shellEnvAssignment(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `$env:${name} = '<value>'` : `export ${name}='<value>'`;
}

export function apiKeyValidity(value: string): FieldValidity {
  if (!value) return { ok: false, display: 'required for OpenAI-compatible', reason: 'required' };
  if (KEY_REF.test(value)) return { ok: true, display: value };
  return { ok: true, display: maskSecret(value) };
}

export function maskSecret(value: string): string {
  if (!value || KEY_REF.test(value)) return value;
  return '•'.repeat(8);
}

export function hasFileApiKey(config: HarnessModelConfig | HarnessConfigDraft): boolean {
  if ('apiKey' in config && typeof config.apiKey === 'string' && config.apiKey.trim() && !KEY_REF.test(config.apiKey)) return true;
  if ('keyRef' in config && typeof config.keyRef === 'string' && config.keyRef.trim() && !KEY_REF.test(config.keyRef)) return true;
  return false;
}

/** Public view of local harness config. Secrets are never included. */
export function publicHarnessConfig(config: HarnessModelConfig | undefined): {
  readonly present: boolean;
  readonly providerKind?: 'pi-catalog' | 'openai-compatible';
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly baseUrl?: string;
  readonly hasCredential?: boolean;
  readonly keyRef?: string;
} {
  if (!config) return { present: false };
  const kind = config.schemaVersion === 2 ? config.provider.kind : 'pi-catalog';
  const keyRef = config.schemaVersion === 2 && 'keyRef' in config ? config.keyRef : undefined;
  return {
    present: true,
    providerKind: kind,
    providerId: config.providerId,
    modelId: config.modelId,
    effort: config.effort,
    ...(config.schemaVersion === 2 && config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    hasCredential: hasFileApiKey(config) || Boolean(keyRef && process.env[environmentNameForKeyRef(keyRef)]),
    ...(keyRef ? { keyRef } : {}),
  };
}

export function baseUrlValidity(value: string): FieldValidity {
  if (!value) return { ok: false, display: 'required for OpenAI-compatible', reason: 'not an https URL' };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
      return { ok: true, display: value };
    }
  } catch { /* invalid */ }
  return { ok: false, display: '', reason: 'not an https URL' };
}

/** Redacts endpoints and secret-shaped tokens from configuration errors shown in the TUI. */
export function safeConfigError(error: unknown): string {
  return errorMessage(error)
    .replace(/https?:\/\/[^\s]+/gi, '[endpoint redacted]')
    .replace(/(?:sk-|api[_-]?key|bearer)\S*/gi, '[secret redacted]');
}

function isEffort(value: unknown): value is ThinkingLevel { return typeof value === 'string' && EFFORTS.has(value as ThinkingLevel); }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value); }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
