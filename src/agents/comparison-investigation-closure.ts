import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { FreeformInvocation } from '../infrastructure/agent/host.js';

export async function closeBoundedInvestigation(options: ComparisonCompareOptions, outcome: FreeformInvocation,
  resources: ComparisonResourceTracker, signal: AbortSignal): Promise<FreeformInvocation> {
  if (outcome.status !== 'yielded' || outcome.reason !== 'bounded_investigation_timeout'
    || !options.closeBoundedInvestigation || options.findingsReady?.()) return outcome;
  resources.checkHard('Host investigation closure');
  if (signal.aborted) return { status: 'cancelled', sessionId: outcome.sessionId };
  if (options.hasSavedFindings?.() === false) return outcome;
  try {
    await options.closeBoundedInvestigation({ sessionId: outcome.sessionId, reason: 'bounded_investigation_timeout' }, signal);
  } catch {
    if (signal.aborted) return { status: 'cancelled', sessionId: outcome.sessionId };
    resources.checkHard('failed Host investigation closure');
    return { status: 'failed', sessionId: outcome.sessionId, failure: { code: 'draft_invalid', kind: 'tool', attempts: 0,
      message: 'Host investigation closure could not validate, persist or audit the saved findings. No composition or publication is permitted.' } };
  }
  resources.checkHard('after Host investigation closure');
  if (signal.aborted) return { status: 'cancelled', sessionId: outcome.sessionId };
  if (!options.findingsReady?.()) return { status: 'failed', sessionId: outcome.sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: 0,
    message: 'Host investigation closure did not produce current ready findings. No model-generated replacement is attempted for this deadline.' } };
  return outcome;
}
