import type {
  AvailableRuntime,
  PreparedRuntimeEnvironment,
  ProductRuntime,
  RecoveryRuntimeCapabilities,
  ResolvedRuntime,
  RuntimeAvailability,
  RuntimeModelOffer,
  RuntimeRequest,
  TargetEventSink,
  TargetRunner,
} from '../../../core/runtime.js';
import type { CandidateLaunchContext } from '../../../core/schema.js';
import type { ProcessEnvironmentRole } from '../../../infrastructure/process/environment.js';
import { candidateExecutionPlan } from '../execution-plan.js';
import {
  assertIsolatedLaunchWorkspace,
  availableFromInspect,
  discoverProductExecutable,
  inspectRuntimeAvailability,
  LOCAL_SESSION_RECOVERY_CAPABILITIES,
} from '../runtime-host.js';
import { AcpUnavailableError } from './client.js';
import { AcpTargetRunner } from './runner.js';

export type AcpProductConfig = {
  productId: string;
  displayName: string;
  /** Executable name resolved on PATH. */
  command: string;
  /** Environment variable that overrides executable discovery. */
  executableEnvKey: string;
  /** Argv that starts an ACP agent on stdio. */
  acpArgs: readonly string[];
  installHint: string;
  envRole: ProcessEnvironmentRole;
};

export type AcpRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  /** Overrides the CLI argv. Only a protocol-level test has a reason to set this. */
  args?: readonly string[];
};

/** Product runtime shared by every CLI that speaks ACP over stdio. */
export class AcpProductRuntime implements ProductRuntime {
  readonly id: string;
  readonly #config: AcpProductConfig;
  readonly #options: AcpRuntimeOptions;

  constructor(config: AcpProductConfig, options: AcpRuntimeOptions = {}) {
    this.id = config.productId;
    this.#config = config;
    this.#options = options;
  }

  executionIsolation() {
    return { hostPrivateReads: 'unrestricted' as const, mechanism: 'workspace_copy_without_read_sandbox' };
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return availableFromInspect(await this.inspectAvailability());
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    return inspectRuntimeAvailability({
      productId: this.#config.productId,
      executable: await this.#discoverExecutable(),
      ...(this.#options.version ? { observedVersion: this.#options.version } : {}),
      installHint: this.#config.installHint,
    });
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== this.#config.productId) {
      throw new Error(`Runtime ${request.productId} is unavailable in ${this.#config.displayName} mode.`);
    }
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new AcpUnavailableError(this.#config.installHint);
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  /**
   * ACP defines no model-listing method. Agents do report a model on `session/new`, but each does so in a different
   * shape (config option, model block, encoded variant), so the catalog stays empty rather than normalized by guess.
   */
  listCatalog(): Promise<readonly RuntimeModelOffer[]> {
    return Promise.resolve([]);
  }

  /** Without a catalog there is nothing to cross-check; the agent resolves the model itself. */
  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    return this.resolve(request);
  }

  recoveryCapabilities(): RecoveryRuntimeCapabilities {
    // These agents expose no history API, so recovery can neither read a session back nor enumerate artifacts.
    return { ...LOCAL_SESSION_RECOVERY_CAPABILITIES, sessionHistory: 'unavailable', localArtifacts: false };
  }

  async prepareExecution(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, launch: CandidateLaunchContext) {
    if ((this.#options.args ?? this.#config.acpArgs).some((arg) => arg.includes('\0'))) throw new Error('Invalid Runtime argv.');
    const plan = candidateExecutionPlan(
      this.#config.envRole,
      environment.root,
      'unknown',
      this.#options.env,
      launch.executionRequirements,
      Boolean(this.#options.args),
    );
    const options = { ...this.#options, ...(this.#options.args ? { args: [...this.#options.args] } : {}) };
    const frozen = new AcpProductRuntime(this.#config, options);
    const snapshot = { runtime: { ...runtime }, environment: { ...environment }, launch: structuredClone(launch) };
    return {
      record: plan.record,
      createRunner: (sink: TargetEventSink) => frozen.#createRunner(snapshot.runtime, snapshot.environment, sink, snapshot.launch, plan),
    };
  }

  async createRunner(
    runtime: ResolvedRuntime,
    environment: PreparedRuntimeEnvironment,
    sink: TargetEventSink,
    launch: CandidateLaunchContext,
  ): Promise<TargetRunner> {
    return (await this.prepareExecution(runtime, environment, launch)).createRunner(sink);
  }

  async #createRunner(
    runtime: ResolvedRuntime,
    environment: PreparedRuntimeEnvironment,
    sink: TargetEventSink,
    launch: CandidateLaunchContext,
    plan: ReturnType<typeof candidateExecutionPlan>,
  ): Promise<TargetRunner> {
    const { displayName } = this.#config;
    assertIsolatedLaunchWorkspace({
      runtime,
      environment,
      launch,
      expectedProductId: this.#config.productId,
      wrongProduct: `Only ${displayName} runtimes can create an ACP runner.`,
      relativeRoot: `${displayName} requires an absolute isolated workspace path.`,
      mismatch: 'Runner workspace must match CandidateLaunchContext.workspaceRoot.',
      fail: (message) => new AcpUnavailableError(message),
    });
    return new AcpTargetRunner({
      displayName,
      runtime,
      environment,
      sink,
      completeEnv: plan.environment,
      temporaryDirectory: plan.temporaryDirectory,
      args: this.#options.args ?? [...this.#config.acpArgs],
    });
  }

  #discoverExecutable(): Promise<string | undefined> {
    return discoverProductExecutable(this.#config.command, this.#config.executableEnvKey, this.#options);
  }
}
