import { once } from 'node:events';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const [root, experimentId, runId] = process.argv.slice(2);
if (!root || !experimentId || !runId || !process.send) throw new Error('Startup child requires root, owner IDs and IPC.');
await once(process, 'message');
const runtime = new VerifiedRuntime();
runtime.validateCandidate = async request => {
  const released = once(process, 'message');
  process.send!({ status: 'owned', experimentId, runId });
  await released;
  return runtime.resolve(request);
};
try {
  const handle = startExperiment({ ...input(root, runtime), experimentId, runId, compare: false });
  const result = await handle.result;
  process.send({ status: 'finished', experimentId, runId, termination: result.record.outcome.termination.code });
} catch (error) {
  process.send({ status: 'rejected', experimentId, runId, message: error instanceof Error ? error.message : String(error) });
}
process.disconnect();
