import { isAbsolute } from 'node:path';
import type {
  AvailableRuntime,
  PreparedRuntimeEnvironment,
  RecoveryRuntimeCapabilities,
  ResolvedRuntime,
  RuntimeAvailability,
} from '../../core/runtime.js';
import type { CandidateLaunchContext } from '../../core/schema.js';
import { discoverExecutable, type ExecutableDiscovery } from '../../infrastructure/process/spawn.js';

export const LOCAL_SESSION_RECOVERY_CAPABILITIES: RecoveryRuntimeCapabilities = {
  sessionHistory: 'available',
  localArtifacts: true,
  workspaceHistory: false,
  externalSideEffects: 'unobserved',
};

const CATALOG_TTL_MS = 10 * 60_000;

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #items = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs: number = CATALOG_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const item = this.#items.get(key);
    if (!item || item.expiresAt <= Date.now()) return undefined;
    return item.value;
  }

  set(key: string, value: T): void {
    this.#items.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  clear(): void {
    this.#items.clear();
  }
}

export function availableFromInspect(items: readonly RuntimeAvailability[]): AvailableRuntime[] {
  return items
    .filter((item): item is RuntimeAvailability & { executable: string } => item.status === 'available' && Boolean(item.executable))
    .map((item) => ({
      productId: item.productId,
      executable: item.executable,
      ...(item.observedVersion ? { version: item.observedVersion } : {}),
    }));
}

export function inspectRuntimeAvailability(input: {
  productId: string;
  executable: string | undefined;
  observedVersion?: string;
  installHint: string;
}): RuntimeAvailability[] {
  const observedAt = new Date().toISOString();
  if (!input.executable) {
    return [{
      productId: input.productId,
      status: 'not_installed',
      observedAt,
      installHint: input.installHint,
    }];
  }
  return [{
    productId: input.productId,
    executable: input.executable,
    status: 'available',
    observedAt,
    ...(input.observedVersion ? { observedVersion: input.observedVersion } : {}),
  }];
}

export function assertIsolatedLaunchWorkspace(input: {
  runtime: ResolvedRuntime;
  environment: PreparedRuntimeEnvironment;
  launch: CandidateLaunchContext;
  expectedProductId: string;
  wrongProduct: string;
  relativeRoot: string;
  mismatch: string;
  fail: (message: string) => Error;
}): void {
  if (input.runtime.productId !== input.expectedProductId) throw input.fail(input.wrongProduct);
  if (!isAbsolute(input.environment.root)) throw input.fail(input.relativeRoot);
  if (input.launch.workspaceRoot !== input.environment.root) throw input.fail(input.mismatch);
}

export function discoverProductExecutable(
  command: string,
  envKey: string,
  options: Pick<ExecutableDiscovery, 'executable' | 'env' | 'cwd' | 'platform' | 'pathExt'> = {},
): Promise<string | undefined> {
  return discoverExecutable({
    command,
    envKey,
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.pathExt ? { pathExt: options.pathExt } : {}),
  });
}
