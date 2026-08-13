import { EXPERIMENT_APPLICATION_EFFORT, EXPERIMENT_APPLICATION_MODEL } from '../src/products/codex/text-caller.js';
import { runToollessCodexProbe } from './codex-real-runner.js';

const SMOKE_PROMPT = 'Reply with exactly REPRISE_CODEX_PROTOCOL_SMOKE_OK. Do not invoke tools or access files.';

async function main(): Promise<void> {
  if (process.env.REPRISE_RUN_CODEX_SMOKE !== '1') throw new Error('Set REPRISE_RUN_CODEX_SMOKE=1 to run the real Codex protocol smoke.');
  const output = await runToollessCodexProbe({
    model: EXPERIMENT_APPLICATION_MODEL,
    effort: EXPERIMENT_APPLICATION_EFFORT,
    systemPrompt: 'You are a bounded Reprise app-server protocol smoke. Follow the user text exactly.',
    context: { prompt: SMOKE_PROMPT },
  });
  if (output.trim() !== 'REPRISE_CODEX_PROTOCOL_SMOKE_OK') throw new Error(`Unexpected Codex protocol smoke response: ${JSON.stringify(output)}.`);
  console.log(JSON.stringify({ model: EXPERIMENT_APPLICATION_MODEL, effort: EXPERIMENT_APPLICATION_EFFORT, status: 'passed' }));
}

main().catch((error: unknown) => {
  console.error(`Real Codex protocol smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
