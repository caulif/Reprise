import { SAFE_ID } from '../core/identity.js';
import type { RuntimeModelOffer } from '../core/runtime.js';
import type { CandidateSpec } from '../core/schema.js';

export function candidateSpecFromOffer(productId: string, offer: RuntimeModelOffer): CandidateSpec {
  return {
    candidateId: candidateIdFor(productId, offer.value),
    productId,
    requestedModel: offer.value,
  };
}

export function catalogCursor(offers: readonly RuntimeModelOffer[], requested?: string): number {
  if (!requested) return 0;
  const index = offers.findIndex((offer) => offer.value === requested || offer.resolvedModel === requested);
  return index >= 0 ? index : 0;
}

function candidateIdFor(productId: string, value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'model';
  const id = `${productId}-${slug}`.slice(0, 128);
  return SAFE_ID.test(id) ? id : `${productId}-model`.slice(0, 128);
}
