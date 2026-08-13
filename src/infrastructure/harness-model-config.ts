import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-ai';

const FILE_NAME = 'harness-model.json';
const EFFORTS = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const KEY_REF = /^(?:env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

export type HarnessProvider = {
  readonly kind: 'pi-catalog' | 'openai-compatible';
  readonly id: string;
};

/** Persisted config contains a non-secret model selection only. */
export type HarnessModelConfig = V1Config | V2Config;

type V2Config = {
  readonly schemaVersion: 2;
  readonly provider: HarnessProvider;
  /** Compatibility projection for application code that addresses Pi by id. */
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ThinkingLevel;
  readonly baseUrl?: string;
  /** Environment reference only, never an API-key value. */
  readonly keyRef?: string;
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
    throw new Error(`Harness model configuration is invalid: ${errorMessage(error)}`);
  }
}

/** Saves normalized v2 configuration atomically, without credentials. */
export async function saveHarnessModelConfig(dataDir: string, config: HarnessModelConfig): Promise<void> {
  const value = validateConfig(config);
  const path = configPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(toPersistedConfig(value), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export function defaultHarnessModelConfig(): HarnessModelConfig {
  return { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'openai-codex' }, providerId: 'openai-codex', modelId: 'gpt-5.6-terra', effort: 'medium' };
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
  const baseUrl = optionalBaseUrl(value.baseUrl);
  return normalizeV2({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: value.providerId }, modelId: value.modelId, effort: value.effort, ...(baseUrl === undefined ? {} : { baseUrl }) });
}

function normalizeV2(value: Record<string, unknown>): V2Config {
  const provider = value.provider;
  if (!isRecord(provider) || (provider.kind !== 'pi-catalog' && provider.kind !== 'openai-compatible') || !safeId(provider.id) || !safeId(value.modelId) || !isEffort(value.effort)) {
    throw new Error('expected provider kind/id, modelId, and supported effort');
  }
  const baseUrl = optionalBaseUrl(value.baseUrl);
  const keyRef = value.keyRef === undefined ? undefined : optionalKeyRef(value.keyRef);
  if (provider.kind === 'openai-compatible' && (baseUrl === undefined || keyRef === undefined)) {
    throw new Error('openai-compatible providers require baseUrl and keyRef');
  }
  return { schemaVersion: 2, provider: { kind: provider.kind, id: provider.id }, providerId: provider.id, modelId: value.modelId, effort: value.effort, ...(baseUrl === undefined ? {} : { baseUrl }), ...(keyRef === undefined ? {} : { keyRef }) };
}

function toPersistedConfig(config: V2Config): Omit<V2Config, 'providerId'> {
  const { providerId: _providerId, ...persisted } = config;
  return persisted;
}

function optionalKeyRef(value: unknown): string | undefined {
  if (typeof value !== 'string') throw new Error('expected keyRef in the form env:NAME or ${NAME}');
  environmentNameForKeyRef(value);
  return value;
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

export type HarnessConfigDraft = {
  kind: 'pi-catalog' | 'openai-compatible';
  providerId: string;
  modelId: string;
  effort: ThinkingLevel;
  baseUrl: string;
  keyRef: string;
};

export const HARNESS_CONFIG_FIELDS = [
  'provider type', 'provider label', 'base URL', 'model', 'effort', 'API key reference',
] as const;
export type HarnessConfigField = typeof HARNESS_CONFIG_FIELDS[number];

export type FieldValidity = { readonly ok: boolean; readonly display: string; readonly reason?: string };

export function draftForConfig(config: HarnessModelConfig): HarnessConfigDraft {
  if (config.schemaVersion === 2) {
    return {
      kind: config.provider.kind,
      providerId: config.provider.id,
      modelId: config.modelId,
      effort: config.effort,
      baseUrl: config.baseUrl ?? '',
      keyRef: config.keyRef ?? '',
    };
  }
  return {
    kind: 'pi-catalog', providerId: config.providerId, modelId: config.modelId,
    effort: config.effort, baseUrl: config.baseUrl ?? '', keyRef: '',
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
      ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
    };
  }
  return {
    schemaVersion: 2,
    provider: { kind: 'openai-compatible', id: draft.providerId },
    providerId: draft.providerId,
    modelId: draft.modelId,
    effort: draft.effort,
    baseUrl: draft.baseUrl,
    keyRef: draft.keyRef,
  };
}

export function configFieldValue(draft: HarnessConfigDraft, field: HarnessConfigField): string {
  if (field === 'provider type') return draft.kind;
  if (field === 'provider label') return draft.providerId;
  if (field === 'base URL') return draft.baseUrl;
  if (field === 'model') return draft.modelId;
  if (field === 'effort') return draft.effort;
  return draft.keyRef;
}

export function setConfigField(
  draft: HarnessConfigDraft, field: HarnessConfigField, value: string,
): HarnessConfigDraft {
  if (field === 'provider label') return { ...draft, providerId: value };
  if (field === 'base URL') return { ...draft, baseUrl: value };
  if (field === 'model') return { ...draft, modelId: value };
  if (field === 'API key reference') return { ...draft, keyRef: value };
  return draft;
}

export function keyRefValidity(value: string): FieldValidity {
  if (!value) return { ok: false, display: 'required for OpenAI-compatible', reason: 'expected env:NAME' };
  if (KEY_REF.test(value)) return { ok: true, display: value };
  return { ok: false, display: '', reason: 'expected env:NAME' };
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

export function safeBaseUrlDisplay(value: string): string {
  return baseUrlValidity(value).display;
}

/** Redacts endpoints and secret-shaped tokens from configuration errors shown in the TUI. */
export function safeConfigError(error: unknown): string {
  return errorMessage(error)
    .replace(/https?:\/\/[^\s]+/gi, '[endpoint redacted]')
    .replace(/(?:sk-|api[_-]?key|bearer)\S*/gi, '[secret redacted]');
}

function isEffort(value: unknown): value is ThinkingLevel { return typeof value === 'string' && EFFORTS.has(value as ThinkingLevel); }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
