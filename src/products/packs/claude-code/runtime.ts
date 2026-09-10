import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, text } from '../../../core/json.js';
import {
  type AvailableRuntime,
  type PreparedRuntimeEnvironment,
  type ResolvedRuntime,
  type RuntimeAvailability,
  type ProductRuntime,
  type RuntimeRequest,
  type TargetEventSink,
  type TargetRunner,
} from '../../../core/runtime.js';
import type { CandidateLaunchContext } from '../../../core/schema.js';
import {
  assertIsolatedLaunchWorkspace,
  availableFromInspect,
  discoverProductExecutable,
  inspectRuntimeAvailability,
  LOCAL_SESSION_RECOVERY_CAPABILITIES,
  TtlCache,
} from '../../shared/runtime-host.js';
import { ClaudeRuntimeUnavailableError, ClaudeStreamClient, ClaudeTargetRunner } from './runner.js';

export type ClaudeModel = { value: string; resolvedModel: string; supportedEffortLevels: readonly string[] };
export type ClaudeRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  safeMode?: boolean;
  /** Overrides the CLI argv. Only a protocol-level test has a reason to set this. */
  args?: readonly string[];
};

const catalogCache = new TtlCache<readonly ClaudeModel[]>();

export function clearClaudeCatalogCache(): void {
  catalogCache.clear();
}

export class ClaudeCodeProductRuntime implements ProductRuntime {
  readonly id = 'claude-code';
  readonly #options: ClaudeRuntimeOptions;

  constructor(options: ClaudeRuntimeOptions = {}) {
    this.#options = options;
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return availableFromInspect(await this.inspectAvailability());
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    return inspectRuntimeAvailability({
      productId: 'claude-code',
      executable: await discoverClaudeExecutable(this.#options),
      ...(this.#options.version ? { observedVersion: this.#options.version } : {}),
      installHint: 'Install Claude Code and ensure it is on PATH, or set REPRISE_CLAUDE_EXECUTABLE. Reprise does not install it.',
    });
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'claude-code') throw new Error(`Runtime ${request.productId} is unavailable in Claude Code mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new ClaudeRuntimeUnavailableError('Claude Code executable was not found. Set REPRISE_CLAUDE_EXECUTABLE or install Claude Code; Reprise does not install it.');
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  async listModels(): Promise<readonly ClaudeModel[]> {
    const executable = await discoverClaudeExecutable(this.#options);
    if (!executable) throw new ClaudeRuntimeUnavailableError('Claude Code executable was not found. Set REPRISE_CLAUDE_EXECUTABLE or install Claude Code; Reprise does not install it.');
    const cacheKey = `${executable}\0${this.#options.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''}`;
    const cached = catalogCache.get(cacheKey);
    if (cached) return cached;
    const models = await this.#fetchModels(executable);
    catalogCache.set(cacheKey, models);
    return models;
  }

  async listCatalog(): Promise<readonly import('../../../core/runtime.js').RuntimeModelOffer[]> {
    const models = await this.listModels();
    return models.map((model) => ({
      value: model.value,
      displayName: model.value,
      resolvedModel: model.resolvedModel,
    }));
  }

  async #fetchModels(executable: string): Promise<readonly ClaudeModel[]> {
    const root = await mkdtemp(join(tmpdir(), 'reprise-claude-catalog-'));
    const client = new ClaudeStreamClient({
      executable,
      cwd: root,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
    });
    try {
      await client.start();
      const response = record(await client.request('initialize'));
      const models = Array.isArray(response.models) ? response.models : Array.isArray(response.data) ? response.data : [];
      return models.map(readClaudeModel).filter((model): model is ClaudeModel => model !== undefined);
    } finally {
      try { await client.close(); } catch { /* catalog probe */ }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    const resolved = await this.resolve(request);
    const match = (await this.listModels()).find((model) => model.value === request.requestedModel || model.resolvedModel === request.requestedModel);
    if (!match) {
      throw new ClaudeRuntimeUnavailableError(
        `The current Claude CLI catalog does not expose ${request.requestedModel}. If this model appears in a historical session, it cannot be used as a candidate until the CLI lists it.`,
      );
    }
    return { ...resolved, resolvedModel: match.resolvedModel };
  }

  recoveryCapabilities() {
    return LOCAL_SESSION_RECOVERY_CAPABILITIES;
  }

  async createRunner(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, sink: TargetEventSink, launch: CandidateLaunchContext): Promise<TargetRunner> {
    assertIsolatedLaunchWorkspace({
      runtime,
      environment,
      launch,
      expectedProductId: 'claude-code',
      wrongProduct: 'Only Claude Code runtimes can create a stream-json runner.',
      relativeRoot: 'Claude Code requires an absolute isolated workspace path.',
      mismatch: 'Runner workspace must match CandidateLaunchContext.workspaceRoot.',
      fail: (message) => new ClaudeRuntimeUnavailableError(message),
    });
    return new ClaudeTargetRunner({
      runtime,
      environment,
      sink,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
      ...(this.#options.safeMode ? { safeMode: true } : {}),
    });
  }
}

async function discoverClaudeExecutable(options: ClaudeRuntimeOptions = {}): Promise<string | undefined> {
  return discoverProductExecutable('claude', 'REPRISE_CLAUDE_EXECUTABLE', options);
}

function readClaudeModel(value: unknown): ClaudeModel | undefined {
  const model = record(value);
  const id = text(model.value) ?? text(model.id);
  const resolved = text(model.resolvedModel) ?? text(model.model);
  if (!id || !resolved) return undefined;
  return {
    value: id,
    resolvedModel: resolved,
    supportedEffortLevels: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((item): item is string => typeof item === 'string') : [],
  };
}
