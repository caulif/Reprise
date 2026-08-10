import type { CandidateRunState } from './schema.js';

const transitions: Record<CandidateRunState, readonly CandidateRunState[]> = {
  created: ['preparing', 'finalizing'],
  preparing: ['launching', 'finalizing'],
  launching: ['awaiting_target', 'finalizing'],
  awaiting_target: ['awaiting_controller', 'finalizing'],
  awaiting_controller: ['awaiting_target', 'finalizing'],
  finalizing: ['finished'],
  finished: [],
};

export function canTransition(from: CandidateRunState, to: CandidateRunState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: CandidateRunState, to: CandidateRunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid CandidateRun transition: ${from} -> ${to}.`);
  }
}
