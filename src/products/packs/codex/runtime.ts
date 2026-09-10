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
import { CodexAppServerClient, CodexRuntimeUnavailableError, CodexTargetRunner } from './runner.js';

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexModel = { id: string; model: string; supportedReasoningEfforts: readonly string[] };

/**
 * Windows `workspace-write` cannot apply deny-read ACLs (`helper_unknown_error`).
 * Isolation on Windows is the frozen workspace copy, not the OS sandbox.
 */
export function defaultCodexSandbox(platform: NodeJS.Platform = process.platform): CodexSandboxMode {
  return platform === 'win32' ? 'danger-full-access' : 'workspace-write';
}


export type CodexRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  effort?: CodexReasoningEffort;
  sandbox?: CodexSandboxMode;
  /** Overrides the app-server argv. Only a protocol-level test has a reason to set this. */
  args?: readonly string[];
};

const catalogCache = new TtlCache<readonly CodexModel[]>();

function catalogCacheKey(executable: string, env: Readonly<Record<string, string | undefined>> | undefined): string {
  const codeHome = env && Object.prototype.hasOwnProperty.call(env, 'CODEX_HOME') ? env.CODEX_HOME : process.env.CODEX_HOME;
  return `${executable}` + String.fromCharCode(0) + (codeHome ?? '');
}

/** Exposed so tests and long-lived TUI sessions can force a fresh catalog read. */
export function clearCodexCatalogCache(): void {
  catalogCache.clear();
}

export class CodexProductRuntime implements ProductRuntime {
  readonly id = 'codex';
  readonly #options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions = {}) {
    this.#options = options;
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return availableFromInspect(await this.inspectAvailability());
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    return inspectRuntimeAvailability({
      productId: 'codex',
      executable: await discoverCodexExecutable(this.#options),
      ...(this.#options.version ? { observedVersion: this.#options.version } : {}),
      installHint: 'Install Codex and ensure it is on PATH, or set REPRISE_CODEX_EXECUTABLE. Reprise does not install it.',
    });
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'codex') throw new Error(`Runtime ${request.productId} is unavailable in Codex mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  /**
   * Lists the current Codex model catalog without starting a target task. Each call spawns an app-server and
   * pages a full RPC catalog, so repeated preflights within one session reuse a short-lived snapshot.
   */
  async listModels(): Promise<readonly CodexModel[]> {
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    const cacheKey = catalogCacheKey(executable, this.#options.env);
    const cached = catalogCache.get(cacheKey);
    if (cached) return cached;
    const models = await this.#fetchModels(executable);
    catalogCache.set(cacheKey, models);
    return models;
  }

  async listCatalog(): Promise<readonly import('../../../core/runtime.js').RuntimeModelOffer[]> {
    const models = await this.listModels();
    return models.map((model) => ({
      value: model.id,
      displayName: model.id,
      resolvedModel: model.model,
    }));
  }

  async #fetchModels(executable: string): Promise<readonly CodexModel[]> {
    const root = await mkdtemp(join(tmpdir(), 'reprise-codex-catalog-'));
    const client = new CodexAppServerClient({ executable, cwd: root, ...(this.#options.env ? { env: this.#options.env } : {}), ...(this.#options.args ? { args: this.#options.args } : {}), ...(this.#options.platform ? { platform: this.#options.platform } : {}) });
    const models: CodexModel[] = [];
    let primaryError: unknown;
    let hasPrimaryError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;
    try {
      await client.start();
      let cursor: string | undefined;
      let completed = false;
      for (let page = 0; page < 100; page += 1) {
        const response = record(await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
        const data = Array.isArray(response.data) ? response.data : [];
        models.push(...data.map(readCodexModel).filter((model): model is CodexModel => model !== undefined));
        cursor = text(response.nextCursor);
        if (!cursor) {
          completed = true;
          break;
        }
      }
      if (!completed) throw new CodexRuntimeUnavailableError('Codex model catalog pagination exceeded its safety limit.');
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    try {
      await client.close();
    } catch (closeError) {
      cleanupError = closeError;
      hasCleanupError = true;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (removeError) {
      if (!hasCleanupError) {
        cleanupError = removeError;
        hasCleanupError = true;
      }
    }
    if (hasPrimaryError) throw primaryError;
    if (hasCleanupError) throw cleanupError;
    return models;
  }

  /** Verifies a model against Codex's current catalog; it does not modify global configuration. */
  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    const resolved = await this.resolve(request);
    const match = (await this.listModels()).find((model) => model.id === request.requestedModel || model.model === request.requestedModel);
    if (!match) throw new CodexRuntimeUnavailableError('Codex does not currently expose candidate model ' + request.requestedModel + '.');
    return { ...resolved, resolvedModel: match.model };
  }
  recoveryCapabilities() {
    return LOCAL_SESSION_RECOVERY_CAPABILITIES;
  }

  async createRunner(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, sink: TargetEventSink, launch: CandidateLaunchContext): Promise<TargetRunner> {
    assertIsolatedLaunchWorkspace({
      runtime,
      environment,
      launch,
      expectedProductId: 'codex',
      wrongProduct: 'Only Codex runtimes can create a Codex app-server runner.',
      relativeRoot: 'Codex app-server requires an absolute isolated workspace path.',
      mismatch: 'Runner workspace must match CandidateLaunchContext.workspaceRoot.',
      fail: (message) => new CodexRuntimeUnavailableError(message),
    });
    return new CodexTargetRunner({
      runtime, environment, sink,
      effort: this.#options.effort ?? 'medium',
      sandbox: this.#options.sandbox ?? defaultCodexSandbox(),
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
      ...(this.#options.platform ? { platform: this.#options.platform } : {}),
    });
  }
}

export async function discoverCodexExecutable(options: CodexRuntimeOptions = {}): Promise<string | undefined> {
  return discoverProductExecutable('codex', 'REPRISE_CODEX_EXECUTABLE', options);
}

function readCodexModel(value: unknown): CodexModel | undefined {
  const model = record(value);
  const id = text(model.id);
  const name = text(model.model);
  if (!id || !name) return undefined;
  return { id, model: name, supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter((item): item is string => typeof item === 'string') : [] };
}
