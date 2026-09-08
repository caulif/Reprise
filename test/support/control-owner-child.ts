import { activityControlReady, finishExperimentActivity, registerActivity, type ActivityKind } from "../../src/application/experiment-activity.js";

const dataDir = process.argv[2];
const kind = process.argv[3] as ActivityKind;
const experimentId = process.argv[4] ?? "experiment-ipc";
const runId = process.argv[5] ?? "run-ipc";
if (!dataDir || !kind) {
  process.stderr.write("usage: control-owner-child <dataDir> <prepare|run|compare> [experimentId] [runId]\n");
  process.exit(2);
}

const keepAlive = setInterval(() => undefined, 60_000);
let release: () => void = () => undefined;
const done = new Promise<void>((resolve) => {
  release = resolve;
});
const activity = registerActivity({
  kind,
  experimentId,
  runId,
  dataDir,
  cancel: async () => {
    release();
  },
});
await activityControlReady(activity);
process.stdout.write(`${JSON.stringify({ operationId: activity.operationId, experimentId, runId, kind })}\n`);
await done;
clearInterval(keepAlive);
finishExperimentActivity(experimentId);
await activityControlReady(activity);
process.stdout.write("cancelled\n");
