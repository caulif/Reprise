import { setTimeout as delay } from "node:timers/promises";

export type RecoveryCandidateRecipe = {
  candidateId: string;
  hypothesisId: string;
  operations: readonly unknown[];
  /** Fingerprint of the checkpoint/source tree this recipe is applied to. */
  baseDigest?: string;
};

export type RecoveryCandidateMaterialization<T> = {
  create: (candidate: { candidateId: string; hypothesisId: string }) => Promise<T>;
  onRetry?: (input: { candidateId: string; attempt: number; reasonCode: RecoveryCandidateRetryCode }) => Promise<void>;
  seenRecipeDigests?: Set<string>;
};

export type RecoveryCandidateRetryCode = "EBUSY" | "EPERM" | "EMFILE" | "EAGAIN";

const RETRYABLE_CODES = new Set<RecoveryCandidateRetryCode>(["EBUSY", "EPERM", "EMFILE", "EAGAIN"]);

/** Serializes large-tree materialization and retries only known transient Windows filesystem locks once. */
export async function materializeRecoveryCandidates<T>(
  recipes: readonly RecoveryCandidateRecipe[],
  input: RecoveryCandidateMaterialization<T>,
): Promise<T[]> {
  const seen = input.seenRecipeDigests ?? new Set<string>();
  const materialized: T[] = [];
  for (const recipe of recipes) {
    const digest = JSON.stringify({ baseDigest: recipe.baseDigest ?? null, operations: recipe.operations });
    if (seen.has(digest)) continue;
    seen.add(digest);
    materialized.push(await createWithBoundedRetry(recipe, input));
  }
  return materialized;
}

async function createWithBoundedRetry<T>(
  recipe: RecoveryCandidateRecipe,
  input: RecoveryCandidateMaterialization<T>,
): Promise<T> {
  try {
    return await input.create(recipe);
  } catch (error) {
    const reasonCode = retryableCode(error);
    if (!reasonCode) throw error;
    await input.onRetry?.({ candidateId: recipe.candidateId, attempt: 2, reasonCode });
    await delay(100);
    return input.create(recipe);
  }
}

function retryableCode(error: unknown): RecoveryCandidateRetryCode | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && RETRYABLE_CODES.has(code as RecoveryCandidateRetryCode)) return code as RecoveryCandidateRetryCode;
      current = (current as { cause?: unknown }).cause;
    } else break;
  }
  return undefined;
}
